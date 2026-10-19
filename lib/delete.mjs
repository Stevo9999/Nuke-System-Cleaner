// lib/delete.mjs
// Permanent delete of exactly one selected item. Fails closed, never follows links, never throws.
import fs from "node:fs";
import path from "node:path";
import { checkPath, adminContentDirs, within } from "./safepath.mjs";
import { removeTreeGuarded } from "./delete-internal.mjs";
import { changedAfter } from "./age.mjs";
import { dirSize } from "./sizes.mjs";

export const ADMIN_FOLDER_REASON = "folders are not removed in administrator mode";
export const ADMIN_OUTSIDE_REASON = "in administrator mode only files directly inside an administrator folder are removed";
export const CHANGED_REASON = "changed since the scan";
export const CHANGED_PARTIAL_REASON = "changed while deleting; part of it was removed";
export const ADMIN_NESTED_REASON = "only files directly inside an administrator folder are removed";
export const DELETE_DEFAULTS = Object.freeze({ adminDirs: adminContentDirs });

const WIN = process.platform === "win32";
const nk = p => { const s = path.resolve(p); return WIN ? s.toLowerCase() : s; };

// Rulings R36/R41 (defence in depth), with or without the adminContents flag, on BOTH checks:
//   - a folder inside (or equal to) one of the administrator folders is never removed or walked;
//   - a file inside one of them is removed only when its parent IS one of them (never a nested file);
//   - files are removed as themselves (unlink: a link is removed, never followed).
// Returns a skip reason, or null when the path is fine. Throws (fails closed) if the list cannot be read.
// R41: with check.adminContents === true (administrator mode) a path outside every administrator folder is refused too.
export function adminProblem(v, adminDirs = DELETE_DEFAULTS.adminDirs, adminContents = false) {
  const dirs = adminDirs();
  if (!Array.isArray(dirs) || !dirs.every(d => typeof d === "string" && path.isAbsolute(d))) throw Object.assign(new Error("GUARD_UNRESOLVED"), { code: "GUARD_UNRESOLVED" });
  if (!dirs.some(a => within(v.resolved, a))) return adminContents === true ? ADMIN_OUTSIDE_REASON : null;
  if (v.isDir) return ADMIN_FOLDER_REASON;
  return dirs.some(a => nk(path.dirname(v.resolved)) === nk(a)) ? null : ADMIN_NESTED_REASON;
}

// `hooks.adminDirs` / `hooks.lstat` exist for tests; server.mjs passes only { notAfterMs } (its trusted scan-start option).
// Overlapping selections ordered child-first would leave the PARENT reported as changed (removing the child updates the parent's
// mtime beyond the tolerance); that fails safe (the parent is kept whole). server.mjs therefore deletes the shallowest paths first.
export function removeItem(target, check, { adminDirs = DELETE_DEFAULTS.adminDirs, notAfterMs, lstat } = {}) {
  const adminMode = !!check && check.adminContents === true;
  let label = typeof target === "string" ? target : String(target);
  if (typeof target === "string" && target.length > 0 && !target.includes("\0")) label = path.resolve(target);
  const skip = v => ({ path: label, status: "skipped", reason: v.reason === "does not exist" ? "already gone" : v.reason, bytes: 0 });
  try {
    if (notAfterMs !== undefined && !(typeof notAfterMs === "number" && Number.isFinite(notAfterMs))) throw Object.assign(new Error("BAD_OPTION"), { code: "BAD_OPTION" });
    let v = checkPath(target, check);
    if (!v.ok) return skip(v);
    label = v.resolved;
    let why = adminProblem(v, adminDirs, adminMode);
    if (why) return { path: v.resolved, status: "skipped", reason: why, bytes: 0 };
    const bytes = dirSize(v.resolved);
    // Re-validate immediately before deleting (narrows the check/delete window).
    v = checkPath(target, check);
    if (!v.ok) return skip(v);
    why = adminProblem(v, adminDirs, adminMode);
    if (why) return { path: v.resolved, status: "skipped", reason: why, bytes: 0 };
    try {
      if (v.isDir) removeTreeGuarded(v.resolved, check, { adminDirs, ...(notAfterMs !== undefined ? { notAfterMs } : {}), ...(lstat ? { lstat } : {}) });
      else {
        if (notAfterMs !== undefined && changedAfter(fs.lstatSync(v.resolved), notAfterMs)) return { path: v.resolved, status: "skipped", reason: CHANGED_REASON, bytes: 0 };
        fs.unlinkSync(v.resolved);
      }
      return { path: v.resolved, status: "deleted", bytes };
    } catch (e) {
      if (e && e.code === "CHANGED") return { path: v.resolved, status: "skipped", reason: CHANGED_REASON, bytes: 0 };
      if (e && e.code === "CHANGED_PARTIAL") { // found changed while deleting: earlier entries are already gone, so report what was really freed
        let left = bytes; try { left = dirSize(v.resolved); } catch { /* keep: report nothing freed */ }
        return { path: v.resolved, status: "failed", reason: CHANGED_PARTIAL_REASON, bytes: Math.max(0, bytes - left) };
      }
      return { path: v.resolved, status: "failed", reason: String((e && e.code) || e), bytes: 0 };
    }
  } catch (e) {
    return { path: label, status: "failed", reason: String((e && e.code) || e), bytes: 0 };
  }
}
