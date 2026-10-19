// "Stop waiting" on the restore point step, and the main process staying responsive while it runs.
// Real controller + real createRestorePoint, with a fake spawn whose "PowerShell" never exits. No process is started.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createController } from "../../app/main/controller.mjs";
import { appDataPaths, ensureAppData } from "../../app/main/appdata.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { createRestorePoint, STOPPED_MESSAGE, RESTORE_TIMEOUT_MS } from "../../lib/restore.mjs";

const SID = "S-1-5-21-11-22-33-1001";
const tick = () => new Promise(r => setImmediate(r));

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-stop-"));
  const la = path.join(root, "Local");
  const junk = path.join(la, "Temp");
  fs.mkdirSync(junk, { recursive: true });
  const p = path.join(junk, "a.tmp");
  fs.writeFileSync(p, "x".repeat(10));
  const old = new Date(Date.now() - 10 * 86400e3);
  fs.utimesSync(p, old, old);
  const paths = appDataPaths({ LOCALAPPDATA: la });
  ensureAppData(paths);
  return { root, junk, p, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function neverExitingSpawn() {
  const calls = [];
  const fn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    calls.push({ exe, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

test("the restore timeout is 3 minutes", () => {
  assert.equal(RESTORE_TIMEOUT_MS, 180000);
});

test("Stop waiting: the fake PowerShell never exits, events keep flowing, scanCancel ends the step and the question follows (default = stop)", async () => {
  const t = tree();
  let c0 = { scanCancel: async () => {} }; // on a failed assertion the cancel also clears the 3-minute restore timer
  try {
    const spawnFn = neverExitingSpawn();
    const phases = [];
    const asks = [];
    let started = 0;
    const ui = {
      sendPhase: p => phases.push(p), sendProgress() {}, showResults() {}, closeResults() {},
      confirmPermanent: async () => true,
      askContinueWithoutRestore: async m => { asks.push(m); return false; }, // the safe default: Stop
      openRitual: () => { throw new Error("must not be reached"); },
    };
    const item = makeFinding({ kind: "file", path: t.p, label: t.p, bytes: 10, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false, reason: "r", category: "Temporary files" });
    const c = createController({
      ui, paths: t.paths, identity: { sid: SID, elevated: false },
      runScan: async () => ({ kind: "smart", target: null, items: [item], allowedRoots: [t.junk], protectedPaths: [], notes: [], adminExtraBytes: null, partial: false }),
      restore: o => createRestorePoint({ ...o, spawnFn }),
      startRun: async () => { started++; throw new Error("nothing may start"); },
      protectedPaths: [path.join(t.root, "Documents")], pollMs: 5,
    });
    c0 = c;
    await c.scanSmart();
    const del = c.delete({ ids: [item.id] });
    // The step is waiting on a child that never exits; the event loop must still turn (timers fire, other calls answer).
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    for (let i = 0; i < 40 && spawnFn.calls.length === 0; i++) await tick();
    await new Promise(r => setTimeout(r, 120));
    clearInterval(timer);
    assert.equal(spawnFn.calls.length, 1, "the restore helper was started");
    assert.ok(ticks >= 5, "timers kept firing while the restore step waited (" + ticks + ")");
    assert.deepEqual(phases.map(p => p.phase).filter(p => p !== "checking"), ["scanning", "results", "restore"], "still waiting: no detail yet");
    assert.equal(phases.at(-1).detail, undefined);
    assert.deepEqual(await c.statusGet(), { elevated: false, canRelaunchAdmin: false }, "other calls are answered meanwhile");
    await assert.rejects(c.delete({ ids: [item.id] }), /Another operation is still running/);
    // Stop waiting = the existing cancel channel.
    assert.deepEqual(await c.scanCancel(), { ok: true });
    const r = await del;
    assert.equal(spawnFn.calls[0].child.killed, true, "the child we started was killed (best effort)");
    assert.deepEqual(r, { ok: false, stopped: true });
    const detail = phases.find(p => p.phase === "restore" && p.detail);
    assert.equal(detail.detail, STOPPED_MESSAGE);
    assert.match(STOPPED_MESSAGE, /cannot be stopped from here/, "honest about an already-elevated child");
    assert.equal(asks.length, 1);
    assert.equal(asks[0], STOPPED_MESSAGE + " Continue without a restore point?");
    assert.equal(started, 0, "nothing was started or deleted without the user's yes");
    assert.ok(fs.existsSync(t.p));
    assert.equal(phases.at(-1).phase, "done");
  } finally { await c0.scanCancel(); t.cleanup(); }
});

test("Stop waiting also ends the step when the restore helper ignores the signal and never answers", async () => {
  const t = tree();
  try {
    const asks = [];
    const ui = { sendPhase() {}, sendProgress() {}, showResults() {}, closeResults() {}, confirmPermanent: async () => true,
      askContinueWithoutRestore: async m => { asks.push(m); return false; }, openRitual() { throw new Error("no"); } };
    const item = makeFinding({ kind: "file", path: t.p, label: t.p, bytes: 10, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false, reason: "r", category: "Temporary files" });
    const c = createController({ ui, paths: t.paths, identity: { sid: SID, elevated: false },
      runScan: async () => ({ kind: "smart", target: null, items: [item], allowedRoots: [t.junk], protectedPaths: [], notes: [], adminExtraBytes: null, partial: false }),
      restore: () => new Promise(() => {}), startRun: async () => { throw new Error("no"); }, protectedPaths: [path.join(t.root, "Documents")], pollMs: 5 });
    await c.scanSmart();
    const del = c.delete({ ids: [item.id] });
    for (let i = 0; i < 20; i++) await tick();
    await c.scanCancel();
    assert.deepEqual(await del, { ok: false, stopped: true });
    assert.equal(asks.length, 1);
  } finally { t.cleanup(); }
});

test("createRestorePoint: an aborted signal kills the child once and reports failed/stopped; a late exit changes nothing", async () => {
  const spawnFn = neverExitingSpawn();
  const ac = new AbortController();
  const p = createRestorePoint({ runId: "0123456789abcdef", elevated: false, spawnFn, signal: ac.signal });
  ac.abort();
  const r = await p;
  assert.equal(r.outcome, "failed");
  assert.equal(r.detail, "stopped");
  assert.equal(r.message, STOPPED_MESSAGE);
  assert.equal(spawnFn.calls[0].child.killed, true);
  spawnFn.calls[0].child.emit("exit", 20, null); // too late: ignored
  const pre = new AbortController(); pre.abort();
  assert.equal((await createRestorePoint({ runId: "0123456789abcdef", elevated: true, spawnFn: neverExitingSpawn(), signal: pre.signal })).detail, "stopped");
});
