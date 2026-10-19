// lib/app-folder.mjs: "does this picked folder belong to one installed program?", "does Windows need a restart to finish
// removing it?" and the merge of two leftover scans. Pure: no process is started, no file is read or changed.
// The registry readings come in as plain data (listPrograms rows, a regQuery result).
//
// Detection is strict and fails closed. A program is "the app of this folder" ONLY when, by exact canonical path comparison
// (drive-absolute, no "..", no lossy characters, case-insensitive, trailing separators ignored):
//   - its InstallLocation equals the folder, or
//   - the folder equals or contains the folder of its DisplayIcon file, or
//   - the folder equals or contains the folder of its uninstaller program (a parsed, runnable command).
// Never by name. "C:\Foo" does not match "C:\FooBar"; a child folder of the install folder does not match. Nothing under the
// Windows folder is ever used as evidence, and a drive root is never a match.
import { parseUninstallCommand } from "./programs.mjs";

export const EXIT_REBOOT_REQUIRED = 3010;  // ERROR_SUCCESS_REBOOT_REQUIRED
export const EXIT_REBOOT_INITIATED = 1641; // ERROR_SUCCESS_REBOOT_INITIATED: Windows may restart by itself

const WINDOWS_DIR = "c:\\windows"; // fixed text, never read from the environment
const BAD_CHARS = /[\x00-\x1f\x7f-\xff?%*<>"|/]/;

/** Canonical comparison form of a drive-absolute folder or file path, or null (fail closed). Never a drive root. */
export function canonPath(p) {
  if (typeof p !== "string" || p.length < 4 || p.length > 1000 || BAD_CHARS.test(p)) return null;
  if (!/^[A-Za-z]:\\/.test(p)) return null;
  const s = p.replace(/\\+$/, "");
  if (/^[A-Za-z]:$/.test(s)) return null;
  const segs = s.split("\\");
  if (segs.slice(1).some(g => g === "" || g === "." || g === ".." || /[. ]$/.test(g))) return null;
  return s.toLowerCase();
}
const isOrInside = (child, parent) => child === parent || child.startsWith(parent + "\\");
const inWindowsDir = c => isOrInside(c, WINDOWS_DIR);
const dirOfFile = f => {
  const c = canonPath(f);
  if (!c) return null;
  const d = c.slice(0, c.lastIndexOf("\\"));
  return /^[a-z]:$/.test(d) ? null : d;
};
const iconFile = s => {
  let t = String(s || "").trim().replace(/,\s*-?\d+$/, "").trim();
  if (t.length >= 2 && t[0] === '"' && t.endsWith('"')) t = t.slice(1, -1);
  return t.trim();
};

// Why this program belongs to folder `f` (canonical), or "" when it does not.
function matchWhy(p, f) {
  const loc = canonPath(String(p.installLocation || ""));
  if (loc && loc === f) return "install location";
  const iconDir = dirOfFile(iconFile(p.displayIcon));
  if (iconDir && !inWindowsDir(iconDir) && isOrInside(iconDir, f)) return "icon folder";
  const parsed = parseUninstallCommand(p.uninstallCommand);
  // An MsiExec entry becomes the fixed System32 msiexec.exe: that folder says nothing about the program.
  const exeDir = parsed && !/^c:\\windows\\system32\\msiexec\.exe$/i.test(parsed.exe) ? dirOfFile(parsed.exe) : null;
  if (exeDir && !inWindowsDir(exeDir) && isOrInside(exeDir, f)) return "uninstaller folder";
  return "";
}

/**
 * programs: the rows of listPrograms (name, installLocation, displayIcon, uninstallCommand, lossy).
 * Returns one of
 *   { kind: "none" }
 *   { kind: "several", programs }                       (two or more different programs match: never guessed)
 *   { kind: "one", program, runnable: true, command }   (command = parseUninstallCommand result)
 *   { kind: "one", program, runnable: false, reason: "lossy" | "unparsable" }
 */
export function detectAppForFolder(programs, folder) {
  const f = canonPath(folder);
  if (!f || inWindowsDir(f)) return { kind: "none" };
  const hits = [];
  const seen = new Set();
  for (const p of Array.isArray(programs) ? programs : []) {
    if (!p || typeof p.name !== "string" || p.name === "") continue;
    if (!matchWhy(p, f)) continue;
    // The same program registered twice (for example in two registry views) is one program.
    const k = [p.name, p.uninstallCommand, p.installLocation].map(x => String(x || "").toLowerCase()).join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    hits.push(p);
  }
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "several", programs: hits };
  const program = hits[0];
  if (program.lossy === true) return { kind: "one", program, runnable: false, reason: "lossy" };
  const command = parseUninstallCommand(program.uninstallCommand);
  if (!command) return { kind: "one", program, runnable: false, reason: "unparsable" };
  return { kind: "one", program, runnable: true, command };
}

/**
 * Does the (read-only) PendingFileRenameOperations value mention a path at or inside one of `folders`?
 * regResult: the result of regQuery("pendingRenames"). An unreadable answer is "no" (the exit code is the other evidence).
 */
export function pendingRenameHit(regResult, folders) {
  if (!regResult || regResult.ok !== true || !Array.isArray(regResult.keys)) return false;
  const roots = (Array.isArray(folders) ? folders : []).map(canonPath).filter(Boolean);
  if (roots.length === 0) return false;
  for (const key of regResult.keys) {
    for (const [name, v] of Object.entries(key && key.values ? key.values : {})) {
      if (name.toLowerCase() !== "pendingfilerenameoperations" || !v || typeof v.data !== "string") continue;
      // reg.exe prints a REG_MULTI_SZ with a literal \0 between the strings; each string is "\??\C:\path" or "!\??\C:\path".
      for (const raw of v.data.split("\\0")) {
        const t = canonPath(raw.trim().replace(/^!/, "").replace(/^\\\?\?\\/, ""));
        if (t && roots.some(r => isOrInside(t, r))) return true;
      }
    }
  }
  return false;
}

/** { needed, initiated }: needed when the exit code is 3010 or 1641, or Windows has a pending rename inside the folders. */
export function rebootAssessment({ code, pending, folders }) {
  const initiated = code === EXIT_REBOOT_INITIATED;
  const needed = initiated || code === EXIT_REBOOT_REQUIRED || pendingRenameHit(pending, folders);
  return { needed, initiated };
}

/** Two investigate results of the same kind merged (items de-duplicated by id). The first result's target is kept. */
export function mergeInvestigations(a, b) {
  const items = [];
  const ids = new Set();
  for (const it of [...a.items, ...b.items]) {
    if (!it || ids.has(it.id)) continue;
    ids.add(it.id);
    items.push(it);
  }
  const union = (x, y) => [...new Set([...(Array.isArray(x) ? x : []), ...(Array.isArray(y) ? y : [])])];
  return {
    ...a,
    items,
    allowedRoots: union(a.allowedRoots, b.allowedRoots),
    protectedPaths: union(a.protectedPaths, b.protectedPaths),
    notes: union(a.notes, b.notes),
    partial: a.partial === true || b.partial === true,
  };
}
