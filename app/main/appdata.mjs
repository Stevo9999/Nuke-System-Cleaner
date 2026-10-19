// app/main/appdata.mjs
// Per-user data folder (%LOCALAPPDATA%\Nuke-Uninstaller), settings, and the app's protected-path list.
// No process spawns, no network. The environment is injected so tests never touch the real folders.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { dirArgProblem, canonicalForms, within, suspiciousPathForm } from "../../lib/safepath.mjs";
import { TOOL_PROTECTED } from "../../scan.mjs";

const FOLDER = "Nuke-Uninstaller";
const MAX_SETTINGS_BYTES = 64 * 1024;

export function appDataPaths(env = process.env) {
  const la = env && typeof env === "object" ? env.LOCALAPPDATA : undefined;
  if (typeof la !== "string" || la.length === 0) throw new Error("LOCALAPPDATA is missing");
  const problem = dirArgProblem(la);
  if (problem) throw new Error("LOCALAPPDATA is not usable: " + problem);
  const root = path.join(path.resolve(la), FOLDER);
  return {
    root,
    settingsFile: path.join(root, "settings.json"),
    runDir: path.join(root, "run"),
    // Unused since the restore outcome travels only as an exit code (no result file). Still created (empty) so older
    // installs and tests keep a stable layout; nothing reads or writes inside it.
    restoreDir: path.join(root, "restore"),
    electronDir: path.join(root, "electron"),
  };
}

function assertRealDir(dir) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error("app data folder is a link: " + dir);
  if (!st.isDirectory()) throw new Error("app data path is not a folder: " + dir);
}

export function ensureAppData(paths) {
  const { root } = paths;
  let existing = null;
  try { existing = fs.lstatSync(root); } catch (e) { if (!e || e.code !== "ENOENT") throw e; }
  if (existing) assertRealDir(root);
  for (const d of [root, paths.runDir, paths.restoreDir, paths.electronDir]) {
    fs.mkdirSync(d, { recursive: true });
    assertRealDir(d);
  }
}

// restorePoint: make a Windows restore point before deleting (default on). plainConfirm: show a simple 2D confirm page
// instead of the 3D room (default off, so the animation stays on). Old files with only restorePoint still load.
export const DEFAULT_SETTINGS = Object.freeze({ restorePoint: true, plainConfirm: false });

const isPlainObject = o => o !== null && typeof o === "object" && !Array.isArray(o) &&
  (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);

export function loadSettings(file) {
  const out = { ...DEFAULT_SETTINGS };
  try {
    if (typeof file !== "string" || file.length === 0) return out;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SETTINGS_BYTES) return out;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isPlainObject(data)) return out;
    if (Object.hasOwn(data, "restorePoint") && typeof data.restorePoint === "boolean") out.restorePoint = data.restorePoint;
    if (Object.hasOwn(data, "plainConfirm") && typeof data.plainConfirm === "boolean") out.plainConfirm = data.plainConfirm;
  } catch { /* missing or corrupt: defaults */ }
  return out;
}

export function saveSettings(file, s) {
  if (typeof file !== "string" || file.length === 0) throw new Error("bad settings path");
  if (!isPlainObject(s)) throw new Error("settings must be an object");
  const keys = Object.keys(s);
  const restorePoint = s.restorePoint, plainConfirm = s.plainConfirm; // read once
  if (keys.length !== 2 || !keys.includes("restorePoint") || !keys.includes("plainConfirm") || typeof restorePoint !== "boolean" || typeof plainConfirm !== "boolean")
    throw new Error("settings must be exactly { restorePoint: boolean, plainConfirm: boolean }");
  // The two switches never touch the "never touch these folders" list: whatever is stored there stays (an unreadable file
  // cannot be kept, so it is rewritten clean).
  const cur = readExclusions(file);
  const exclusions = cur.ok ? cur.list : [];
  writeSettingsFile(file, { restorePoint, plainConfirm, ...(exclusions.length > 0 ? { exclusions } : {}) });
}

