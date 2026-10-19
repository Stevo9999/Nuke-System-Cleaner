// Startup items: report-only findings from the Run/RunOnce registry keys and
// the two Startup folders. Nothing here is selectable or deletable.
//
// NOTE: the returned findings are PLAIN OBJECTS shaped like Finding. At
// integration time Task 6's makeFinding wraps them (idKey = source + ":" + name);
// this module deliberately does not import Task 6. The id built here follows
// the same shared rule: sha1(kind + ":" + key.toLowerCase()).slice(0, 16).
//
// The returned array also carries a non-enumerable `notes` string array that
// reports anything that was skipped or truncated (never silent).
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

const RUN_SOURCES = [
  ["runHKCU", "HKCU Run"],
  ["runOnceHKCU", "HKCU RunOnce"],
  ["runHKLM", "HKLM Run"],
  ["runOnceHKLM", "HKLM RunOnce"],
  ["runWow", "HKLM Run (32-bit)"],
];
const STARTUP_SUB = ["Microsoft", "Windows", "Start Menu", "Programs"];
const MAX_LABEL = 260;
const MAX_REASON = 1200;
const MAX_FOLDER_FILES = 2000;
const MAX_NOTES = 50;

function idFor(kind, key) {
  return createHash("sha1").update(kind + ":" + key.toLowerCase()).digest("hex").slice(0, 16);
}

function finding(source, name, filePath, reason) {
  return {
    id: idFor("startup", source + ":" + name),
    kind: "startup",
    path: filePath,
    label: String(name).slice(0, MAX_LABEL),
    bytes: null,
    group: "report-only",
    sharedWith: [],
    confidence: null,
    preTicked: false,
    selectable: false,
    reason: String(reason).slice(0, MAX_REASON),
    category: "startup",
  };
}

// readLnk(file) may return a string, or { target, args }.
async function lnkCommand(readLnk, file) {
  if (typeof readLnk !== "function") return null;
  try {
    const r = await readLnk(file);
    const target = typeof r === "string" ? r : r && typeof r.target === "string" ? r.target : null;
    if (!target) return null;
    const args = r && typeof r === "object" && typeof r.args === "string" && r.args ? " " + r.args : "";
    return target + args;
  } catch {
    return null;
  }
}

async function folderItems(dir, source, readLnk, fsOps, notes) {
  const out = [];
  let names;
  try { names = await fsOps.readdir(dir); } catch { return out; }
  if (names.length > MAX_FOLDER_FILES) {
    notes.push(source + ": list truncated, only the first " + MAX_FOLDER_FILES + " of " + names.length + " files shown");
  }
  for (const name of names.slice(0, MAX_FOLDER_FILES)) {
    if (name.toLowerCase() === "desktop.ini") continue;
    const full = path.join(dir, name);
    let st;
    try { st = await fsOps.lstat(full); } catch { continue; }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    const cmd = name.toLowerCase().endsWith(".lnk") ? await lnkCommand(readLnk, full) : null;
    out.push(finding(source, name, full, source + ": " + (cmd ?? full)));
  }
  return out;
}

export async function listStartupItems({ regQuery, env = process.env, readLnk = null, fsOps = { lstat, readdir } } = {}) {
  const items = [];
  const notes = [];
  for (const [keyName, source] of RUN_SOURCES) {
    let r;
    try { r = await regQuery(keyName); } catch { r = null; }
    if (!r || !r.ok || !Array.isArray(r.keys)) {
      notes.push(source + ": could not be read");
      continue;
    }
    if (r.partial) notes.push(source + ": some registry output could not be read (" + (r.notes || []).join("; ") + ")");
    for (const key of r.keys) {
      for (const [name, v] of Object.entries(key.values || {})) {
        if (name === "(Default)" && v.data === "(value not set)") continue;
        const note = v.lossy ? " (some characters could not be read exactly)" : "";
        items.push(finding(source, name, null, source + ": " + v.data + note));
      }
    }
  }
  const dirs = [
    [env.APPDATA, "Startup folder (this user)", "Startup"],
    [env.ProgramData, "Startup folder (all users)", "StartUp"],
  ];
  for (const [base, source, leaf] of dirs) {
    if (typeof base !== "string" || !base) continue;
    items.push(...(await folderItems(path.join(base, ...STARTUP_SUB, leaf), source, readLnk, fsOps, notes)));
  }
  Object.defineProperty(items, "notes", { value: notes.slice(0, MAX_NOTES), enumerable: false });
  return items;
}
