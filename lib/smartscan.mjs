// lib/smartscan.mjs
// Per-user Smart Scan over the vetted table. READ-ONLY: this module never deletes, moves or writes anything and
// starts no processes. It only builds findings; deletion happens elsewhere after the user's gesture.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPath, within } from "./safepath.mjs";
import { makeFinding } from "./confidence.mjs";
import { LOCATIONS, EXCLUDED, expandBase } from "./junk-locations.mjs";
import { appDataPaths, appProtectedPaths, appProtectedRoots, violatesRoots } from "../app/main/appdata.mjs";

const HOUR = 3600 * 1000;
const WIN = process.platform === "win32";
const nk = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUDGET = { maxEntries: 200000, maxMs: 60000 };

// A file is "locked" if it cannot be opened for read+write right now. Any error fails closed (true).
export function isLocked(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r+");
    return !fs.fstatSync(fd).isFile(); // a folder (or anything not a plain file) is never "free"
  } catch {
    return true; // EBUSY / EPERM / EACCES, and anything else: do not offer it
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* handle already gone */ } }
  }
}

function abortError() {
  const e = new Error("Smart Scan was cancelled");
  e.name = "AbortError";
  e.code = "ABORT_ERR";
  return e;
}

const newer = (st) => Math.max(st.mtimeMs, st.birthtimeMs);
export const cleanText = (s, max = 260) => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").slice(0, max);

// Windows Recycle Bin "$I" record: v1 = 24-byte header + 520-byte UTF-16 path; v2 = 28-byte header (len at 24) + path.
function parseRecycleOriginal(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size < 24 || st.size > 65536) return null;
    const b = fs.readFileSync(file);
    const ver = Number(b.readBigInt64LE(0));
    let raw;
    if (ver === 2 && b.length >= 28) {
      const n = b.readUInt32LE(24);
      raw = b.subarray(28, Math.min(b.length, 28 + n * 2)).toString("utf16le");
    } else if (ver === 1) {
      raw = b.subarray(24).toString("utf16le");
    } else return null;
    const t = cleanText(raw.split("\0")[0]);
    return t.trim().length > 0 ? t : null;
  } catch { return null; }
}

