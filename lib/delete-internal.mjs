// lib/delete-internal.mjs
// Tree deletion primitive. It does NOT call checkPath: only lib/delete.mjs (after checkPath) and
// tests may import it. Not part of the public API.
import fs from "node:fs";
import path from "node:path";
import { within, canonicalForms, adminContentDirs } from "./safepath.mjs";
import { changedAfter } from "./age.mjs";
import { runSync, runAsync } from "./cooperative.mjs";

const WIN = process.platform === "win32";
const nk = p => { const s = path.resolve(p); return WIN ? s.toLowerCase() : s; };
const fail = code => Object.assign(new Error(code), { code });
export const TREE_DEFAULTS = Object.freeze({ adminDirs: adminContentDirs });

// Remove a link itself. Never recursive, so the target is untouched.
// (Node reports Windows junctions as symlinks; rmdirSync on a junction removes only the junction.)
function unlinkLink(p) {
  try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
}

// A directory is only read/descended into if it is a real directory, on the same volume as the
// top, whose canonical path equals its own path. This catches reparse points that lstat reports
// as plain directories (volume-GUID junctions, mount points).
// Ruling R36 (defence in depth): a folder inside one of the administrator folders (C:\Windows\Temp and the others) is
// never read or descended into, whatever the caller says; only their direct-child files are ever removed (by delete.mjs).
function assertSafeDir(dir, ctx) {
  if (ctx.adminDirs.some(a => within(dir, a))) throw fail("ADMIN_FOLDER");
  const st = ctx.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw fail("NOT_PLAIN_DIR");
  if (st.dev !== ctx.rootDev) throw fail("CROSS_VOLUME");
  if (nk(ctx.realpath(dir)) !== nk(dir)) throw fail("ALIAS");
}

// Age re-check (release gate): an entry whose newer-of(mtime, birthtime) is later than the scan's start time changed after the
// user saw the scan. Pass 1 refuses the whole tree on the first such entry (so nothing is removed); pass 2 re-checks each
// file just before it is unlinked.
// (lib/age.mjs holds the comparison and its small clock-skew tolerance.)
const young = (st, ctx) => ctx.notAfterMs !== null && changedAfter(st, ctx.notAfterMs);

// A generator: it yields between entries (no check is skipped or reordered); runSync / runAsync (lib/cooperative.mjs) drive it.
function* walk(dir, ctx, doDelete) {
  assertSafeDir(dir, ctx);
  for (const name of fs.readdirSync(dir)) {
    const child = path.join(dir, name);
    if (ctx.guard.some(g => within(child, g) || within(g, child))) throw fail("GUARDED");
    const st = ctx.lstat(child);
    if (!doDelete && young(st, ctx)) throw fail("CHANGED");
    if (st.isSymbolicLink()) { if (doDelete) unlinkLink(child); }
    else if (st.isDirectory()) { if (ctx.adminDirs.some(a => within(child, a))) throw fail("ADMIN_FOLDER"); yield* walk(child, ctx, doDelete); }
    else if (doDelete) { if (young(ctx.lstat(child), ctx)) throw fail("CHANGED_PARTIAL"); fs.unlinkSync(child); } // earlier siblings may already be gone
    yield;
  }
  // re-check just before removing the (now empty) directory itself
  if (doDelete) { assertSafeDir(dir, ctx); fs.rmdirSync(dir); }
}

/**
 * Delete the tree at `dir`. Pass 1 validates the whole tree (read-only); pass 2 deletes.
 * Throws (code) on anything unexpected; the caller turns that into a "failed" result.
 * `hooks.notAfterMs` (the scan start time, from the trusted server option) refuses any entry changed after it.
 * `hooks.lstat` / `hooks.realpath` / `hooks.adminDirs` exist for tests.
 */
export function* removeTreeSteps(dir, check, hooks) {
  const lstat = hooks.lstat || (p => fs.lstatSync(p));
  const realpath = hooks.realpath || (p => fs.realpathSync.native(p));
  let guard, adminDirs;
  try { guard = [...(check.protectedPaths || []), ...(check.livePaths || [])].flatMap(canonicalForms); }
  catch { throw fail("GUARD_UNRESOLVED"); }
  try { adminDirs = (hooks.adminDirs || TREE_DEFAULTS.adminDirs)(); } catch { throw fail("GUARD_UNRESOLVED"); }
  if (!Array.isArray(adminDirs) || !adminDirs.every(d => typeof d === "string" && path.isAbsolute(d))) throw fail("GUARD_UNRESOLVED");
  let notAfterMs = null;
  if (hooks.notAfterMs !== undefined) {
    if (typeof hooks.notAfterMs !== "number" || !Number.isFinite(hooks.notAfterMs)) throw fail("BAD_OPTION");
    notAfterMs = hooks.notAfterMs;
  }
  const top = lstat(dir);
  const ctx = { lstat, realpath, guard, adminDirs, rootDev: top.dev, notAfterMs };
  if (young(top, ctx)) throw fail("CHANGED");
  yield* walk(dir, ctx, false);
  yield* walk(dir, ctx, true);
}

export function removeTreeGuarded(dir, check, hooks = {}) { return runSync(removeTreeSteps(dir, check, hooks)); }
// Same checks in the same order; hands the event loop back every few entries (the server runs inside the Electron main process).
export function removeTreeGuardedAsync(dir, check, hooks = {}) { return runAsync(removeTreeSteps(dir, check, hooks)); }

