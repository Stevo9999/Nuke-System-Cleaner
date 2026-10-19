// lib/safepath.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WIN = process.platform === "win32";
const norm = p => (WIN ? p.toLowerCase() : p);
const no = reason => ({ ok: false, reason });

export function within(child, parent) {
  const rel = path.relative(norm(path.resolve(parent)), norm(path.resolve(child)));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

// Computed at call time (not import time) and never dependent on env vars alone.
function systemDirs() {
  const dirs = WIN
    ? [process.env.SystemRoot, process.env.windir, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData,
       "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"]
    : ["/etc", "/usr", "/bin", "/sbin", "/var", "/boot", "/lib", "/System"];
  return dirs.filter(d => typeof d === "string" && d.length > 0);
}

// Canonical form of a path: realpath if it exists, otherwise the canonical form of the
// nearest existing parent joined with the remainder. Throws on any error other than ENOENT/ENOTDIR.
function canon(p) {
  const abs = path.resolve(p);
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
        const parent = path.dirname(cur);
        if (parent === cur) return abs;
        tail.push(path.basename(cur));
        cur = parent;
      } else throw e;
    }
  }
}

const isStr = s => typeof s === "string" && s.length > 0;
const validList = l => Array.isArray(l) && l.every(s => isStr(s) && path.isAbsolute(s) && !s.includes("\0"));
// Lexical and canonical forms, de-duplicated.
const forms = p => [...new Set([path.resolve(p), canon(p)])];

/**
 * Decide whether `raw` may be permanently deleted. Never throws; bad options refuse.
 *
 * Caveats for the deleter:
 *  - isDir:true vouches only for the folder itself. Links (junctions/symlinks) inside it are
 *    not vouched for, so the deleter must unlink them and never follow them.
 *  - There is a gap between this check and the delete (TOCTOU). Mitigate it by re-running
 *    checkPath immediately before each individual delete.
 */
export function checkPath(raw, opts) {
  return gate(raw, opts, adminContentDirs);
}

/**
 * Administrator content exception. Phase 1b only; the list is fixed here, callers cannot widen it.
 * Only the CONTENTS of these four folders, never the folders themselves, and only when the fixed
 * bases are canonically the same folders as %SystemRoot% and %ProgramData% (any mismatch or error -> []).
 * Computed at call time.
 */
const ADMIN_WINDOWS = "C:\\Windows", ADMIN_PROGRAMDATA = "C:\\ProgramData";
export function adminContentDirs() { return adminDirsFor(ADMIN_WINDOWS, ADMIN_PROGRAMDATA); }
function adminDirsFor(w, pd) {
  try {
    // env values are vetted as strings first: never canonicalise a relative, UNC or device path (no SMB).
    const same = (fixed, env) => WIN && isStr(env) && !env.includes("\0") && path.isAbsolute(env) && !/^[\\/]{2}/.test(env)
      && norm(canon(fixed)) === norm(canon(env));
    if (!same(w, process.env.SystemRoot) || !same(pd, process.env.ProgramData)) return [];
    const wer = path.join(pd, "Microsoft", "Windows", "WER");
    return [path.join(w, "Temp"), path.join(w, "Minidump"), path.join(wer, "ReportArchive"), path.join(wer, "ReportQueue")];
  } catch { return []; }
}
// Lexical AND canonical forms strictly inside (never equal to) the same listed folder, and that
// folder must itself be canonical (not reached through a junction, symlink or 8.3 alias).
// Each entry fails closed on its own (an unreadable listed folder must not disable the others).
function adminContentOk(resolved, dirs) {
  const inside = (c, d) => norm(c) !== norm(d) && within(c, d);
  return dirs.some(d => {
    try { return inside(resolved, d) && norm(canon(d)) === norm(d) && inside(canon(resolved), d); } catch { return false; }
  });
}
// Tests only: the same gate with temp-folder stand-ins for C:\Windows and C:\ProgramData. The env
// must still match them. server.mjs and lib/delete.mjs import checkPath only (a test enforces this).
export function adminGateForTests({ windowsDir, programDataDir }) {
  const dirs = () => adminDirsFor(windowsDir, programDataDir);
  return { adminContentDirs: dirs, checkPath: (raw, opts) => gate(raw, opts, dirs) };
}