function writeSettingsFile(file, obj) {
  const body = JSON.stringify(obj, null, 2) + "\n";
  const tmp = path.join(path.dirname(file), "." + path.basename(file) + "." + crypto.randomBytes(6).toString("hex") + ".tmp");
  try {
    fs.writeFileSync(tmp, body, { flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

// ---- Exclusions: folders this app must never touch (the user's own never-touch list). Stored in settings.json as "exclusions". ----
// Validation is strict and the same for every way in (the picker, the file on disk): a drive-letter path (no UNC or device
// form, no relative path), no ".." segment, no control characters or wildcard characters, not a drive root. The stored form is
// path.resolve()d (no trailing separator). Duplicates are compared case-insensitively. At most MAX_EXCLUSIONS entries.
export const MAX_EXCLUSIONS = 50;
const EXCL_CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");
const EXCL_BAD_CHAR = /[<>"|?*]/;
const EXCL_DRIVE = /^[A-Za-z]:[\\/]/;

export function cleanExclusion(raw) {
  try {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return null;
    if (EXCL_CONTROL.test(raw) || EXCL_BAD_CHAR.test(raw.slice(2)) || !EXCL_DRIVE.test(raw)) return null;
    if (suspiciousPathForm(raw) !== null) return null;
    const r = path.resolve(raw);
    if (path.parse(r).root === r) return null; // a whole drive
    return r;
  } catch { return null; }
}
export const exclusionKey = p => p.toLowerCase();
// Opaque id of one entry (the only thing a window ever sends back to remove it).
export const exclusionId = p => crypto.createHash("sha1").update("excl:" + exclusionKey(p)).digest("hex").slice(0, 16);

// Sanitises a list read from disk: bad entries are dropped, duplicates removed, cut at MAX_EXCLUSIONS.
function cleanExclusionList(raw) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(raw) ? raw : []) {
    const c = cleanExclusion(v);
    if (c === null || seen.has(exclusionKey(c))) continue;
    seen.add(exclusionKey(c));
    out.push(c);
    if (out.length >= MAX_EXCLUSIONS) break;
  }
  return out;
}

// { ok, list }. A missing file or a file without the key is an empty list (ok). A file that exists but cannot be read, is too
// big, is not a plain object, or holds a non-array "exclusions" is NOT ok: the caller must fail closed (the list is unknown).
export function readExclusions(file) {
  try {
    if (typeof file !== "string" || file.length === 0) return { ok: false, list: [] };
    let st;
    try { st = fs.statSync(file); } catch (e) { return e && e.code === "ENOENT" ? { ok: true, list: [] } : { ok: false, list: [] }; }
    if (!st.isFile() || st.size > MAX_SETTINGS_BYTES) return { ok: false, list: [] };
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isPlainObject(data)) return { ok: false, list: [] };
    if (!Object.hasOwn(data, "exclusions")) return { ok: true, list: [] };
    if (!Array.isArray(data.exclusions)) return { ok: false, list: [] };
    return { ok: true, list: cleanExclusionList(data.exclusions) };
  } catch { return { ok: false, list: [] }; }
}
export const loadExclusions = file => readExclusions(file).list;

// Pure: the list with `raw` added, or why not ("invalid" | "duplicate" | "full").
export function addExclusion(list, raw) {
  const c = cleanExclusion(raw);
  if (c === null) return { ok: false, reason: "invalid" };
  const cur = cleanExclusionList(list);
  if (cur.some(x => exclusionKey(x) === exclusionKey(c))) return { ok: false, reason: "duplicate" };
  if (cur.length >= MAX_EXCLUSIONS) return { ok: false, reason: "full" };
  return { ok: true, list: [...cur, c] };
}

// Writes the list next to the two switches (kept as they are on disk, defaults if the file cannot be read). Throws on a bad list.
export function saveExclusions(file, list) {
  if (typeof file !== "string" || file.length === 0) throw new Error("bad settings path");
  if (!Array.isArray(list) || list.length > MAX_EXCLUSIONS) throw new Error("bad exclusions list");
  const seen = new Set();
  for (const v of list) {
    const c = cleanExclusion(v);
    if (c === null || c !== v || seen.has(exclusionKey(c))) throw new Error("bad exclusions entry");
    seen.add(exclusionKey(c));
  }
  const s = loadSettings(file);
  writeSettingsFile(file, { restorePoint: s.restorePoint, plainConfirm: s.plainConfirm, ...(list.length > 0 ? { exclusions: [...list] } : {}) });
}

// True if `p` is an excluded folder, lies inside one, or contains one (deleting it would delete the excluded folder).
// `deep` also compares the canonical forms (junctions, 8.3 names): used at delete time on the few chosen items. The scan-view
// filter uses the lexical form only (it can see hundreds of thousands of items); the scan itself already checked canonically.
// Fails closed: a path that cannot be handled counts as touching.
export function exclusionMatcher(list, { deep = false } = {}) {
  let theirs;
  try { theirs = Array.isArray(list) ? list.flatMap(x => canonicalForms(x)) : []; } catch { return () => true; } // few entries: both forms
  if (theirs.length === 0) return () => false;
  return p => {
    try {
      if (typeof p !== "string" || p.length === 0) return false;
      const mine = deep ? canonicalForms(p) : [path.resolve(p)];
      return mine.some(m => theirs.some(t => within(m, t) || within(t, m)));
    } catch { return true; }
  };
}
export const touchesExclusion = (p, list, opts) => exclusionMatcher(list, opts)(p);

const USER_FOLDERS = ["Desktop", "Documents", "Pictures", "Music", "Videos", "Downloads", "OneDrive"];
const okAbs = v => typeof v === "string" && v.length > 0 && !v.includes("\0") && path.isAbsolute(v);

const dedupe = list => {
  const seen = new Set();
  return list.filter(p => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
};

// Ruling R32: feeds checkPath `protectedPaths`, which is a SUBTREE rule (entry, anything inside it, anything
// containing it). So only real subtree roots belong here. "OneDrive - <org>" variants are skipped on purpose:
// finding them needs a directory listing of the real home.
// appDir, dataRoot and home are mandatory (throws); env-derived OneDrive folders are optional and skipped when bad.
// Follow-up for a later task: also add HKCU OneDrive Accounts\*\UserFolder and User Shell Folders redirections (read-only reg).
// `extraPaths`: redirected known folders and OneDrive account folders from readKnownFolders(); they only ADD protection.
// Drive roots are rejected (a protected drive root would block every deletion on that drive) and at most MAX_EXTRAS are kept.
export const MAX_EXTRAS = 64;
export function cleanExtras(extra) {
  const notes = [];
  const paths = [];
  let driveRoot = false;
  for (const v of Array.isArray(extra) ? extra : []) {
    if (!okAbs(v) || suspiciousPathForm(v)) continue;
    if (path.parse(v).root === v) { driveRoot = true; continue; }
    paths.push(v);
  }
  if (driveRoot) notes.push("A known folder that is a whole drive was ignored; the standard protection list is used for it.");
  if (paths.length > MAX_EXTRAS) {
    paths.length = MAX_EXTRAS;
    notes.push("More than " + MAX_EXTRAS + " redirected folders were found; only the first " + MAX_EXTRAS + " were added to the protection list.");
  }
  return { paths, notes };
}

export function appProtectedPaths({ appDir, dataRoot, home = os.homedir(), env = process.env, extraPaths = [] } = {}) {
  for (const [k, v] of [["appDir", appDir], ["dataRoot", dataRoot], ["home", home]])
    if (!okAbs(v)) throw new Error(k + " must be an absolute path");
  const list = [];
  const add = v => { if (okAbs(v)) list.push(path.resolve(v)); };
  add(appDir);
  add(dataRoot);
  for (const t of TOOL_PROTECTED) add(t);
  for (const n of USER_FOLDERS) add(path.join(home, n));
  const e = env && typeof env === "object" ? env : {};
  add(e.OneDrive);
  add(e.OneDriveCommercial);
  add(e.OneDriveConsumer);
  for (const x of cleanExtras(extraPaths).paths) add(x);
  return dedupe(list);
}

// ---- known folders (read-only registry) ----
// HKCU User Shell Folders holds redirected Documents/Desktop/Pictures/Music/Videos/Downloads; OneDrive\Accounts\*\UserFolder
// holds the OneDrive (including "OneDrive - <org>") folders. Both reads go through lib/sysread.mjs (fixed keys, fixed args).
// Anything unreadable or odd becomes a note and adds nothing: the caller keeps the fixed list, so protection never shrinks.
// The reader is injected (this module stays free of any process-starting import): main passes sysread's regQuery.
// Expected call in main: const kf = await readKnownFolders({ readReg: regQuery, env, home });
//   appProtectedPaths({ ..., extraPaths: kf.paths }); appProtectedRoots({ ..., extraPaths: kf.paths }); show kf.notes if any.
const KNOWN_VALUE_NAMES = new Set(["personal", "desktop", "my pictures", "my music", "my video", "{374de290-123f-4565-9164-39c4925e467b}"]);
const ENV_VARS = ["USERPROFILE", "OneDrive", "OneDriveConsumer", "OneDriveCommercial"];
const BAD_CH = /[\u0000-\u001f\u007f-\u009f\u2028\u2029?]/;

function expandKnown(data, env, home) {
  if (typeof data !== "string" || data.length === 0 || data.length > 1024 || BAD_CH.test(data)) return null;
  let bad = false;
  const out = data.replace(/%([^%]*)%/g, (m, name) => {
    const k = ENV_VARS.find(v => v.toLowerCase() === name.toLowerCase());
    const val = k === "USERPROFILE" ? (okAbs(env.USERPROFILE) ? env.USERPROFILE : home) : k ? env[k] : undefined;
    if (!okAbs(val)) { bad = true; return m; }
    return val;
  });
  if (bad || out.includes("%") || !okAbs(out) || suspiciousPathForm(out)) return null;
  return path.resolve(out);
}

function valuesOf(res) {
  if (!res || res.ok !== true || !Array.isArray(res.keys)) return null;
  return res.keys.filter(k => k && typeof k === "object" && typeof k.path === "string" && k.values && typeof k.values === "object");
}

export async function readKnownFolders({ readReg = null, home = os.homedir(), env = process.env } = {}) {
  const e = env && typeof env === "object" ? env : {};
  const paths = [];
  const notes = [];
  const take = (data, what) => {
    const p = expandKnown(data, e, home);
    if (p) paths.push(p); else notes.push("A redirected " + what + " folder could not be read safely; the standard protection list is used for it.");
  };
  const query = async name => { try { return typeof readReg === "function" ? await readReg(name) : null; } catch { return null; } };

  const usf = valuesOf(await query("userShellFolders"));
  if (usf === null) notes.push("Redirected Documents/Desktop/Pictures folders could not be read; the standard protection list is used.");
  else for (const key of usf) {
    for (const [name, v] of Object.entries(key.values)) {
      if (!KNOWN_VALUE_NAMES.has(String(name).toLowerCase()) || !v || typeof v !== "object") continue;
      take(v.data, "user");
    }
  }
  const od = valuesOf(await query("oneDriveAccounts"));
  if (od === null) notes.push("OneDrive account folders could not be read; the standard protection list is used.");
  else for (const key of od) {
    for (const [name, v] of Object.entries(key.values)) {
      if (String(name).toLowerCase() !== "userfolder" || !v || typeof v !== "object") continue;
      take(v.data, "OneDrive");
    }
  }
  return { paths: dedupe(paths), notes };
}

// Exact folders that, with anything that CONTAINS them, must never be a deletion candidate. Items inside are fine.
export function appProtectedRoots({ home = os.homedir(), env = process.env, extraPaths = [] } = {}) {
  const list = [];
  const add = v => { if (okAbs(v)) list.push(path.resolve(v)); };
  add(home);
  for (const x of cleanExtras(extraPaths).paths) add(x);
  const e = env && typeof env === "object" ? env : {};
  add(e.APPDATA);
  add(e.LOCALAPPDATA);
  add(e.ProgramData);
  if (okAbs(e.APPDATA)) {
    const start = path.join(e.APPDATA, "Microsoft", "Windows", "Start Menu");
    add(start);
    add(path.join(start, "Programs"));
  }
  return dedupe(list);
}

// Start-up protection in one place (main calls this; tested without Electron). `readReg` is sysread's regQuery.
// profileRoot: USERPROFILE if it is a clean absolute path, else the OS home, else null (the controller then refuses
// investigate items). A failing read only adds notes: the fixed protections are always included.
export async function buildProtection({ appDir, dataRoot, home = os.homedir(), env = process.env, readReg = null, execDir = null } = {}) {
  const e = env && typeof env === "object" ? env : {};
  let kf = { paths: [], notes: [] };
  try { kf = await readKnownFolders({ readReg, home, env: e }); } catch { kf = { paths: [], notes: ["Redirected folders could not be read; the standard protection list is used."] }; }
  const extra = cleanExtras(kf.paths);
  const protectedPaths = appProtectedPaths({ appDir, dataRoot, home, env: e, extraPaths: extra.paths });
  if (okAbs(execDir)) protectedPaths.push(path.resolve(execDir));
  const protectedRoots = appProtectedRoots({ home, env: e, extraPaths: extra.paths });
  const good = v => okAbs(v) && !suspiciousPathForm(v) && path.parse(v).root !== path.resolve(v);
  const profileRoot = good(e.USERPROFILE) ? path.resolve(e.USERPROFILE) : good(home) ? path.resolve(home) : null;
  return { profileRoot, protectedPaths, protectedRoots, notes: [...kf.notes, ...extra.notes] };
}

// Same rule as violatesRoots, with the roots' canonical forms worked out ONCE (a delete of thousands of items would otherwise
// resolve every root on disk again for every item). Returns a function path -> boolean. Fails closed: bad roots => always true.
export function rootsViolationChecker(roots) {
  let rs;
  try {
    if (!Array.isArray(roots) || roots.length === 0 || !roots.every(okAbs)) return () => true;
    rs = roots.flatMap(canonicalForms);
  } catch { return () => true; }
  return candidate => {
    try {
      if (suspiciousPathForm(candidate)) return true;
      return canonicalForms(candidate).some(c => rs.some(r => within(r, c)));
    } catch { return true; }
  };
}

// True if the candidate equals a root or is an ancestor of one; false for a path inside a root. Fails closed.
export function violatesRoots(candidate, roots) {
  try {
    if (suspiciousPathForm(candidate)) return true;
    if (!Array.isArray(roots) || roots.length === 0 || !roots.every(okAbs)) return true;
    const cands = canonicalForms(candidate);
    const rs = roots.flatMap(canonicalForms);
    return cands.some(c => rs.some(r => within(r, c)));
  } catch { return true; }
}
