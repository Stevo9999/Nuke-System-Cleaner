// Investigator: picked file / shortcut / folder -> program entry -> install folder -> exact-name leftovers.
// Read-only. The registry and scheduled tasks come in through injected readers (no process starts here).
// Every offered path is vetted by checkPath (plus the app-level guards, R32); anything doubtful is protected.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPath, within, dirArgProblem, suspiciousPathForm } from "./safepath.mjs";
import { makeFinding } from "./confidence.mjs";
import { dirSize } from "./sizes.mjs";
import { listStartupItems } from "./startup.mjs";
import { violatesRoots, appProtectedRoots } from "../app/main/appdata.mjs";

const WIN = process.platform === "win32";
const lc = (s) => (WIN ? String(s).toLowerCase() : String(s));
const nk = (p) => lc(path.resolve(p));
const okAbs = (v) => typeof v === "string" && v.length > 0 && !v.includes("\0") && path.isAbsolute(v);
const DRIVE_ABS = /^[A-Za-z]:[\\/]/;
const LOSSY_CH = /[\x00-\x08\x0a-\x1f\x7f-\xff?%]+/g;
const LOSSY_FIRST = /[\x00-\x08\x0a-\x1f\x7f-\xff?%]/;
const isLossyStr =(s) => /[\x00-\x08\x0a-\x1f\x7f-\xff?%]/.test(s);
const MAX_NAMES = 20000;
const MAX_LNK_READS = 3000;
const MAX_REPORTS = 200;
const MAX_REASON = 300;
const OUTSIDE_PROFILE = "Outside your user folder: delete this by hand (another account on this PC could redirect an automatic delete)";
const PARENT_PROBLEM = "folders directly on a drive root, home or system folders cannot be removed";
const SYSTEM_PICK = "this is inside a Windows program folder (Program Files, ProgramData or Windows). This app does not delete things there. Remove a program with Installed programs, or delete your own folder there in File Explorer";

// Folder names too generic to identify a product.
const GENERIC = new Set([
  "bin", "app", "apps", "application", "program", "programs", "data", "temp", "tmp", "cache", "local", "common",
  "microsoft", "windows", "system", "system32", "packages", "plugins", "lib", "libs", "src", "release", "debug",
  "x64", "x86", "win32", "win64", "install", "installer", "setup", "downloads", "desktop", "documents", "users",
  "default", "public", "shared", "resources", "assets", "content", "files", "tools", "launcher", "game", "games",
]);

// ---------- program entries ----------

const KEYS = ["uninstallHKLM", "uninstallWow", "uninstallHKCU"];

function valueOf(key, name) {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(key && key.values ? key.values : {})) {
    if (k.toLowerCase() === want && v && typeof v.data === "string") return v;
  }
  return null;
}
const unquote = (s) => {
  s = s.trim();
  return s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1).trim() : s;
};
function stripTrailingSep(p) {
  while (p.length > 3 && /[\\/]$/.test(p)) p = p.slice(0, -1);
  return p;
}
function cleanFolder(s) {
  const p = stripTrailingSep(unquote(s));
  return DRIVE_ABS.test(p) && !suspiciousPathForm(p) ? p : "";
}
function cleanFile(s) {
  let p = unquote(s).replace(/,\s*-?\d+$/, "");
  p = unquote(p);
  return DRIVE_ABS.test(p) && !suspiciousPathForm(p) ? p : "";
}
// The program path at the start of a command line. "" unless it is a drive-absolute path.
function exeOf(cmd) {
  if (typeof cmd !== "string") return "";
  const s = cmd.trim();
  if (!s) return "";
  let e;
  if (s[0] === '"') {
    const close = s.indexOf('"', 1);
    e = close > 0 ? s.slice(1, close) : "";
  } else {
    const m = /\.(exe|com|bat|cmd|sys)(?![A-Za-z0-9_])/i.exec(s);
    e = m ? s.slice(0, m.index + m[0].length) : s.split(/\s+/)[0];
  }
  e = e.trim();
  return DRIVE_ABS.test(e) && !suspiciousPathForm(e) ? e : "";
}

