// app/main/controller.mjs
// The main process's decision maker behind the IPC handlers (one method per channel, see ipc.mjs).
// Safety rules owned here:
//   - one operation at a time ("busy");
//   - the renderer only sends ids; every id is re-checked against THIS controller's last scan (selectable, known group and
//     confidence, path present, not a protected root), companions are added here, and anything odd refuses the whole request;
//   - the selection is frozen and hashed by the engine (buildSelection), re-validated on disk (revalidate), and only then
//     handed to the one-shot server (startRun) with adminContents = (identity.elevated === true), a strict boolean;
//   - Phase 1b, Rulings R36/R41: elevated, ONLY items of kind "file" whose parent folder is exactly one of the administrator
//     folders (adminContentDirs) are accepted (no per-user items, no folders, no subfolders) and investigate scans are not
//     run; standard mode refuses anything under an administrator folder;
//   - adminRelaunch: refused when already elevated or busy; the relaunch itself (UAC) is done by main through `relaunch`;
//   - the one-time url (it carries the token) goes to ui.openRitual and nowhere else: it is not kept, logged or sent;
//   - errors ("busy" is BUSY_MESSAGE): calls from the MAIN window report through ONE channel, the phase event ({ phase: "error", detail: fixed text })
//     and then resolve { ok: false }; calls from the RESULTS window (scanAgain, delete refusals, results:get) reject with a
//     fixed message ("busy", "refused" or GENERIC_ERROR) that its own error line shows. No error text from the engine, the
//     file system or a scan ever reaches a renderer (it can contain paths).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadSettings, saveSettings, appProtectedRoots, rootsViolationChecker, readExclusions, saveExclusions, addExclusion, exclusionId, exclusionMatcher } from "./appdata.mjs";
import { toView, diffScans, fmtBytes, displayText } from "./view-model.mjs";
import { buildSelection, revalidateAsync, startFrozenRun } from "../../run.mjs";
import { yieldNow } from "../../lib/cooperative.mjs";
import { createRestorePoint, RESTORE_MESSAGES, TIMEOUT_MESSAGE, STOPPED_MESSAGE } from "../../lib/restore.mjs";
import { adminContentDirs, within } from "../../lib/safepath.mjs";
import { isLocked as fileIsLocked } from "../../lib/smartscan.mjs";
import { changedAfter } from "../../lib/age.mjs";
import { listPrograms, parseUninstallCommand, leftoverTarget, programRow } from "../../lib/programs.mjs";
import { neverTouchPath } from "../../lib/never-touch.mjs";
import { runUninstaller } from "../../lib/uninstall-run.mjs";
import { detectAppForFolder, rebootAssessment, mergeInvestigations, EXIT_REBOOT_INITIATED } from "../../lib/app-folder.mjs";
import { listWindowsApps, removeWindowsApp } from "../../lib/winapps.mjs";
import { toolList, openTool, isToolKey } from "../../lib/wintools.mjs";