// Total bytes under p, or null if ANYTHING in it could not be read (never a silent 0). Links count 0 and are not
// followed; a folder on another volume or whose realpath differs counts 0 and is not read.
function measure(p, rootDev) {
  let st;
  try { st = fs.lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  if (st.dev !== rootDev) return 0;
  let names;
  try {
    if (nk(fs.realpathSync.native(p)) !== nk(p)) return 0;
    names = fs.readdirSync(p);
  } catch { return null; }
  let total = 0;
  for (const n of names) {
    const s = measure(path.join(p, n), rootDev);
    if (s === null) return null;
    total += s;
  }
  return total;
}

// Phase 1b notes (exact text).
export const ADMIN_FOLDER_NOTE = "left alone: folders are not removed in administrator mode";
const SERVICE_NOTE = "left alone: needs a stopped Windows service";
const OTHER_USERS_NOTE = "other users' files are never removed";
export const USER_IN_ADMIN_NOTE = "left alone in administrator mode: use standard mode for your own files";

// `elevated` (strict true) turns on the administrator branch for `adminCleanable` locations. `checkPathFn` exists for
// tests only (the scan worker never passes it: scan-runner's scanArgs forwards sid/elevated/env and nothing else).
export async function smartScan({
  env = process.env, sid, now = Date.now(), onProgress = () => {}, isLocked: lockedFn = isLocked,
  budget = DEFAULT_BUDGET, signal, locations = LOCATIONS, elevated = false, checkPathFn = checkPath,
  // Round 2 hooks, all fixed by the caller (the scan worker), never by a renderer: another vetted table with its own
  // never-touch list (Browsers cleaner), the result kind, a note shown when something was locked, and folders the user
  // excluded (they are added to protectedPaths: the folder, anything inside it and anything containing it is refused).
  excluded = EXCLUDED, resultKind = "smart", lockedNote = null, extraProtected = [],
} = {}) {
  const admin = elevated === true;
  const maxEntries = Number.isFinite(budget?.maxEntries) ? budget.maxEntries : DEFAULT_BUDGET.maxEntries;
  const maxMs = Number.isFinite(budget?.maxMs) ? budget.maxMs : DEFAULT_BUDGET.maxMs;
  const started = Date.now();
  let entries = 0;
  let partial = false;
  let sinceYield = 0;
  let lockedHit = false;
  const mergedSkips = new Map(); // label -> count, for tables whose locations share one label (Browsers cleaner)

  const checkAbort = () => { if (signal && signal.aborted) throw abortError(); };
  checkAbort();

  const e = env && typeof env === "object" ? env : {};
  const vars = { LOCALAPPDATA: e.LOCALAPPDATA, APPDATA: e.APPDATA, SystemRoot: e.SystemRoot, ProgramData: e.ProgramData,
    SystemDrive: e.SystemDrive, SID: sid };
  const home = os.homedir();
  // Ruling R32: the app-level guard. Fails closed: if it cannot be built nothing is scanned.
  const userExcluded = (Array.isArray(extraProtected) ? extraProtected : [])
    .filter((p) => typeof p === "string" && p.length > 0 && !p.includes(String.fromCharCode(0)) && path.isAbsolute(p)).map((p) => path.resolve(p));
  const protectedPaths = [...appProtectedPaths({ appDir: APP_DIR, dataRoot: appDataPaths(e).root, home, env: e }), ...userExcluded];
  const protectedRoots = appProtectedRoots({ home, env: e });
  const roots = protectedRoots;

  // Counts one filesystem entry against the budget and yields to the event loop every 500. false = out of budget.
  async function tick() {
    if (entries >= maxEntries || Date.now() - started > maxMs) { partial = true; return false; }
    entries++;
    if (++sinceYield >= 500) {
      sinceYield = 0;
      await new Promise((r) => setImmediate(r));
      checkAbort();
    }
    return true;
  }

  // Walks a candidate (file or folder). ok only if the whole tree was walked within budget, nothing is a link,
  // and (when checkAge) every file is old enough and not locked.
  async function qualify(p, st, rootDev, minAgeMs, checkAge) {
    const young = (s) => checkAge && !(now - newer(s) >= minAgeMs);   // spec 9.3: every folder walked, and the candidate itself, must be old too
    const fileOk = (fp, fst) => {
      if (fst.isSymbolicLink() || !fst.isFile()) return null;
      if (checkAge && !(now - newer(fst) >= minAgeMs)) return null;
      if (lockedFn(fp)) { lockedHit = true; return null; }
      return fst.size;
    };
    if (!st.isDirectory()) { const b = fileOk(p, st); return b === null ? { ok: false } : { ok: true, bytes: b }; }
    let bytes = 0;
    const stack = [p];
    while (stack.length) {
      const dir = stack.pop();
      checkAbort();
      let names;
      try {
        const dst = fs.lstatSync(dir);
        if (dst.isSymbolicLink() || !dst.isDirectory() || dst.dev !== rootDev || young(dst)) return { ok: false };
        if (nk(fs.realpathSync.native(dir)) !== nk(dir)) return { ok: false };
        names = fs.readdirSync(dir);
      } catch { return { ok: false }; }
      for (const n of names) {
        if (!(await tick())) return { ok: false };
        const fp = path.join(dir, n);
        let fst;
        try { fst = fs.lstatSync(fp); } catch { return { ok: false }; }
        if (fst.isSymbolicLink()) return { ok: false };
        if (fst.isDirectory()) { stack.push(fp); continue; }
        const b = fileOk(fp, fst);
        if (b === null) return { ok: false };
        bytes += b;
      }
    }
    return { ok: true, bytes };
  }

  const items = [];
  const notes = [];
  const allowedRoots = [];
  const total = locations.length;
  let adminKnown = 0;
  let adminSeen = false;

  // Ruling R37 and the EXCLUDED list, checked at run time: no candidate may equal, sit inside, or contain one.
  const excludedPaths = excluded.flatMap((x) => expandBase(x.base, vars, x.profile));
  const overlapsExcluded = (p) => excludedPaths.some((x) => within(p, x) || within(x, p));

  const guard = (p, base, adminContents = false) => {
    try {
      if (overlapsExcluded(p)) return false;
      if (violatesRoots(p, protectedRoots)) return false;
      const opts = adminContents === true ? { allowedRoots: [base], protectedPaths, adminContents: true } : { allowedRoots: [base], protectedPaths };
      const v = checkPathFn(p, opts);
      // R36: an administrator finding is only ever a plain file directly inside its base.
      if (adminContents === true && !(v.ok === true && v.isDir === false && nk(path.dirname(v.resolved)) === nk(base))) return false;
      return v.ok === true;
    } catch { return false; }
  };

  // Ruling R36 (administrator mode): ONLY direct-child plain files of the base are ever offered. Subfolders are never
  // offered and never walked (a user can create one in C:\Windows\Temp and swap it for a junction); they are counted
  // for a report-only note. Links are never followed. Same age, lock, match and budget rules as the per-user branch.
  async function adminLocation(L, minAgeMs) {
    let skipped = 0, folders = 0;
    for (const base of partial ? [] : expandBase(L.base, vars, L.profile)) {
      if (partial) break;
      let bst, names;
      const refuse = () => notes.push(`${L.label}: ${cleanText(base)} was not scanned (it is, or sits behind, a link or alias, or is a protected or excluded folder)`);
      try { bst = fs.lstatSync(base); } catch (err) { if (!err || err.code !== "ENOENT") refuse(); continue; }
      try {
        if (bst.isSymbolicLink() || !bst.isDirectory()) { refuse(); continue; }
        if (nk(fs.realpathSync.native(base)) !== nk(base)) { refuse(); continue; }
        if (violatesRoots(base, roots) || excludedPaths.some((x) => within(base, x))) { refuse(); continue; }
        names = fs.readdirSync(base);
      } catch { refuse(); continue; }
      const found = [];
      for (const n of names) {
        if (!(await tick())) { skipped++; continue; }
        const p = path.join(base, n);
        let st;
        try { st = fs.lstatSync(p); } catch { skipped++; continue; }
        if (st.isSymbolicLink()) { skipped++; continue; }
        if (st.isDirectory()) { folders++; continue; }
        if (L.match) { L.match.lastIndex = 0; if (!L.match.test(n)) continue; }
        if (!st.isFile()) { skipped++; continue; }
        if (!(now - newer(st) >= minAgeMs)) { skipped++; continue; }
        if (lockedFn(p)) { lockedHit = true; skipped++; continue; }
        if (!guard(p, base, true)) { skipped++; continue; }
        found.push(makeFinding({ kind: "file", path: p, label: p, bytes: st.size, safe: { ok: true }, basis: "vetted", oldEnough: true,
          locked: false, reason: L.reason, category: L.label }));
      }
      if (found.length) {
        items.push(...found);
        if (!allowedRoots.some((r) => nk(r) === nk(base))) allowedRoots.push(base);
      }
    }
    if (folders > 0) notes.push(`${L.label}: ${folders} folders ${ADMIN_FOLDER_NOTE}`);
    return skipped;
  }

  for (let li = 0; li < total; li++) {
    checkAbort();
    const L = locations[li];
    const minAgeMs = (Number.isFinite(L.minAgeHours) ? L.minAgeHours : 24) * HOUR;
    let skipped = 0;

    if (L.scope === "user" && admin) {
      // Ruling R41: an elevated process never walks the user's own (user-writable) folders: a same-user program could swap
      // a folder for a junction and turn an elevated delete into an arbitrary one. Listed only, never sized or offered.
      notes.push(`${L.label}: ${USER_IN_ADMIN_NOTE}`);
      for (const base of expandBase(L.base, vars, L.profile)) {
        let st;
        try { st = fs.lstatSync(base); } catch { continue; }
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        items.push(makeFinding({ kind: "dir", path: base, label: base, bytes: null, reportOnly: true, safe: { ok: false, reason: "report-only" },
          basis: "vetted", reason: L.reason, category: L.label }));
      }
    } else if (L.scope === "user") {
      if (/%SID%/.test(L.base) && !sid) notes.push(`${L.label}: not scanned (the account identity is unknown)`);
      const bases = partial ? [] : expandBase(L.base, vars, L.profile);
      for (const base of bases) {
        if (partial) break;
        let bst, names;
        const refuse = () => notes.push(`${L.label}: ${cleanText(base)} was not scanned (it is, or sits behind, a link or alias, or is a protected or excluded folder)`);
        try {
          bst = fs.lstatSync(base);
        } catch (err) {
          if (!err || err.code !== "ENOENT") refuse();   // a missing folder is simply nothing to clean
          continue;
        }
        try {
          if (bst.isSymbolicLink() || !bst.isDirectory()) { refuse(); continue; }
          if (nk(fs.realpathSync.native(base)) !== nk(base)) { refuse(); continue; }
          if (violatesRoots(base, roots) || excludedPaths.some((x) => within(base, x)) || userExcluded.some((x) => within(base, x))) { refuse(); continue; }
          names = fs.readdirSync(base);
        } catch { refuse(); continue; }

        const found = [];
        const consider = async (name, st, ageSt, checkAge) => {
          const p = path.join(base, name);
          const q = await qualify(p, st, bst.dev, minAgeMs, checkAge);
          return { p, name, st, ageSt, q };
        };

        if (L.pairing === "recycle") {
          const map = new Map();
          for (const n of names) {
            const m = n.match(/^\$([IR])(.+)$/i);
            if (!m) { skipped++; continue; }
            const rec = map.get(m[2]) || {};
            rec[m[1].toUpperCase()] = n;
            map.set(m[2], rec);
          }
          for (const [, rec] of map) {
            if (!(await tick())) { skipped++; break; }
            if (!rec.I || !rec.R) { skipped += (rec.I ? 1 : 0) + (rec.R ? 1 : 0); continue; }
            let ist, rst;
            try { ist = fs.lstatSync(path.join(base, rec.I)); rst = fs.lstatSync(path.join(base, rec.R)); } catch { skipped += 2; continue; }
            if (!ist.isFile() || ist.isSymbolicLink()) { skipped += 2; continue; }   // a $I record is always a plain file
            const qi = await qualify(path.join(base, rec.I), ist, bst.dev, minAgeMs, true);
            const qr = qi.ok ? await qualify(path.join(base, rec.R), rst, bst.dev, minAgeMs, false) : { ok: false };
            const ip = path.join(base, rec.I), rp = path.join(base, rec.R);
            if (!qi.ok || !qr.ok || !guard(ip, base) || !guard(rp, base)) { skipped += 2; continue; }
            const original = parseRecycleOriginal(ip);
            const rf = makeFinding({ kind: rst.isDirectory() ? "dir" : "file", path: rp, label: original ?? "(unknown original path)",
              bytes: qr.bytes, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false, reason: L.reason, category: L.label });
            const inf = makeFinding({ kind: "file", path: ip, label: "Recycle Bin record for " + (original ?? "(unknown original path)"),
              bytes: qi.bytes, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false, reason: L.reason, category: L.label,
              companionOf: rf.id });
            found.push(rf, inf);
          }
        } else {
          for (const n of names) {
            if (L.match) { L.match.lastIndex = 0; if (!L.match.test(n)) continue; }
            if (!(await tick())) { skipped++; continue; }
            let st;
            try { st = fs.lstatSync(path.join(base, n)); } catch { skipped++; continue; }
            if (L.match && !st.isFile()) { skipped++; continue; }
            // A database with a leftover "-journal" file next to it is mid-write or crashed: leave it alone.
            if (typeof L.skipIfSibling === "string" && fs.existsSync(path.join(base, n + L.skipIfSibling))) { skipped++; continue; }
            const c = await consider(n, st, st, true);
            if (!c.q.ok || !guard(c.p, base)) { skipped++; continue; }
            found.push(makeFinding({ kind: st.isDirectory() ? "dir" : "file", path: c.p, label: L.named === true ? L.label : c.p, bytes: c.q.bytes,
              safe: { ok: true }, basis: L.basis ?? "vetted", oldEnough: true, locked: false, reason: L.reason, category: L.category ?? L.label }));
          }
        }
        if (found.length) {
          items.push(...found);
          if (!allowedRoots.some((r) => nk(r) === nk(base))) allowedRoots.push(base);
        }
      }
    } else if (admin && L.adminCleanable === true && !L.needsStoppedService) {
      skipped += await adminLocation(L, minAgeMs);
    } else {
      // System locations are only ever reported (Phase 1, and in administrator mode the Windows Update cache and
      // other users' Recycle Bins), never offered for deletion. No service is ever stopped.
      if (admin && L.needsStoppedService) notes.push(`${L.label}: ${SERVICE_NOTE}`);
      else if (admin && L.id === "other-recycle") notes.push(`${L.label}: ${OTHER_USERS_NOTE}`);
      for (const base of expandBase(L.base, vars, L.profile)) {
        if (violatesRoots(base, roots)) continue;
        let bytes = null;
        try {
          const bst0 = fs.lstatSync(base);
          const kids = fs.readdirSync(base);
          bytes = 0;
          for (const k of kids) {
            if (L.id === "other-recycle" && sid && k.toLowerCase() === String(sid).toLowerCase()) continue;
            if (L.match && !L.match.test(k)) continue;
            const sz = measure(path.join(base, k), bst0.dev);
            if (sz === null) { bytes = null; break; }
            bytes += sz;
          }
        } catch { bytes = null; }
        const f = makeFinding({ kind: "dir", path: base, label: base, bytes, reportOnly: true, safe: { ok: false, reason: "report-only" },
          basis: "vetted", reason: L.reason, category: L.label });
        items.push(f);
        if (L.adminCleanable) { adminSeen = true; if (bytes !== null) adminKnown += bytes; }
      }
    }

    if (skipped > 0) {
      if (L.mergeNotes === true) mergedSkips.set(L.label, { n: (mergedSkips.get(L.label)?.n ?? 0) + skipped, hours: L.minAgeHours });
      else notes.push(`${L.label}: ${skipped} items skipped: in use, newer than ${L.minAgeHours} hours, links, or not fully checked`);
    }
    try { onProgress({ fraction: (li + 1) / total, label: L.label }); } catch { /* progress is best effort */ }
    await new Promise((r) => setImmediate(r));
  }
  checkAbort();
  for (const [label, m] of mergedSkips) notes.push(`${label}: ${m.n} items skipped: in use, newer than ${m.hours} hours, links, or not fully checked`);
  if (lockedNote && lockedHit) notes.push(String(lockedNote));
  if (partial) notes.push("The scan stopped early to stay within its time and size limit; some items were not checked.");

  return {
    kind: resultKind, target: null, items, allowedRoots, protectedPaths, notes,
    adminExtraBytes: !admin && adminSeen ? adminKnown : null, partial,
  };
}