// Reads the three Uninstall hives. ok only if all three were read cleanly; entries from the ones that worked are
// still returned. partial/notes tell the caller the picture may be incomplete.
export async function readProgramEntries(regQuery) {
  const entries = [];
  const notes = [];
  let ok = true;
  let partial = false;
  for (const name of KEYS) {
    let r;
    try { r = await regQuery(name); } catch { r = null; }
    if (!r || !r.ok || !Array.isArray(r.keys)) { ok = false; partial = true; notes.push("program list " + name + " could not be read"); continue; }
    if (r.partial) {
      partial = true;
      const n = r.notes ?? r.keys.notes;
      notes.push("program list " + name + " was only partly readable" + (Array.isArray(n) && n.length ? " (" + n.join("; ") + ")" : ""));
    }
    for (const key of r.keys) {
      const dn = valueOf(key, "DisplayName");
      const pub = valueOf(key, "Publisher");
      const il = valueOf(key, "InstallLocation");
      const di = valueOf(key, "DisplayIcon");
      const us = valueOf(key, "UninstallString");
      const entry = {
        key: String(key.path),
        displayName: dn ? dn.data.trim() : "",
        publisher: pub ? pub.data.trim() : "",
        installLocation: il ? cleanFolder(il.data) : "",
        displayIcon: di ? cleanFile(di.data) : "",
        uninstallString: us ? exeOf(us.data) : "",
        lossy: [dn, pub, il, di, us].some((v) => v && (v.lossy === true || isLossyStr(v.data))),
      };
      // Nameless entries (hidden components, updates) are kept: they may only ever make sharing CLAIMS.
      if (!entry.displayName && !entry.installLocation && !entry.displayIcon && !entry.uninstallString && !entry.lossy) continue;
      entries.push(Object.freeze(entry));
    }
  }
  return { ok, entries, partial, notes };
}

// ---------- lossy-name helpers (R34): lossy text never matches positively, but may "maybe" match for sharing ----------

const MAX_GLOB = 2000;
// Linear-time glob test (no regex, so no backtracking): lossy characters in the pattern are wildcards.
// open=true: the text may continue past the pattern (the pattern is an ancestor-or-equal folder).
function globMatch(pattern, text, open) {
  if (typeof text !== "string" || text.length > MAX_GLOB || pattern.length > MAX_GLOB) return true; // cannot judge: maybe
  const lits = pattern.toLowerCase().split(LOSSY_CH);
  const t = text.toLowerCase();
  const first = lits[0];
  if (!t.startsWith(first)) return false;
  if (lits.length === 1) return open || t.length === first.length;
  let pos = first.length;
  for (let i = 1; i < lits.length - 1; i++) {
    const at = t.indexOf(lits[i], pos);
    if (at < 0) return false;
    pos = at + lits[i].length;
  }
  const last = lits[lits.length - 1];
  if (open) return last === "" || t.indexOf(last, pos) >= 0;
  return t.length - pos >= last.length && t.endsWith(last);
}
// Could `field` (possibly lossy) be exactly `name` (lower-cased)? Lossy fields answer "maybe" generously.
// `flagged`: the registry value itself was flagged lossy (e.g. duplicate value name), so even clean text is only a maybe.
function mayEqual(field, name, flagged = false) {
  if (!field) return false;
  if (flagged && !isLossyStr(field)) return true;
  if (!isLossyStr(field)) return field.toLowerCase() === name;
  return globMatch(field, name, false);
}
// Could the (possibly lossy) folder text `field` contain path p?
function mayContain(field, p, flagged = false) {
  if (!field) return false;
  if (flagged && !isLossyStr(field)) return true;
  if (!isLossyStr(field)) return DRIVE_ABS.test(field) && within(p, field);
  return globMatch(field, p, true);
}
// The fixed leading folder of a lossy path (text before the first lossy character, cut at a separator).
function fixedPrefix(field) {
  const m = LOSSY_FIRST.exec(field);
  const head = m ? field.slice(0, m.index) : field;
  const cut = Math.max(head.lastIndexOf("\\"), head.lastIndexOf("/"));
  const q = cut > 0 ? head.slice(0, cut) : "";
  return q.length > 3 && DRIVE_ABS.test(q + "\\") ? q : "";
}