export const GENERIC_ERROR = "Something went wrong. Please try again.";
export const BUSY_MESSAGE = "Another operation is still running. Please wait.";
export const RELAUNCH_TIMEOUT_MESSAGE = "The administrator prompt did not finish.";
export const RELAUNCH_CANCELLED_MESSAGE = "Administrator mode was not started: the Windows prompt was cancelled.";
export const IDENTITY_UNKNOWN_MESSAGE = "Could not tell whether this app is running as administrator, so deleting is turned off.";
export const ADMIN_INVESTIGATE_MESSAGE = "Investigating a program or folder is not available in administrator mode. Close this window and use standard mode for your own files.";
export const ADMIN_BROWSERS_MESSAGE = "The Browsers cleaner is not available in administrator mode. Close this window and use standard mode for your own files.";
const ID_RE = /^[0-9a-f]{16}$/;
const SID_USER = /^S-1-5-21(-\d+){4}$/;
const MAX_IDS = 5000;
const TERMINAL = new Set(["done", "aborted", "expired", "failed"]);
const SELECTABLE_GROUPS = new Set(["exclusive", "shared"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const AUDIT_TAIL_BYTES = 16 * 1024 * 1024;

const TEXT = Object.freeze({
  scanFailed: "The scan could not be completed. Nothing was changed.",
  nothingFound: "Scan finished. Nothing was found.",
  review: "Scan finished.",
  stopped: "Stopped. Nothing was deleted.",
  cancelled: "Cancelled. Nothing was deleted.",
  expired: "The app closed the confirmation automatically. Nothing was deleted.",
  aborted: "The run was stopped before anything was deleted.",
  changed: "Some selected items changed or are no longer safe to delete since the scan. Nothing was deleted. Please scan again.",
  startFailed: "The delete step could not be started. Nothing was deleted.",
  ritualFailed: "The confirm window could not be opened. Nothing was deleted.",
  failed: "The delete step stopped with an error. Some items may already be gone; the rest were not touched.",
  listFailed: "The list could not be read.",
  uninstallFailed: "The uninstaller could not be run. Nothing was changed.",
  uninstallDone: "The uninstaller finished. No install folder was known, so no leftover scan was run.",
  uninstallStopped: "Stopped waiting. The uninstaller may still be running on its own; this app did not look for leftovers and deleted nothing.",
  stoppedAfterUninstall: "Stopped after the uninstaller. No leftover scan was run and nothing was deleted.",
  gone: "The uninstaller finished and the folder is gone. Re-check: nothing left.",
  appRemoved: "The app was removed for your account.",
  appFailed: "The app could not be removed. Nothing was changed.",
  doneNoAudit: "Finished. The details could not be read from the log, so the number of items and the freed space are not shown.",
});

class Refusal extends Error {}
const refused = () => new Refusal("refused");
const busyError = () => new Refusal(BUSY_MESSAGE);
const safeError = e => (e instanceof Refusal ? e : new Error(GENERIC_ERROR));
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

// Every JSON line of runDir\nuke-audit.log whose runId matches, read from a bounded tail of the file (this run's lines
// are the newest, so a long-lived log never stops a finished run from being reported). Odd lines are skipped.
export function readAuditLines(runDir, runId, { maxBytes = AUDIT_TAIL_BYTES } = {}) {
  let fd;
  try {
    const file = path.join(runDir, "nuke-audit.log");
    const st = fs.lstatSync(file);
    if (!st.isFile()) return [];
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, "r");
    let got = 0;
    while (got < len) { const n = fs.readSync(fd, buf, got, len - got, st.size - len + got); if (n <= 0) break; got += n; }
    let text = buf.toString("utf8", 0, got);
    if (len < st.size) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && typeof o === "object" && o.runId === runId) out.push(o); } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

function doneSummary(lines) {
  const done = [...lines].reverse().find(l => l && l.state === "done");
  if (!done) return null;
  const results = Array.isArray(done.results) ? done.results : [];
  const count = s => results.filter(r => r && r.status === s).length;
  const measured = done.measured === true;
  const freedBytes = Number.isFinite(done.freedBytes) && done.freedBytes >= 0 ? done.freedBytes : 0;
  return { deleted: count("deleted"), failed: count("failed"), skipped: count("skipped"), freedBytes, measured };
}

function doneText(s) {
  const parts = [plural(s.deleted, "item deleted", "items deleted")];
  if (s.failed) parts.push(s.failed + " could not be deleted");
  if (s.skipped) parts.push(s.skipped + " skipped");
  return parts.join(", ") + ". " + (s.measured ? "Free space went up by " + fmtBytes(s.freedBytes) + " (measured from the drive; it can be a little off if other programs were using the disk at the same time)." : "The freed space could not be measured.");
}

export function createController({
  ui, paths, identity, runScan, restore = createRestorePoint, startRun = startFrozenRun, protectedPaths = [],
  protectedRoots = appProtectedRoots(), readAudit = readAuditLines, pollMs = 500, relaunch = null, adminDirs = adminContentDirs,
  profileRoot = null, // R45: main passes the user's profile folder; null/invalid => investigate items are refused (fail closed)
  isLocked = fileIsLocked,
  readPrograms = null, // () => listPrograms(regQuery): main passes it; null => the program list is unavailable
  runProgramUninstaller = runUninstaller,
  readApps = listWindowsApps,
  removeApp = removeWindowsApp,
  readPendingRenames = null, // () => regQuery("pendingRenames"): read-only restart check; null => only the exit code counts
  startTool = openTool, // (key) => Promise<{ ok }>: launches one built-in Windows tool from the fixed list in lib/wintools.mjs
} = {}) {
  // Ruling R44: only a real boolean counts. Anything else (null from readIdentity, missing, odd) is "unknown": scans still
  // run (read-only, in their standard form) but delete is refused. `elevated` itself stays a strict boolean.
  const identityKnown = !!identity && typeof identity.elevated === "boolean";
  const elevated = identityKnown && identity.elevated === true;
  // R46: the relauncher (makeRelaunchElevated) sets .allowed === true only for a packaged app under C:\Program Files.
  const relaunchOffered = () => identityKnown && !elevated && typeof relaunch === "function" && relaunch.allowed === true;
  const nk = p => { const s = path.resolve(p); return process.platform === "win32" ? s.toLowerCase() : s; };
  // R36 + R41 (layer 2). Fails closed: an unreadable list refuses the item.
  //   standard mode: nothing under an administrator folder;
  //   administrator mode: ONLY files directly inside an administrator folder (no per-user items, no folders, no nesting).
  // `dirs` = the administrator folders, read ONCE per operation by the caller (null when unreadable: fail closed).
  function adminItemOk(it, dirs) {
    if (!Array.isArray(dirs) || !dirs.every(d => typeof d === "string" && path.isAbsolute(d))) return false;
    const under = dirs.some(d => within(it.path, d));
    if (!elevated) return !under;
    return under && it.kind === "file" && dirs.some(d => nk(path.dirname(it.path)) === nk(d)) && !dirs.some(d => nk(it.path) === nk(d));
  }
  // R45 (standard mode): picked / investigated items must lie inside the user's profile; another account could redirect an
  // automatic delete of anything else. Smart Scan results keep their own location rules.
  function profileOk(it) {
    if (!last || !last.request) return false; // fail closed
    if (last.request.kind === "smart") return true; // (the Browsers cleaner is a different kind: it needs the profile check below)
    // Fail closed: an investigate item needs a valid absolute profile root, and the root itself is never an item.
    if (typeof profileRoot !== "string" || profileRoot.length === 0 || !path.isAbsolute(profileRoot)) return false;
    try { return within(it.path, profileRoot) && nk(it.path) !== nk(profileRoot); } catch { return false; }
  }
  // Hard never-touch list (lib/never-touch.mjs): Windows folders, Program Files, other accounts, account secrets. Checked when a
  // selection is made and again on the frozen paths at delete time. Only the four administrator folders are let through, and
  // only in administrator mode (adminItemOk still limits those to direct-child files).
  // The checks that need the disk or the administrator folders are prepared once per operation (not once per item):
  // thousands of items must not make the main process re-resolve the same roots thousands of times.
  const readAdminDirs = () => { try { return adminDirs(); } catch { return null; } };
  const guardsNow = () => {
    const dirs = readAdminDirs();
    const violates = rootsViolationChecker(protectedRoots);
    const neverTouch = p => {
      if (elevated && dirs === null) return "unreadable";
      return neverTouchPath(p, { profile: profileRoot, allowedAdminDirs: elevated && Array.isArray(dirs) ? dirs : [] });
    };
    return { dirs, violates, neverTouch };
  };
  // The account SID is derived here from the identity read at startup; nothing from a renderer can set it.
  const sid = identity && typeof identity.sid === "string" && SID_USER.test(identity.sid) ? identity.sid : null;
  const appProtected = Array.isArray(protectedPaths) ? protectedPaths.filter(p => typeof p === "string") : [];
  // The built-in protected list keeps your personal folders (Desktop, Documents, Pictures, Music, Videos, Downloads, OneDrive, ...)
  // out of every scan. When YOU pick one file or folder by hand INSIDE one of them, that folder no longer blocks the pick: only the
  // protected folders that strictly contain the picked item are dropped for that investigation. The folder itself, and any other
  // protected folder, stay protected; your own never-touch folders (Settings) are never dropped.
  // A guided folder run may also carry `also` (the app's install folder); the same rule applies to each of the two targets.
  const targetsOf = request => [request.target, request.also].filter(t => typeof t === "string" && path.isAbsolute(t));
  const protectedFor = request => {
    if (!request || request.kind !== "investigate" || typeof request.target !== "string" || !path.isAbsolute(request.target)) return appProtected;
    const targets = targetsOf(request);
    return appProtected.filter(q => targets.every(tg => { try { const n = nk(q); return !(nk(tg) !== n && within(tg, q)); } catch { return true; } }));
  };

  let programById = new Map(); // id -> program entry (kept here; a renderer only ever holds the id)
  let appById = new Map();
  let busy = null;          // null | "scan" | "pick" | "delete"
  let scanAbort = null;     // AbortController of the running scan
  let uninstallAbort = null; // AbortController of the "Stop waiting" for a running uninstaller (it is never killed)
  let restoreAbort = null; // AbortController of the running restore point step ("Stop waiting")
  let last = null;          // { request, result, diff, scanStartMs }
  let ritualCtx = null;     // { server, close } while the embedded confirmation page is up (for ritualCancel)
  let currentRun = null;    // the started run while a delete is in progress (for isDeleting)
  let generation = 0;       // bumped by results:close; a scan that finishes under an older generation is dropped

  // Apps whose removal still needs a Windows restart. Notice only: this app never restarts Windows.
  const restartApps = [];
  const noteRestart = name => { const n = displayText(name, 60) || "the program"; if (!restartApps.includes(n)) restartApps.push(n); };
  const restartNotice = () => restartApps.length ? "Restart Windows when you are ready to finish removing " + restartApps.slice(0, 5).join(", ") + (restartApps.length > 5 ? " and others" : "") + "." : null;
  const phase = p => {
    const notice = restartNotice();
    try { ui.sendPhase(notice ? { ...p, notice } : p); } catch { /* window gone */ }
  };
  const progress = p => {
    try {
      const fraction = p && typeof p.fraction === "number" && Number.isFinite(p.fraction) ? Math.min(1, Math.max(0, p.fraction)) : null;
      const label = p && typeof p.label === "string" ? p.label.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").slice(0, 120) : "";
      ui.sendProgress({ fraction, label });
    } catch { /* window gone */ }
  };
  const take = kind => { if (busy) throw busyError(); busy = kind; };

  // Exclusions (the user's never-touch list): folders the user said this app must never touch, read from settings.json each time they
  // matter. An unreadable settings file means the list is unknown, so the operation fails closed (throws).
  function exclusionsNow() {
    const r = readExclusions(paths.settingsFile);
    if (!r.ok) throw new Error("exclusions unknown");
    return r.list;
  }
  const exclusionRows = list => list.map(p => ({ id: exclusionId(p), path: displayText(p, 260) }));

  function argsFor(request, excl, target = request.target) {
    if (request.kind === "startup") return {};
    if (request.kind === "browsers") return { protectedPaths: excl };
    return request.kind === "smart" ? (elevated ? { sid, elevated: true, protectedPaths: excl } : { sid, protectedPaths: excl })
      : { target, protectedPaths: [...protectedFor({ kind: "investigate", target }), ...excl] };
  }

  async function scan(request) {
    const ac = new AbortController();
    scanAbort = ac;
    try {
      const excl = exclusionsNow();
      let result = await runScan(request.kind, argsFor(request, excl), { onProgress: progress, signal: ac.signal });
      // A guided folder run also looks at the app's install folder: a second ordinary investigate scan, merged by finding id.
      if (request.kind === "investigate" && typeof request.also === "string" && goodResult(result)) {
        const second = await runScan("investigate", argsFor(request, excl, request.also), { onProgress: progress, signal: ac.signal });
        if (!goodResult(second)) throw new Error("bad result");
        result = mergeInvestigations(result, second);
      }
      // Second layer, in main: whatever the worker returned, nothing at, inside or around an excluded folder is ever shown.
      if (!goodResult(result) || excl.length === 0) return result;
      const hit = exclusionMatcher(excl);
      return { ...result, items: result.items.filter(it => !(it && typeof it.path === "string" && hit(it.path))) };
    } finally { if (scanAbort === ac) scanAbort = null; }
  }
  const isAbort = e => !!e && (e.name === "AbortError" || e.code === "ABORT_ERR");
  const goodResult = r => !!r && typeof r === "object" && Array.isArray(r.items);

  // A new scan from the main window. Reports through phases and resolves.
  async function newScan(request, { lead = "" } = {}) {
    last = null;
    const gen = generation;
    phase({ phase: "scanning" });
    let result;
    const scanStartMs = Date.now(); // trusted delete-time age limit: nothing changed after this moment is deleted
    try {
      result = await scan(request);
      if (!goodResult(result)) throw new Error("bad result");
    } catch (e) {
      if (gen !== generation) return { ok: false, cancelled: true };
      if (isAbort(e)) { phase({ phase: "idle" }); return { ok: false, cancelled: true }; }
      phase({ phase: "error", detail: TEXT.scanFailed });
      return { ok: false };
    }
    if (gen !== generation) return { ok: false, cancelled: true };
    last = { request, result, diff: null, scanStartMs };
    const rows = toView(result).rows.length;
    if (rows > 0) { try { ui.showResults(); } catch { /* window could not open */ } }
    phase({ phase: "results", detail: (lead ? lead + " " : "") + (rows > 0 ? TEXT.review : TEXT.nothingFound) });
    return { ok: true, count: rows };
  }

  async function picked(pick, { guided = false } = {}) {
    // R41: an elevated process never investigates (walks) the user's own, user-writable folders.
    if (elevated) { phase({ phase: "error", detail: ADMIN_INVESTIGATE_MESSAGE }); return { ok: false }; }
    take("pick");
    let target = null;
    try { target = await pick(); } catch { target = null; }
    busy = null;
    if (typeof target !== "string" || !target) { phase({ phase: "idle" }); return { ok: false, cancelled: true }; }
    take("scan");
    try { return guided ? await guidedFolder(target) : await newScan({ kind: "investigate", target }); } finally { busy = null; }
  }

  const isDir = p => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
  const cmdText = c => c.exe + (c.args ? " " + c.args : "");

  // The guided "pick a folder" flow (standard mode only). Order, fixed: detect (read-only) -> ASK -> uninstaller -> restart check ->
  // (ASK) -> leftover scan -> results screen. Nothing here deletes anything: deleting stays behind the results screen's Delete
  // button and the warning / restore point / key steps of deleteFlow.
  async function guidedFolder(target) {
    const plain = lead => newScan({ kind: "investigate", target }, { lead });
    if (typeof readPrograms !== "function") return plain("");
    phase({ phase: "scanning" });
    let list = null;
    try { list = await readPrograms(); } catch { list = null; }
    if (!list || list.ok !== true || !Array.isArray(list.programs)) return plain(""); // list incomplete: no uninstaller is offered (fail closed)
    const det = detectAppForFolder(list.programs, target);
    if (det.kind === "none") return plain("");
    if (det.kind === "several") {
      const names = det.programs.slice(0, 3).map(p => displayText(p.name, 40)).join(", ") + (det.programs.length > 3 ? " and others" : "");
      return plain("Several installed programs match this folder (" + names + "), so no uninstaller was offered. Only leftovers are listed.");
    }
    const app = displayText(det.program.name, 80) || "the program";
    if (!det.runnable) return plain("This folder belongs to " + app + ", but its uninstall command cannot be read exactly, so it is not run from here. Only leftovers are listed.");
    // ASK FIRST: before anything is run, scanned or deleted.
    let yes = false;
    try { yes = (await ui.askUninstallFirst("This folder belongs to " + app + ". Run its own uninstaller first? It will run: " + cmdText(det.command) + " . If you say no, nothing is run and the app only looks for leftovers.")) === true; } catch { yes = false; }
    if (!yes) return plain("");
    const installTarget = leftoverTarget(det.program);
    const ac = new AbortController();
    uninstallAbort = ac;
    phase({ phase: "uninstalling", detail: "Running the uninstaller of " + app + "..." });
    let r = null;
    try { r = await runProgramUninstaller({ exe: det.command.exe, args: det.command.args, signal: ac.signal }); } catch { r = null; }
    finally { if (uninstallAbort === ac) uninstallAbort = null; }
    if (!r || r.ok !== true) {
      phase(r && r.reason === "stopped" ? { phase: "done", detail: TEXT.uninstallStopped } : { phase: "error", detail: TEXT.uninstallFailed });
      return { ok: false, ...(r && r.reason === "stopped" ? { stopped: true } : {}) };
    }
    programById = new Map();
    // REBOOT CHECK, right after the uninstaller exited: exit code 3010 / 1641, or a pending rename inside the app's folders.
    let pending = null;
    if (typeof readPendingRenames === "function") { try { pending = await readPendingRenames(); } catch { pending = null; } }
    const rb = rebootAssessment({ code: r.code, pending, folders: [target, installTarget] });
    if (rb.needed) {
      noteRestart(app);
      let go = false;
      try {
        go = (await ui.askRestartContinue("The uninstaller says Windows must restart to finish removing " + app + "." +
          (rb.initiated ? " Windows may restart on its own, so save your work first." : "") +
          " You can keep cleaning leftovers now and restart later. Continue?")) === true;
      } catch { go = false; }
      if (!go) { phase({ phase: "done", detail: TEXT.stoppedAfterUninstall }); return { ok: true, scanned: false, restartNeeded: true }; }
    }
    // SWEEP: the ordinary investigate scan, run only now, on the picked folder and on the app's install folder.
    const dirs = [];
    for (const d of [target, installTarget]) if (d && isDir(d) && !dirs.some(x => nk(x) === nk(d))) dirs.push(d);
    if (dirs.length === 0) { phase({ phase: "done", detail: TEXT.gone }); return { ok: true, scanned: false, restartNeeded: rb.needed }; }
    const codeNote = typeof r.code === "number" && r.code !== 0 && r.code !== 3010 && r.code !== EXIT_REBOOT_INITIATED ? "The uninstaller ended with code " + r.code + " (it may have been cancelled or failed)." : "";
    const lead = "The uninstaller of " + app + " has finished." + (codeNote ? " " + codeNote : "") + " Below is what it left behind.";
    return newScan({ kind: "investigate", target: dirs[0], ...(dirs[1] ? { also: dirs[1] } : {}), recheck: true, appName: app }, { lead });
  }

  // Re-checks the ids against the last scan. Returns the items to freeze, or throws "refused". Never touches the disk.
  // Reads no file content; it stats paths (canonical forms), so it hands the event loop back every 50 items.
  async function choose(ids) {
    if (!last || !last.request || !Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS) throw refused();
    let excluded;
    try { excluded = exclusionMatcher(exclusionsNow(), { deep: true }); } catch { throw refused(); }
    const { dirs, violates, neverTouch } = guardsNow();
    const items = last.result.items;
    const byId = new Map();
    for (const it of items) {
      if (!it || typeof it.id !== "string" || !ID_RE.test(it.id) || byId.has(it.id)) throw refused(); // duplicates: refuse
      byId.set(it.id, it);
    }
    const want = new Set();
    for (const id of ids) { if (typeof id !== "string" || !ID_RE.test(id)) throw refused(); want.add(id); }
    const ok = it => !!it && it.selectable === true && SELECTABLE_GROUPS.has(it.group) && CONFIDENCES.has(it.confidence) &&
      (it.kind === "file" || it.kind === "dir") && typeof it.path === "string" && path.isAbsolute(it.path) &&
      Array.isArray(it.sharedWith) && !violates(it.path) && adminItemOk(it, dirs) && profileOk(it) && !excluded(it.path) && !neverTouch(it.path);
    let n = 0;
    for (const id of want) {
      const it = byId.get(id);
      if (!ok(it)) throw refused();
      if (it.companionOf !== undefined && !want.has(it.companionOf)) throw refused(); // a companion only travels with its parent
      if (++n % 50 === 0) await yieldNow();
    }
    // Companions of ticked items are added here (a Recycle Bin $I record goes with its $R data).
    for (const it of items) {
      if (it && it.companionOf !== undefined && want.has(it.companionOf) && !want.has(it.id)) {
        if (!ok(it)) throw refused();
        want.add(it.id);
      }
    }
    return [...want].map(id => byId.get(id));
  }

  async function restoreStep() {
    phase({ phase: "restore" });
    // "Stop waiting" (nuke:scan:cancel -> scanCancel) aborts this controller: the restore helper kills its child on a best-effort
    // basis, and the race below ends the step even if the helper itself never answers.
    const ac = new AbortController();
    restoreAbort = ac;
    const stopped = new Promise(res => ac.signal.addEventListener("abort", () => res({ outcome: "failed", detail: "stopped" }), { once: true }));
    let r;
    try { r = await Promise.race([restore({ runId: crypto.randomBytes(8).toString("hex"), elevated, signal: ac.signal }), stopped]); } catch { r = null; }
    finally { if (restoreAbort === ac) restoreAbort = null; }
    const outcome = r && Object.hasOwn(RESTORE_MESSAGES, r.outcome) ? r.outcome : "failed";
    const message = outcome === "failed" && r && r.detail === "timeout" ? TIMEOUT_MESSAGE
      : outcome === "failed" && r && r.detail === "stopped" ? STOPPED_MESSAGE : RESTORE_MESSAGES[outcome];
    phase({ phase: "restore", detail: message });
    if (outcome === "made") return true;
    let go = false;
    try { go = (await ui.askContinueWithoutRestore(message + " Continue without a restore point?")) === true; } catch { go = false; }
    return go;
  }

  // After a guided run's delete: scan the same target(s) again (no phase change) and report what is still there.
  async function recheck(request, chosen) {
    let again = null;
    try { again = await scan(request); if (!goodResult(again)) again = null; } catch { again = null; }
    const still = chosen.filter(it => { try { fs.lstatSync(it.path); return true; } catch { return false; } });
    const app = typeof request.appName === "string" ? request.appName : "";
    if (still.length > 0) {
      if (app) noteRestart(app);
      const names = still.slice(0, 5).map(it => displayText(path.basename(it.path) || it.path, 60)).join(", ") + (still.length > 5 ? " and " + (still.length - 5) + " more" : "");
      return "Re-check: " + plural(still.length, "item", "items") + " could not be removed (in use or waiting for a restart): " + names + ".";
    }
    if (!again) return "Re-check: the folder could not be scanned again.";
    const chosenKeys = new Set(chosen.map(it => nk(it.path)));
    const other = again.items.filter(it => it && it.selectable === true && typeof it.path === "string" && !chosenKeys.has(nk(it.path))).length;
    return other === 0 ? "Re-check: nothing left." : "Re-check: everything you chose is gone; " + plural(other, "other item", "other items") + " you did not choose " + (other === 1 ? "is" : "are") + " still listed.";
  }

  async function ritual(run, post = null) {
    const { server } = run;
    let windowClosed = false;
    let handle = null;
    try {
      phase({ phase: "ritual" });
      handle = ui.openRitual(run.url);
      if (handle && typeof handle.onClosed === "function") handle.onClosed(() => { windowClosed = true; });
    } catch {
      try { server.close(); } catch { /* closed */ }
      phase({ phase: "error", detail: TEXT.ritualFailed });
      return { ok: false };
    }
    const closeWindow = () => { try { if (handle && typeof handle.close === "function") handle.close(); } catch { /* gone */ } };
    const ctx = { server, close: closeWindow, ended: false, keep: false };
    ritualCtx = ctx;
    try { return await ritualLoop(run, server, closeWindow, () => windowClosed, ctx, post); }
    finally { ctx.ended = true; if (!ctx.keep && ritualCtx === ctx) ritualCtx = null; } // a finished run's page stays until ritualClose
  }

  async function ritualLoop(run, server, closeWindow, isWindowClosed, ctx, post = null) {
    let state;
    let lastDone = -1;
    for (;;) {
      try { state = server.getState(); } catch { state = "failed"; }
      if (TERMINAL.has(state)) break;
      if (state === "deleting" && typeof server.getProgress === "function") {
        try {
          const g = server.getProgress();
          if (g && Number.isFinite(g.done) && Number.isFinite(g.total) && g.done !== lastDone) { lastDone = g.done; phase({ phase: "deleting", detail: "Deleting... " + g.done + " of " + g.total }); }
        } catch { /* progress is cosmetic */ }
      }
      if (isWindowClosed() && (state === "armed" || state === "unlocked")) {
        try { server.close(); } catch { /* closed */ }
        auditCancelled(run);
        phase({ phase: "done", detail: TEXT.cancelled });
        return { ok: false, cancelled: true };
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    // The run ended. Nothing to show for aborted/expired/failed: the page goes away and the main window shows the outcome.
    // After "done" the page STAYS (press animation, blast, disk map with the real freed space) until the user clicks
    // "Done - back to start" in the bar (ritualClose). The page has no bridge and the run's server is finished.
    if (state === "done") ctx.keep = true; else closeWindow();
    if (state === "expired" || state === "aborted") {
      phase({ phase: "done", detail: state === "expired" ? TEXT.expired : TEXT.aborted });
      return { ok: false };
    }
    let lines = [];
    try { lines = readAudit(paths.runDir, run.runId); } catch { lines = []; }
    const s = doneSummary(Array.isArray(lines) ? lines.filter(l => l && l.runId === run.runId) : []);
    if (state === "failed") {
      phase({ phase: "error", detail: TEXT.failed });
      return { ok: false };
    }
    // RE-CHECK (guided folder runs only): scan the same target again and say what is left. Read-only.
    let extra = "";
    if (post) {
      phase({ phase: "deleting", detail: "Re-checking what is left..." });
      try { extra = await post(); } catch { extra = ""; }
    }
    if (!s) { // the server finished, but its log line could not be read: say so, claim no numbers
      phase({ phase: "done", detail: TEXT.doneNoAudit + (extra ? " " + extra : ""), keepView: ctx.keep });
      return { ok: true };
    }
    phase({ phase: "done", detail: doneText(s) + (extra ? " " + extra : ""), ...s, keepView: ctx.keep });
    return { ok: true, ...s };
  }

  async function deleteFlow(chosen) {
    let confirmed = false;
    try { confirmed = (await ui.confirmPermanent()) === true; } catch { confirmed = false; }
    if (!confirmed) return { ok: false, cancelled: true };
    const result = last.result;
    const request = last.request;
    const scanStartMs = last.scanStartMs;
    last = null; // from here on this scan is used up: a new delete needs a new scan
    try { ui.closeResults(); } catch { /* already closed */ }

    const settings = loadSettings(paths.settingsFile);
    if (settings.restorePoint !== false) {
      if (!(await restoreStep())) { phase({ phase: "done", detail: TEXT.stopped }); return { ok: false, stopped: true }; }
    }

    // Every long loop below hands the event loop back every 50 items and tells the window how far it got.
    const total = chosen.length;
    const checking = n => phase({ phase: "checking", detail: n === 0 ? "Checking " + plural(total, "item", "items") + "..." : "Checking... " + n + " of " + total });
    const chunked = async (list, fn) => {
      for (let i = 0; i < list.length; i++) {
        fn(list[i]);
        if ((i + 1) % 50 === 0) { checking(i + 1); await yieldNow(); }
      }
    };
    checking(0);
    let sel;
    try {
      // Excluded folders again, from the file as it is NOW (the list can change while the user answers the questions above).
      const excl = exclusionsNow();
      const excludedNow = exclusionMatcher(excl, { deep: true });
      await chunked(chosen, i => { if (excludedNow(i.path)) throw new Error("excluded"); });
      const map = {
        sessionId: "nuke-uninstaller",
        items: result.items.map(i => ({ id: i.id, group: i.group, path: i.path, sharedWith: Array.isArray(i.sharedWith) ? i.sharedWith : [] })),
        allowedRoots: Array.isArray(result.allowedRoots) ? result.allowedRoots : [],
        protectedPaths: [...protectedFor(request), ...excl, ...(Array.isArray(result.protectedPaths) ? result.protectedPaths : [])],
        livePaths: [],
      };
      const ids = chosen.map(i => i.id);
      sel = buildSelection(map, ids, { allowShared: chosen.filter(i => i.group === "shared").map(i => i.id) });
      // R32 again on the frozen paths, then the engine's on-disk check (it must exist and pass checkPath now).
      const { violates, neverTouch } = guardsNow();
      await chunked(sel.paths, p => {
        if (violates(p)) throw new Error("protected root");
        if (neverTouch(p)) throw new Error("never-touch");
      });
      await revalidateAsync(sel, { adminContents: elevated, onProgress: n => checking(n) });
      // Age and lock re-check just before the run starts (the server repeats the age check entry by entry at delete time).
      if (!Number.isFinite(scanStartMs)) throw new Error("no scan time");
      await chunked(chosen, it => {
        const st = fs.lstatSync(it.path);
        if (changedAfter(st, scanStartMs)) throw new Error("changed since the scan");
        if (it.kind === "file" && isLocked(it.path)) throw new Error("locked");
      });
    } catch {
      phase({ phase: "error", detail: TEXT.changed });
      return { ok: false };
    }

    let run;
    const preparing = ev => { if (ev && Number.isFinite(ev.done) && Number.isFinite(ev.total)) phase({ phase: "checking", detail: "Preparing... " + ev.done + " of " + ev.total }); };
    try { run = await startRun(sel, { runDir: paths.runDir, adminContents: elevated, scanStartMs, plainConfirm: settings.plainConfirm === true, onProgress: preparing }); } catch {
      phase({ phase: "error", detail: TEXT.startFailed });
      return { ok: false };
    }
    currentRun = run;
    return ritual(run, request.recheck === true ? () => recheck(request, chosen) : null);
  }

  // Closing the confirm window before the press is a decision worth keeping a record of (no token, no url).
  function auditCancelled(run) {
    try {
      const rec = { at: new Date().toISOString(), sessionId: "nuke-uninstaller", ...(typeof run.sha256 === "string" ? { sha256: run.sha256 } : {}), runId: run.runId, state: "cancelled" };
      fs.appendFileSync(path.join(paths.runDir, "nuke-audit.log"), JSON.stringify(rec) + "\n");
    } catch { /* best effort */ }
  }

  return {
    async settingsGet() { return { ...loadSettings(paths.settingsFile), exclusions: exclusionRows(readExclusions(paths.settingsFile).list) }; },
    async settingsSet(s) { saveSettings(paths.settingsFile, s); return { ...loadSettings(paths.settingsFile), exclusions: exclusionRows(readExclusions(paths.settingsFile).list) }; },
    // ---- Exclusions: the window holds only opaque ids; the picker runs in main; the list lives in settings.json. ----
    // Both resolve { ok, rows: [{ id, path }], reason? } with reason one of: cancelled, invalid, duplicate, full, gone, failed.
    async exclusionsAdd() {
      take("pick");
      let target = null;
      try { try { target = await ui.pickFolder(); } catch { target = null; } } finally { busy = null; }
      const cur = readExclusions(paths.settingsFile); // unreadable file: nothing to keep, a clean one is written below
      if (typeof target !== "string" || !target) return { ok: false, reason: "cancelled", cancelled: true, rows: exclusionRows(cur.list) };
      const r = addExclusion(cur.list, target);
      if (!r.ok) return { ok: false, reason: r.reason, rows: exclusionRows(cur.list) };
      try { saveExclusions(paths.settingsFile, r.list); } catch { return { ok: false, reason: "failed", rows: exclusionRows(cur.list) }; }
      return { ok: true, rows: exclusionRows(r.list) };
    },
    async exclusionsRemove(arg) {
      if (busy) throw busyError();
      const id = arg && typeof arg.id === "string" && ID_RE.test(arg.id) ? arg.id : null;
      if (id === null) throw refused();
      const cur = readExclusions(paths.settingsFile);
      if (!cur.ok) return { ok: false, reason: "failed", rows: [] };
      const hit = cur.list.find(p => exclusionId(p) === id);
      if (hit === undefined) return { ok: false, reason: "gone", rows: exclusionRows(cur.list) };
      const next = cur.list.filter(p => p !== hit);
      try { saveExclusions(paths.settingsFile, next); } catch { return { ok: false, reason: "failed", rows: exclusionRows(cur.list) }; }
      return { ok: true, rows: exclusionRows(next) };
    },
    async statusGet() { return { elevated: identityKnown ? elevated : null, canRelaunchAdmin: relaunchOffered() }; },

    async scanSmart() {
      take("scan");
      try { return await newScan({ kind: "smart" }); } finally { busy = null; }
    },
    // Browsers cleaner (round 2): browser cache folders (pre-ticked when old enough and not in use) and optional browsing-history
    // files (never pre-ticked). The same findings, results screen and delete funnel as Smart Scan, plus the R45 profile rule.
    async scanBrowsers() {
      if (elevated) { phase({ phase: "error", detail: ADMIN_BROWSERS_MESSAGE }); return { ok: false }; } // R41: an elevated process never walks user folders
      take("scan");
      try { return await newScan({ kind: "browsers" }); } finally { busy = null; }
    },
    async scanStartup() {
      take("scan");
      try { return await newScan({ kind: "startup" }); } finally { busy = null; }
    },
    // ---- installed programs and Windows apps (round 1 of version 2). The renderer only ever sees opaque ids. ----
    async programsList() {
      if (busy) throw busyError();
      if (typeof readPrograms !== "function") return { ok: false, rows: [] };
      busy = "list";
      try {
        const r = await readPrograms();
        if (!r || !Array.isArray(r.programs)) return { ok: false, rows: [] };
        programById = new Map(r.programs.map(p => [p.id, p]));
        return { ok: r.ok === true, rows: r.programs.map(programRow), notes: Array.isArray(r.notes) ? r.notes.map(String) : [] };
      } finally { busy = null; }
    },
    async programsUninstall(arg) {
      if (busy) throw busyError();
      const p = arg && typeof arg.id === "string" ? programById.get(arg.id) : null;
      const cmd = p && !p.lossy ? parseUninstallCommand(p.uninstallCommand) : null;
      if (!p || !cmd) throw refused();
      let yes = false;
      try { yes = (await ui.confirmAction("Run the uninstaller of " + p.name + "? This will start: " + cmd.exe + (cmd.args ? " " + cmd.args : "") + " . When it finishes the app looks for leftover files; nothing is deleted without your confirmation.")) === true; } catch { yes = false; }
      if (!yes) return { ok: false, cancelled: true };
      take("scan");
      try {
        const target = leftoverTarget(p);
        phase({ phase: "scanning" });
        const r = await runProgramUninstaller({ exe: cmd.exe, args: cmd.args });
        if (!r || r.ok !== true) { phase({ phase: "error", detail: TEXT.uninstallFailed }); return { ok: false }; }
        programById = new Map();
        if (!target) { phase({ phase: "done", detail: TEXT.uninstallDone }); return { ok: true, scanned: false }; }
        busy = null; take("scan");
        return await newScan({ kind: "investigate", target });
      } finally { busy = null; }
    },
    async appsList() {
      if (busy) throw busyError();
      busy = "list";
      try {
        const r = await readApps();
        if (!r || !Array.isArray(r.apps)) return { ok: false, rows: [] };
        appById = new Map(r.apps.map(a => [crypto.createHash("sha1").update("app:" + a.fullName).digest("hex").slice(0, 16), a]));
        return { ok: r.ok === true, rows: [...appById].map(([id, a]) => ({ id, name: a.name, version: a.version })) };
      } finally { busy = null; }
    },
    async appsRemove(arg) {
      if (busy) throw busyError();
      const a = arg && typeof arg.id === "string" ? appById.get(arg.id) : null;
      if (!a) throw refused();
      let yes = false;
      try { yes = (await ui.confirmAction("Remove the Windows app " + a.name + " for your account? You can install it again from the Microsoft Store.")) === true; } catch { yes = false; }
      if (!yes) return { ok: false, cancelled: true };
      take("scan");
      try {
        const r = await removeApp(a.fullName);
        appById = new Map();
        phase({ phase: "done", detail: r && r.ok === true ? TEXT.appRemoved : TEXT.appFailed });
        return { ok: !!(r && r.ok === true) };
      } finally { busy = null; }
    },
    // ---- Windows tools: a fixed list of built-in Windows programs. The renderer only ever holds the key. ----
    async toolsList() { return toolList(); },
    async toolsOpen(arg) {
      // An elevated (or unknown) app would start the tool with administrator rights: refused. Standard mode only.
      if (!identityKnown || elevated) throw refused();
      const key = arg && typeof arg === "object" ? arg.tool : undefined;
      if (!isToolKey(key)) throw refused();
      let r = null;
      try { r = await startTool(key); } catch { r = null; }
      return { ok: !!r && r.ok === true };
    },
    async scanInvestigate() { return picked(() => ui.pickFile()); },
    async scanFolder() { return picked(() => ui.pickFolder(), { guided: true }); },

    // From the results window: resolves the new view (with its diff) or rejects with a fixed message.
    async scanAgain() {
      if (busy) throw busyError();
      if (!last) throw refused();
      busy = "scan";
      const prev = last;
      const gen = generation;
      const scanStartMs = Date.now();
      try {
        phase({ phase: "scanning" });
        let next;
        try {
          next = await scan(prev.request);
          if (!goodResult(next)) throw new Error("bad result");
          if (gen !== generation) throw Object.assign(new Error("superseded"), { name: "AbortError" });
        } catch (e) {
          if (gen !== generation) throw Object.assign(new Error("The scan was cancelled"), { name: "AbortError" }); // closed meanwhile: stay silent
          phase({ phase: "results", detail: TEXT.review });
          throw isAbort(e) ? Object.assign(new Error("The scan was cancelled"), { name: "AbortError" }) : new Error(GENERIC_ERROR);
        }
        const diff = diffScans(prev.result, next);
        last = { request: prev.request, result: next, diff, scanStartMs };
        phase({ phase: "results", detail: TEXT.review });
        return toView(next, diff);
      } finally { busy = null; }
    },

    async scanCancel() {
      if (scanAbort) scanAbort.abort();
      if (restoreAbort) restoreAbort.abort();
      if (uninstallAbort) uninstallAbort.abort();
      return { ok: true };
    },

    async resultsGet() {
      if (!last) throw refused();
      return toView(last.result, last.diff);
    },

    async delete(arg) {
      if (ritualCtx) throw busyError(); // a finished confirmation page is still up: close it first
      if (!identityKnown) { phase({ phase: "error", detail: IDENTITY_UNKNOWN_MESSAGE }); throw new Refusal(IDENTITY_UNKNOWN_MESSAGE); }
      if (busy) throw busyError();
      const ids = arg && typeof arg === "object" ? arg.ids : undefined;
      busy = "delete"; // taken first: choose() hands the event loop back while it works, so a second request must see "busy"
      let chosen;
      try { chosen = await choose(ids); } catch (e) { busy = null; throw e; } // throws "refused" before anything is shown or started
      try { return await deleteFlow(chosen); }
      catch { phase({ phase: "error", detail: GENERIC_ERROR }); return { ok: false }; }
      finally { busy = null; currentRun = null; }
    },

    // True only while a started run's server is in the "deleting" state (main uses it to decide whether an internal error may quit the app).
    isDeleting() {
      try { return !!currentRun && currentRun.server.getState() === "deleting"; } catch { return false; }
    },

    // "Cancel - nothing will be deleted" in the main window's bar: the same path as closing the old confirmation window
    // before the press (the ritual loop sees the page go away: server closed, audit "cancelled"). Refused once the button
    // was pressed (the server is past armed/unlocked) or when no confirmation is up.
    async ritualCancel() {
      const c = ritualCtx;
      if (!c || c.ended) throw refused();
      let state;
      try { state = c.server.getState(); } catch { state = "failed"; }
      if (state !== "armed" && state !== "unlocked") throw refused();
      c.close();
      return { ok: true };
    },

    // "Done - back to start": accepted ONLY after the run ended (done/aborted/expired/failed/cancelled). Detaches the finished
    // page and returns to the start. It cannot start, continue or influence any run.
    async ritualClose() {
      const c = ritualCtx;
      if (!c || c.ended !== true) throw refused();
      ritualCtx = null;
      last = null;
      try { c.close(); } catch { /* gone */ }
      phase({ phase: "idle" });
      return { ok: true };
    },

    async resultsClose() {
      if (busy === "delete") throw busyError();
      generation++;
      if (busy === "scan" && scanAbort) scanAbort.abort();
      last = null;
      try { ui.closeResults(); } catch { /* already closed */ }
      phase({ phase: "idle" });
      return { ok: true };
    },

    // Phase 1b: "Relaunch as administrator". On "started" main quits this instance (it released its single-instance
    // lock first); "cancelled" (the user said no at the UAC prompt) leaves everything as it was.
    async adminRelaunch() {
      if (elevated || !identityKnown || !relaunchOffered()) throw refused(); // R46: only an installed copy under Program Files
      if (typeof relaunch !== "function") throw new Error(GENERIC_ERROR);
      take("relaunch");
      try {
        let out;
        try { out = await relaunch(); } catch { out = "failed"; }
        if (out === "started") return { ok: true };
        if (out === "cancelled") return { ok: false, cancelled: true };
        if (out === "timeout") throw new Refusal(RELAUNCH_TIMEOUT_MESSAGE);
        throw new Error(GENERIC_ERROR);
      } finally { busy = null; }
    },
  };
}

// IPC-facing wrapper: whatever a method throws, only "busy", "refused", an AbortError or the generic text leaves main.
export function guardController(c) {
  const out = {};
  for (const [k, fn] of Object.entries(c)) {
    out[k] = async (...a) => {
      try { return await fn(...a); } catch (e) {
        if (e && e.name === "AbortError") { const x = new Error("The scan was cancelled"); x.name = "AbortError"; throw x; }
        throw safeError(e);
      }
    };
  }
  return Object.freeze(out);
}