function gate(raw, opts, adminDirs) {
  try {
    if (!opts || typeof opts !== "object") return no("bad options");
    const { allowedRoots, protectedPaths = [], livePaths = [] } = opts;
    if (!Array.isArray(allowedRoots) || allowedRoots.length === 0 || !validList(allowedRoots)) return no("bad options");
    if (!validList(protectedPaths) || !validList(livePaths)) return no("bad options");

    if (typeof raw !== "string" || raw.length === 0) return no("not a path");
    if (raw.includes("\0")) return no("NUL byte");
    if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return no("parent segment");
    if (WIN && /^[\\/]{2}/.test(raw)) return no("UNC or device path");
    if (WIN && raw.slice(2).includes(":")) return no("alternate data stream");
    const odd = suspiciousPathForm(raw); // per segment: a trailing dot or space on ANY segment (Win32 strips them)
    if (odd) return no(odd);

    const resolved = path.resolve(raw);
    if (path.parse(resolved).root === resolved) return no("drive root");
    if (within(os.homedir(), resolved)) return no("home folder or a parent of it");
    if (systemDirs().some(s => within(resolved, s))
      && !(opts.adminContents === true && adminContentOk(resolved, adminDirs()))) return no("system folder");

    let roots, prot, live;
    try {
      roots = allowedRoots.flatMap(forms);
      prot = protectedPaths.flatMap(forms);
      live = livePaths.flatMap(forms);
    } catch { return no("cannot canonicalise options"); }

    const inRoot = roots.some(r => norm(r) !== norm(resolved) && within(resolved, r));
    if (!inRoot) return no("outside allowed roots");
    if (prot.some(p => within(resolved, p) || within(p, resolved))) return no("protected (or contains a protected item)");
    if (live.some(p => within(resolved, p) || within(p, resolved))) return no("live session");

    let st;
    try { st = fs.lstatSync(resolved); } catch { return no("does not exist"); }
    if (st.isSymbolicLink()) return no("symlink or junction");
    let real;
    try { real = fs.realpathSync.native(resolved); } catch { return no("cannot resolve"); }
    if (norm(real) !== norm(resolved)) return no("a parent folder is a link or alias");
    // The canonical path must also respect protected/live entries (belt and braces).
    if (prot.some(p => within(real, p) || within(p, real))) return no("protected (or contains a protected item)");
    if (live.some(p => within(real, p) || within(p, real))) return no("live session");
    return { ok: true, resolved, isDir: st.isDirectory() };
  } catch {
    return no("bad options");
  }
}

// Lexical and canonical forms of a path (throws if it cannot be canonicalised).
export const canonicalForms = forms;

/**
 * Vet a directory argument (root, claude dir, scratch dir) BEFORE anything touches it on disk.
 * String checks run first (UNC/device forms are refused before any filesystem call, so no SMB access).
 * Then the nearest existing ancestor is canonicalised (junctions, symlinks, 8.3 names) and the
 * drive-root / home / parent-of-home / system-folder checks run on BOTH the lexical and canonical forms.
 * `home` is injectable for tests. Returns a reason string if unacceptable, otherwise null.
 */
export function dirArgProblem(raw, { home = os.homedir() } = {}) {
  if (typeof raw !== "string" || raw.length === 0) return "not a path";
  if (raw.includes("\0")) return "NUL byte";
  if (/^[\\/]{2}/.test(raw)) return "UNC or device path";
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return "parent segment";
  if (!path.isAbsolute(raw)) return "not absolute";
  if (WIN && raw.slice(2).includes(":")) return "alternate data stream";
  if (/[. ]([\\/]|$)/.test(raw)) return "trailing dot or space";
  let candidates, homes, sys;
  try {
    candidates = forms(raw);
    homes = forms(home);
    sys = systemDirs().flatMap(forms);
  } catch { return "cannot canonicalise"; }
  for (const c of candidates) {
    if (path.parse(c).root === c) return "drive root";
    if (homes.some(h => within(h, c))) return "home folder or a parent of it";
    if (sys.some(s => within(c, s))) return "system folder";
  }
  return null;
}

/**
 * Shared lexical pre-check for path strings: returns a reason if the raw form is suspicious (not a string,
 * NUL, UNC/device prefix, ".." segment, not absolute, alternate data stream, or any segment ending in a dot
 * or space), otherwise null. Callers that must fail closed treat a reason as a violation.
 */
export function suspiciousPathForm(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "not a path";
  if (raw.includes("\0")) return "NUL byte";
  if (/^[\\/]{2}/.test(raw)) return "UNC or device path";
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return "parent segment";
  if (!path.isAbsolute(raw)) return "not absolute";
  if (WIN && raw.slice(2).includes(":")) return "alternate data stream";
  if (/[. ]([\\/]|$)/.test(raw)) return "trailing dot or space";
  return null;
}
