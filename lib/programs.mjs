// lib/programs.mjs: the installed-programs list and the safe reading of an entry's own uninstall command.
// Pure and read-only: it starts no process (regQuery is injected) and changes nothing.
//
// A program row never carries its command to a renderer: the controller keeps { id -> entry } and the renderer only
// ever sends the opaque id back. parseUninstallCommand is the ONLY place a command string is turned into an exe + arguments.
import { createHash } from "node:crypto";
import path from "node:path";

const HIVES = ["uninstallHKLM", "uninstallWow", "uninstallHKCU"];
const MAX_CMD = 2000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// reg.exe prints bytes >= 0x80, "?" and unexpanded %VARS%: such text cannot be trusted to be exact.
const LOSSY = /[\x00-\x08\x0a-\x1f\x7f-\xff?%]/;
const GUID = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;
const DRIVE_ABS = /^[A-Za-z]:\\[^<>"|*]+$/;

const val = (key, name) => {
  const v = key && key.values ? key.values[name] : undefined;
  return v && typeof v.data === "string" ? v : null;
};
const text = (key, name) => { const v = val(key, name); return v ? v.data.trim() : ""; };

/** { ok, programs, notes } sorted by name. Hidden: system components, updates/child entries, nameless entries. */
export async function listPrograms(regQuery) {
  const programs = [];
  const notes = [];
  const seen = new Set();
  let ok = true;
  for (const hive of HIVES) {
    let r;
    try { r = await regQuery(hive); } catch { r = null; }
    if (!r || !r.ok || !Array.isArray(r.keys)) { ok = false; notes.push("the program list " + hive + " could not be read"); continue; }
    for (const key of r.keys) {
      const name = text(key, "DisplayName");
      if (!name) continue;
      const sys = val(key, "SystemComponent");
      if (sys && /^(0x0*1|1)$/.test(sys.data.trim())) continue;
      if (text(key, "ParentKeyName") || text(key, "ParentDisplayName")) continue;
      const kp = String(key.path);
      const lk = kp.toLowerCase();
      if (seen.has(lk)) continue;
      seen.add(lk);
      const sizeKb = /^0x[0-9a-f]+$/i.test(text(key, "EstimatedSize")) ? parseInt(text(key, "EstimatedSize"), 16) : null;
      const cmd = text(key, "UninstallString");
      programs.push(Object.freeze({
        id: createHash("sha1").update("program:" + lk).digest("hex").slice(0, 16),
        name,
        publisher: text(key, "Publisher"),
        version: text(key, "DisplayVersion"),
        sizeKb: Number.isFinite(sizeKb) ? sizeKb : null,
        installLocation: text(key, "InstallLocation"),
        displayIcon: text(key, "DisplayIcon"),
        uninstallCommand: cmd,
        hive: hive === "uninstallHKCU" ? "user" : "machine",
        lossy: ["DisplayName", "UninstallString", "InstallLocation"].some(n => { const v = val(key, n); return v && (v.lossy === true || LOSSY.test(v.data)); }),
      }));
    }
  }
  programs.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return { ok, programs, notes };
}

/**
 * Turn an UninstallString into what may be run, or null (fail closed).
 *   { exe, args, verbatim }  exe: absolute local path to a .exe; args: the rest of the command line, passed unchanged.
 * MsiExec entries (/I{GUID} or /X{GUID}) become the fixed System32 msiexec.exe with /X{GUID} only.
 * Refused: control characters, over-long text, unexpanded %variables%, network paths, anything that is not a drive-absolute .exe.
 */
export function parseUninstallCommand(cmd) {
  if (typeof cmd !== "string") return null;
  const s = cmd.trim();
  if (!s || s.length > MAX_CMD || CONTROL.test(s) || s.includes("%")) return null;
  let exe;
  let rest;
  if (s[0] === '"') {
    const close = s.indexOf('"', 1);
    if (close < 2) return null;
    exe = s.slice(1, close);
    rest = s.slice(close + 1);
    if (rest && !/^\s/.test(rest)) return null;
  } else {
    const m = /^(.*?\.exe)(?=\s|$)/i.exec(s);
    if (!m) return null;
    exe = m[1];
    rest = s.slice(m[1].length);
  }
  rest = rest.trim();
  const isMsi = (!exe.includes("\\") && exe.toLowerCase() === "msiexec.exe") || /^[A-Za-z]:\\windows\\system32\\msiexec\.exe$/i.test(exe);
  if (isMsi) {
    const g = /^\/[IiXx]\s*(\{[^{}]+\})$/.exec(rest);
    if (!g || !GUID.test(g[1])) return null;
    return { exe: "C:\\Windows\\System32\\msiexec.exe", args: "/X" + g[1].toUpperCase(), verbatim: true };
  }
  if (!DRIVE_ABS.test(exe) || exe.includes("/") || /(^|\\)\.\.?(\\|$)/.test(exe) || !/\.exe$/i.test(exe)) return null;
  return { exe, args: rest, verbatim: true };
}

/** The folder whose leftovers should be looked for after uninstalling: InstallLocation, else the folder of the icon / uninstaller. */
export function leftoverTarget(p) {
  const dirOf = f => (typeof f === "string" && DRIVE_ABS.test(f) ? path.win32.dirname(f) : "");
  const icon = String(p.displayIcon || "").replace(/,\s*-?\d+$/, "").replace(/^"|"$/g, "");
  const parsed = parseUninstallCommand(p.uninstallCommand);
  return (DRIVE_ABS.test(p.installLocation || "") ? p.installLocation.replace(/\\+$/, "") : "") || dirOf(icon) || (parsed ? dirOf(parsed.exe) : "");
}

/** What the renderer may see. Never the command or paths. */
export function programRow(p) {
  return { id: p.id, name: p.name, publisher: p.publisher, version: p.version, sizeKb: p.sizeKb, scope: p.hive, canUninstall: !p.lossy && parseUninstallCommand(p.uninstallCommand) !== null };
}