// ---------- main ----------

function emptyResult(target, notes, roots = [], prot = []) {
  return { kind: "investigate", target, items: [], allowedRoots: roots, protectedPaths: prot, notes, adminExtraBytes: null, partial: false };
}
function entryLabel(e) {
  return e.displayName || e.key.split("\\").pop() || "another installed program";
}

export async function investigate(target, opts = {}) {
  const {
    regQuery, listScheduledTasks, readLnk,
    env = process.env, home = os.homedir(), protectedPaths = [], onProgress, signal,
  } = opts;
  const progress = (m) => { try { if (typeof onProgress === "function") onProgress(m); } catch { /* ignore */ } };
  const notes = [];
  const note = (m) => { if (!notes.includes(m)) notes.push(m); };
  const aborted = () => !!(signal && signal.aborted);
  let partial = false;

  // Step 1: validate before any filesystem call.
  const bad = suspiciousPathForm(target);
  if (bad) return emptyResult(typeof target === "string" ? target : null, ["That item cannot be investigated (" + bad + ")."], [], protectedPaths);
  const picked = path.resolve(target);
  let pst;
  try { pst = lstatSync(picked); } catch { return emptyResult(picked, ["That item does not exist."], [], protectedPaths); }
  if (pst.isSymbolicLink()) return emptyResult(picked, ["That item is a link or junction and is not followed."], [], protectedPaths);
  try { if (nk(realpathSync.native(picked)) !== nk(picked)) return emptyResult(picked, ["A folder on the way to that item is a link or alias."], [], protectedPaths); }
  catch { return emptyResult(picked, ["That item could not be resolved."], [], protectedPaths); }
  const pickedIsDir = pst.isDirectory();

  // Environment-derived bases.
  const e = env && typeof env === "object" ? env : {};
  const userProfile = okAbs(e.USERPROFILE) ? e.USERPROFILE : home;
  const bases = [];
  for (const b of [e.LOCALAPPDATA, e.APPDATA, okAbs(userProfile) ? path.join(userProfile, "AppData", "LocalLow") : null, e.ProgramData]) {
    if (okAbs(b) && !bases.some((x) => nk(x) === nk(b))) bases.push(path.resolve(b));
  }
  const protectedRoots = appProtectedRoots({ home, env: e });
  // R45: in standard mode only items inside the user's own profile may be removed automatically.
  const profileRoots = [];
  if (okAbs(userProfile)) {
    profileRoots.push(path.resolve(userProfile));
    try { const rp = realpathSync.native(userProfile); if (nk(rp) !== nk(userProfile)) profileRoots.push(rp); } catch { /* keep the plain form */ }
  }
  const inProfile = (p, resolved) => profileRoots.length > 0 && profileRoots.some((r) => within(p, r) && (!resolved || within(resolved, r)));
  const sysDirs = [e.ProgramFiles, e["ProgramFiles(x86)"], e.ProgramW6432, e.ProgramData, e.SystemRoot, e.windir].filter(okAbs).map((p) => path.resolve(p));
  const userFolders = ["Desktop", "Documents", "Pictures", "Music", "Videos", "Downloads", "OneDrive"].map((n) => path.join(home, n));
  const containers = okAbs(e.LOCALAPPDATA) ? ["Programs", "Microsoft", "Packages"].map((n) => path.join(e.LOCALAPPDATA, n)) : [];
  if (okAbs(e.APPDATA)) containers.push(path.join(e.APPDATA, "Microsoft"));
  if (okAbs(userProfile)) containers.push(path.join(userProfile, "AppData", "LocalLow"));

  // A folder far too broad to stand for "the install folder" of one program.
  const tooBroad = (p) => {
    try {
      if (!okAbs(p) || path.parse(path.resolve(p)).root === path.resolve(p)) return true;
      if (violatesRoots(p, protectedRoots)) return true;
      if (sysDirs.some((s) => within(s, p))) return true;
      if (userFolders.some((u) => within(u, p))) return true;
      if (containers.some((c) => within(c, p))) return true; // the container itself or a parent of it
      if (protectedPaths.filter(okAbs).some((q) => within(p, q) || within(q, p))) return true;
      return false;
    } catch { return true; }
  };

  // Allowed roots: the bases plus the picked item's parent (only if that parent is an acceptable folder).
  const parent = path.dirname(picked);
  const parentProblem = dirArgProblem(parent, { home });
  const allowedRoots = [...bases];
  if (!parentProblem && !allowedRoots.some((x) => nk(x) === nk(parent))) allowedRoots.push(parent);

  const items = [];
  const seen = new Set();

  // One vetting pipeline for every offered path.
  const vet = (p) => {
    const raw = suspiciousPathForm(p);
    if (raw) return { ok: false, reason: raw };
    if (sysDirs.some((s) => within(p, s))) return { ok: false, reason: "system folder (needs administrator mode)" };
    if (violatesRoots(p, protectedRoots)) return { ok: false, reason: "is or contains a protected folder" };
    return checkPath(p, { allowedRoots, protectedPaths });
  };
  const addPath = (p, f) => {
    const k = nk(p);
    if (seen.has(k)) return null;
    seen.add(k);
    let safe = f.preProblem ? { ok: false, reason: f.preProblem } : vet(p);
    const outside = safe.ok && !inProfile(p, safe.resolved);
    let bytes = null;
    let kind = f.kind || "dir";
    if (safe.ok && !outside) {
      kind = safe.isDir ? "dir" : "file";
      try { bytes = safe.isDir ? dirSize(safe.resolved) : lstatSync(safe.resolved).size; } catch { bytes = null; }
    }
    const fin = makeFinding({
      kind, path: p, label: path.basename(p) || p, bytes, safe,
      sharedWith: f.sharedWith || [], basis: f.basis, userPicked: f.userPicked, entryGone: f.entryGone,
      reportOnly: outside ? true : undefined,
      reason: (outside ? OUTSIDE_PROFILE : safe.ok ? f.reason : safe.reason) || "", category: f.category || "investigate",
    });
    items.push(fin);
    return fin;
  };
  const addReport = (kind, idKey, label, reason) => {
    if (items.filter((i) => i.kind === kind).length >= MAX_REPORTS) { note("more " + kind + " items found than can be listed"); return; }
    items.push(makeFinding({ kind, path: null, label: String(label).slice(0, 200), idKey, reason: String(reason).slice(0, MAX_REASON), category: kind }));
  };

  // Step 1b: shortcut handling.
  let subject = picked;          // what is traced from
  let subjectIsDir = pickedIsDir;
  let subjectMissing = false;
  let traceable = true;
  const isLnk = !pickedIsDir && /\.lnk$/i.test(picked);
  if (isLnk) {
    let r = null;
    try { r = typeof readLnk === "function" ? await readLnk(picked) : null; } catch { r = null; }
    if (!r || !r.ok) { note("The shortcut could not be read; only the shortcut itself is offered."); traceable = false; }
    else if (r.network || r.device) { note("shortcut points to a network location; not traced"); traceable = false; }
    else if (typeof r.target !== "string" || !okAbs(r.target) || !DRIVE_ABS.test(r.target) || suspiciousPathForm(r.target)) {
      note("The shortcut's target could not be determined; only the shortcut itself is offered."); traceable = false;
    } else {
      subject = path.resolve(r.target);
      try {
        const st = lstatSync(subject);
        subjectIsDir = st.isDirectory();
      } catch {
        subjectMissing = true;
        subjectIsDir = false;
        note("The shortcut's target no longer exists; the shortcut itself is still offered.");
      }
    }
  }

  // Step 2: the picked item itself.
  progress("picked item");
  // The picked item is added once the program entries are known (R38: it gets the sharing check too).
  // Medium and unticked unless a program entry was traced to it (an untraced pick is only the user's word).
  const addPicked = (sharedWith, traced = false) => addPath(picked, {
    kind: pickedIsDir ? "dir" : "file", basis: "traced", userPicked: traced === true, sharedWith,
    preProblem: sysDirs.some((s) => within(picked, s)) ? SYSTEM_PICK : protectedPaths.filter(okAbs).some((q) => nk(q) === nk(picked)) ? "this is one of your personal folders and cannot be removed (pick a file or folder inside it instead)" : parentProblem ? PARENT_PROBLEM : tooBroad(picked) ? "this folder holds data for many programs and cannot be removed" : null,
    reason: sharedWith.length ? "You picked this; also used by " + sharedWith.join(", ") : "You picked this", category: "picked",
  });

  const finish = () => {
    if (aborted()) { partial = true; note("Scan was cancelled."); }
    return { kind: "investigate", target: picked, items, allowedRoots, protectedPaths, notes, adminExtraBytes: null, partial };
  };
  if (!traceable || aborted()) { addPicked([]); return finish(); }

  // Step 3: program entries.
  progress("program entries");
  let reg = { ok: false, entries: [], partial: true, notes: [] };
  if (typeof regQuery === "function") {
    try { reg = await readProgramEntries(regQuery); } catch { reg = { ok: false, entries: [], partial: true, notes: ["program list could not be read"] }; }
  }
  for (const n of reg.notes) note(n);
  if (!reg.ok || reg.partial) partial = true;
  const entries = reg.entries;

  const subjectFolder = subjectIsDir ? subject : path.dirname(subject);
  const folderOk = !tooBroad(subjectFolder);
  const matches = entries.filter((en) => {
    if (en.lossy || !en.displayName) return false;
    if (en.installLocation && !tooBroad(en.installLocation) && within(subject, en.installLocation)) return true;
    if (!folderOk) return false;
    for (const x of [en.displayIcon, en.uninstallString]) if (x && within(x, subjectFolder)) return true;
    return false;
  });
  matches.sort((a, b) => b.installLocation.length - a.installLocation.length);
  const primary = matches[0] || null;

  // A lossy entry that MIGHT cover this item: positive matching is impossible, so nothing here may be high.
  const lossyAmbiguous = entries.some((en) => en.lossy && (
    mayContain(en.installLocation, subject, true) ||
    (folderOk && [en.displayIcon, en.uninstallString].some((x) => x && mayContain(path.dirname(x), subjectFolder, true)))));
  if (entries.some((en) => en.lossy)) note("Some program entries have names that could not be read exactly; they are never used to match, only to mark sharing.");
  const complete = reg.ok && !reg.partial && !lossyAmbiguous;
  const derivedPicked = complete && primary !== null;

  // Install folder.
  let installFolder = null;
  let installFromEntry = false;
  if (primary && primary.installLocation && !tooBroad(primary.installLocation) && within(subject, primary.installLocation)) {
    installFolder = path.resolve(primary.installLocation);
    installFromEntry = true;
  } else if (primary) {
    installFolder = path.resolve(subjectFolder);
    installFromEntry = true;
  } else if (folderOk) {
    installFolder = path.resolve(subjectFolder);
  }

  let installExists = false;
  if (installFolder) { try { lstatSync(installFolder); installExists = true; } catch { /* missing */ } }
  // "Entry gone" only counts when the whole folder is gone too: an existing folder may be a vendor folder.
  const derivedGone = complete && primary === null && subjectMissing && !installExists;

  for (const en of matches) {
    addReport("entry", "entry:" + en.key, entryLabel(en), "registry entries are not changed in this version");
  }

  // Sharing. A second install of the same product (different location) is another program; only a true
  // duplicate (same name, publisher and location, e.g. HKLM + WOW6432Node) is dropped.
  const ekey = (en) => lc(en.displayName) + "|" + lc(en.publisher) + "|" + lc(en.installLocation);
  const primaryKey = primary ? ekey(primary) : null;
  const others = entries.filter((en) => ekey(en) !== primaryKey);
  const sharedAll = [...new Set(matches.filter((en) => ekey(en) !== primaryKey).map(entryLabel))];
  const foldersOf = (en) => [en.installLocation, en.displayIcon && path.dirname(en.displayIcon), en.uninstallString && path.dirname(en.uninstallString)].filter(Boolean);
  const claimedBy = (en, p, name) => {
    if (name && [en.displayName, en.publisher, en.installLocation ? path.basename(en.installLocation) : ""].some((x) => mayEqual(x, name, en.lossy))) return true;
    for (const f of foldersOf(en)) {
      if (en.lossy || isLossyStr(f)) {
        if (mayContain(f, p, en.lossy)) return true; // p may be inside the other program's folder
        const f0 = fixedPrefix(f);
        if (f0 && within(f0, p)) return true;         // the other program's folder is certainly inside p
      } else if (DRIVE_ABS.test(f)) {
        if (within(f, p)) return true;
        if (within(p, f) && !tooBroad(f)) return true;
      }
    }
    return false;
  };
  // Other programs that use path p (optionally also by folder name), plus anything else installed in the pick's folder.
  const claims = (p, name) => [...new Set([...others.filter((en) => claimedBy(en, p, name)).map(entryLabel), ...sharedAll])];

  addPicked(claims(picked, null), derivedPicked);

  if (installFolder && installFromEntry && installExists && nk(installFolder) !== nk(picked)) {
    addPath(installFolder, {
      basis: "traced", userPicked: derivedPicked, entryGone: derivedGone, sharedWith: claims(installFolder, null),
      reason: "Install folder of " + (primary ? entryLabel(primary) : "the program"), category: "install-folder",
    });
  }

  if (aborted()) return finish();

  // Step 4: leftovers.
  progress("leftovers");
  const folderName = installFolder ? path.basename(installFolder) : "";
  const folderKey = folderName.length >= 3 && !GENERIC.has(folderName.toLowerCase()) && !isLossyStr(folderName) ? folderName.toLowerCase() : "";
  const displayKey = primary && primary.displayName.length >= 3 ? primary.displayName.toLowerCase() : "";
  const publisherKey = primary && primary.publisher.length >= 3 ? primary.publisher.toLowerCase() : "";
  const productKeys = [folderKey, displayKey].filter(Boolean);
  const boundaryPrefix = (n, t) => t.length >= 4 && n !== t && n.startsWith(t) && !/[A-Za-z0-9]/.test(n[t.length]);

  if (productKeys.length) {
    for (const base of bases) {
      if (aborted()) break;
      let names;
      try { names = readdirSync(base); } catch { continue; }
      if (names.length > MAX_NAMES) { names = names.slice(0, MAX_NAMES); partial = true; note("Only the first " + MAX_NAMES + " entries of one folder were checked."); }
      for (const raw of names) {
        const n = raw.toLowerCase();
        const full = path.join(base, raw);
        let isDirChild = false;
        try { const st = lstatSync(full); isDirChild = st.isDirectory() || st.isSymbolicLink(); } catch { continue; }
        if (!isDirChild) continue;

        // <publisher>\<product>
        if (publisherKey && n === publisherKey && !productKeys.includes(n)) {
          let kids = [];
          try { kids = readdirSync(full); } catch { kids = []; }
          const prod = kids.filter((k) => productKeys.includes(k.toLowerCase()));
          const childSw = [];
          for (const k of prod) {
            const pf = path.join(full, k);
            const psw = claims(pf, k.toLowerCase());
            childSw.push(...psw);
            addPath(pf, {
              basis: "traced", userPicked: derivedPicked, entryGone: derivedGone, sharedWith: psw,
              reason: "Product folder inside the publisher folder", category: "leftover",
            });
          }
          if (prod.length) {
            // The publisher folder is shared if anything in it (or the folder itself) is used by another program.
            let sw = [...new Set([...childSw, ...claims(full, n)])];
            if (sw.length === 0 && (kids.length !== 1 || prod.length !== 1)) sw = ["other items in that folder"];
            addPath(full, {
              basis: "traced", userPicked: derivedPicked, entryGone: derivedGone, sharedWith: sw,
              reason: sw.length ? "Publisher folder also used by " + sw.join(", ") : "Publisher folder holding only this program", category: "leftover",
            });
          }
          continue;
        }

        let basis = null, why = "";
        if (folderKey && n === folderKey) { basis = "traced"; why = "Folder named exactly like the install folder"; }
        else if (displayKey && n === displayKey) { basis = "name"; why = "Folder named like the program (name match only)"; }
        else if (productKeys.some((t) => boundaryPrefix(n, t))) { basis = "fuzzy"; why = "Folder name starts like the program name (partial match)"; }
        if (!basis) continue;
        const sw = claims(full, n);
        addPath(full, {
          basis, userPicked: derivedPicked, entryGone: derivedGone, sharedWith: sw,
          reason: sw.length ? why + "; also used by " + sw.join(", ") : why, category: "leftover",
        });
      }
    }
  }

  // Step 5: Start Menu shortcuts into the install folder.
  if (installFolder && typeof readLnk === "function" && !aborted()) {
    progress("start menu");
    const trees = [];
    if (okAbs(e.APPDATA)) trees.push(path.join(e.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"));
    if (okAbs(e.ProgramData)) trees.push(path.join(e.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"));
    let reads = 0;
    const walk = async (dir, depth) => {
      let dirents;
      try { dirents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of dirents) {
        if (aborted() || reads >= MAX_LNK_READS) return;
        const full = path.join(dir, d.name);
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory()) { if (depth < 3) await walk(full, depth + 1); continue; }
        if (!d.isFile() || !/\.lnk$/i.test(d.name)) continue;
        reads++;
        let r = null;
        try { r = await readLnk(full); } catch { r = null; }
        if (!r || !r.ok || r.network || r.device || typeof r.target !== "string" || !DRIVE_ABS.test(r.target) || suspiciousPathForm(r.target)) continue;
        if (!within(r.target, installFolder)) continue;
        addPath(full, {
          kind: "file", basis: "traced", userPicked: derivedPicked, entryGone: derivedGone,
          sharedWith: claims(path.resolve(r.target), null),
          reason: "Start Menu shortcut to the install folder", category: "start-menu",
        });
      }
    };
    for (const t of trees) await walk(t, 0);
    if (aborted()) return finish();
    if (reads >= MAX_LNK_READS) { partial = true; note("Start Menu search stopped early (too many shortcuts)."); }
  }

  // Step 6: services, scheduled tasks, startup items (report-only).
  if (installFolder && !aborted()) {
    progress("services and tasks");
    if (typeof regQuery === "function") {
      let sr = null;
      try { sr = await regQuery("services"); } catch { sr = null; }
      if (!sr || !sr.ok || !Array.isArray(sr.keys)) { note("services could not be read"); partial = true; }
      else {
        if (sr.partial) { note("services were only partly readable"); partial = true; }
        for (const key of sr.keys) {
          const v = valueOf(key, "ImagePath");
          if (!v || v.lossy === true || isLossyStr(v.data)) continue;
          const exe = exeOf(v.data);
          if (exe && within(exe, installFolder)) {
            const name = String(key.path).split("\\").pop();
            addReport("service", "service:" + key.path, name, "Service runs " + exe + ". Services are not changed in this version.");
          }
        }
      }
    }
    let tr = null;
    try { tr = typeof listScheduledTasks === "function" ? await listScheduledTasks() : null; } catch { tr = null; }
    if (!tr || !tr.ok || !Array.isArray(tr.tasks)) { note("scheduled tasks could not be read"); partial = true; }
    else {
      for (const t of tr.tasks) {
        if (!t || t.lossy === true || typeof t.run !== "string" || isLossyStr(t.run)) continue;
        const exe = exeOf(t.run);
        if (exe && within(exe, installFolder)) addReport("task", "task:" + t.name, t.name, "Scheduled task runs " + exe + ". Tasks are not changed in this version.");
      }
    }
    if (typeof regQuery === "function") {
      try {
        const su = await listStartupItems({ regQuery, env: e, readLnk: typeof readLnk === "function" ? readLnk : null });
        const sn = su.notes;
        if (Array.isArray(sn)) for (const m of sn) { note(m); partial = true; }
        const fl = lc(installFolder).replace(/\//g, "\\");
        for (const s of su) {
          const text = lc(String(s.reason || "")).replace(/\//g, "\\");
          if (text.includes(fl + "\\") || text.endsWith(fl)) addReport("startup", "startup:" + s.id, s.label, s.reason);
        }
      } catch { note("startup items could not be read"); partial = true; }
    }
  }

  return finish();
}
