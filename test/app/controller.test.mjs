// Controller unit tests: fake ui / restore / startRun / runScan, real engine pieces (buildSelection, revalidate) on temp trees.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createController, GENERIC_ERROR, BUSY_MESSAGE, readAuditLines } from "../../app/main/controller.mjs";
import { appDataPaths, ensureAppData } from "../../app/main/appdata.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { RESTORE_MESSAGES, TIMEOUT_MESSAGE } from "../../lib/restore.mjs";
import { scanArgs } from "../../app/main/scan-runner.mjs";

const SID = "S-1-5-21-11-22-33-1001";
const tick = () => new Promise(r => setImmediate(r));

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-ctl-"));
  const la = path.join(root, "Local");
  const junk = path.join(la, "Temp");
  fs.mkdirSync(junk, { recursive: true });
  const f = n => { const p = path.join(junk, n); fs.writeFileSync(p, n.repeat(10)); return p; };
  const paths = appDataPaths({ LOCALAPPDATA: la });
  ensureAppData(paths);
  return { root, la, junk, f, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const vetted = (p, extra = {}) => makeFinding({ kind: "file", path: p, label: p, bytes: 10, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false,
  reason: "r", category: "Temporary files", ...extra });

function resultFor(t, items, extra = {}) {
  return { kind: "smart", target: null, items, allowedRoots: [t.junk], protectedPaths: [], notes: [], adminExtraBytes: null, partial: false, ...extra };
}

function fakeUi(o = {}) {
  const ui = {
    phases: [], progress: [], shown: 0, closed: 0, asks: [], confirms: 0, ritualUrls: [],
    pickFile: async () => (o.file ?? null),
    pickFolder: async () => (o.folder ?? null),
    sendProgress: p => ui.progress.push(p),
    sendPhase: p => ui.phases.push(p),
    showResults: () => { ui.shown++; },
    closeResults: () => { ui.closed++; },
    confirmPermanent: async () => { ui.confirms++; return o.confirm ?? true; },
    askContinueWithoutRestore: async m => { ui.asks.push(m); return o.continue ?? true; },
    openRitual: url => {
      ui.ritualUrls.push(url);
      const w = { cb: null, onClosed(cb) { w.cb = cb; }, close() { w.closedByMain = true; } };
      ui.ritual = w;
      if (o.onRitual) setImmediate(() => o.onRitual(url, w));
      return w;
    },
  };
  return ui;
}

// A startRun stand-in: records the call, never touches the disk. Its server ends in `final` after one poll.
function fakeStart(final = "done") {
  const calls = [];
  const fn = async (sel, opts) => {
    calls.push({ sel, opts });
    let n = 0;
    const server = { runId: "0123456789abcdef", token: "f".repeat(64), closed: false, getState: () => (++n > 1 ? final : "armed"), close() { server.closed = true; } };
    return { url: "http://127.0.0.1:1/?t=" + "f".repeat(64), server, selection: sel, sha256: sel.sha256, runId: server.runId };
  };
  fn.calls = calls;
  return fn;
}
const doneAudit = () => [{ state: "started", runId: "0123456789abcdef" },
  { state: "done", runId: "0123456789abcdef", freedBytes: 2048, measured: true, results: [{ status: "deleted", bytes: 10 }] }];

function make(t, { ui = fakeUi(), runScan, restore, startRun = fakeStart(), identity = { sid: SID, elevated: false }, readAudit = doneAudit, ...rest } = {}) {
  const restoreCalls = [];
  const base = restore || (async () => ({ outcome: "made", message: RESTORE_MESSAGES.made, detail: "made" }));
  const c = createController({ ui, paths: t.paths, identity, runScan, restore: async o => { restoreCalls.push(o); return base(o); },
    startRun, protectedPaths: [path.join(t.root, "Documents")], readAudit, pollMs: 5, ...rest });
  return { c, ui, startRun, restoreCalls };
}

test("controller: settings round-trip, status from identity, admin relaunch refused when already elevated", async () => {
  const t = tree();
  try {
    const { c } = make(t, { runScan: async () => resultFor(t, []), identity: { sid: SID, elevated: true } });
    assert.deepEqual(await c.settingsGet(), { restorePoint: true, plainConfirm: false, exclusions: [] });
    await c.settingsSet({ restorePoint: false, plainConfirm: true });
    assert.deepEqual(await c.settingsGet(), { restorePoint: false, plainConfirm: true, exclusions: [] });
    await assert.rejects(c.settingsSet({ restorePoint: 1, plainConfirm: false }));
    await assert.rejects(c.settingsSet({ restorePoint: true }));
    assert.deepEqual(await c.statusGet(), { elevated: true, canRelaunchAdmin: false });
    await assert.rejects(c.adminRelaunch(), /refused/);
    await assert.rejects(c.resultsGet(), /refused/);
  } finally { t.cleanup(); }
});

test("scan args: the controller sends only {sid} / {target, protectedPaths}; the SID comes from identity, never from a caller", async () => {
  const t = tree();
  try {
    const seen = [];
    const runScan = async (kind, args) => { seen.push([kind, args]); return resultFor(t, []); };
    let { c } = make(t, { runScan, ui: fakeUi({ file: path.join(t.junk, "x.exe"), folder: t.junk }) });
    await c.scanSmart("ignored", { locations: [] });
    await c.scanInvestigate({ target: "C:\\Windows" });
    await c.scanFolder();
    assert.deepEqual(seen[0], ["smart", { sid: SID, protectedPaths: [] }]); // protectedPaths = the user's excluded folders (none here)
    assert.deepEqual(Object.keys(seen[1][1]).sort(), ["protectedPaths", "target"]);
    assert.equal(seen[1][1].target, path.join(t.junk, "x.exe"));
    assert.equal(seen[2][1].target, t.junk);
    // an Entra / unknown identity has no usable SID: null, and the scan notes the Recycle Bin as not scanned
    for (const sid of [null, "S-1-12-1-1-2-3-4", "S-1-5-21-1-2-3-4;evil", undefined]) {
      seen.length = 0;
      ({ c } = make(t, { runScan, identity: { sid, elevated: false } }));
      await c.scanSmart();
      assert.deepEqual(seen[0][1], { sid: null, protectedPaths: [] }, String(sid));
    }
    // the worker-side sanitiser drops everything that is not on its list (locations, budget, now, odd env values)
    const a = scanArgs("smart", { sid: "bad", locations: [{ base: "C:\\" }], budget: {}, now: 1, env: { LOCALAPPDATA: "C:\\x", EVIL: "y", APPDATA: 5 } });
    assert.deepEqual(a, { sid: null, env: { LOCALAPPDATA: "C:\\x" } });
    assert.deepEqual(scanArgs("smart", { sid: SID }), { sid: SID });
    assert.deepEqual(scanArgs("investigate", { target: "C:\\a\\b.exe", protectedPaths: ["C:\\p", 3], home: "rel", x: 1 }),
      { target: "C:\\a\\b.exe", protectedPaths: ["C:\\p"] });
    assert.throws(() => scanArgs("investigate", { target: 5 }));
    assert.throws(() => scanArgs("other", {}));
  } finally { t.cleanup(); }
});

test("unknown id, protected id, report-only id or an id from an older scan -> refused, no server started", async () => {
  const t = tree();
  try {
    const a = t.f("a"), b = t.f("b");
    const good = vetted(a), gone = vetted(b);
    const prot = makeFinding({ kind: "dir", path: t.junk, label: "x", safe: { ok: false, reason: "protected" }, basis: "vetted" });
    const rep = makeFinding({ kind: "startup", path: null, label: "Run thing", idKey: "HKCU Run:thing", reason: "r" });
    const unknownBasis = makeFinding({ kind: "file", path: a + ".u", label: "u", safe: { ok: true }, basis: "guess" });
    const rootCand = makeFinding({ kind: "dir", path: t.la, label: "LOCALAPPDATA", safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false });
    const orphan = vetted(a + ".rec", { companionOf: "0000000000000000" });
    let scans = 0;
    const runScan = async () => (++scans === 1 ? resultFor(t, [good, gone, prot, rep, unknownBasis, rootCand, orphan]) : resultFor(t, [good, prot, rep]));
    const startRun = fakeStart();
    const { c, ui, restoreCalls } = make(t, { runScan, startRun, protectedRoots: [t.la, t.root] });
    await c.scanSmart();
    assert.equal(ui.shown, 1);
    for (const ids of [["0123456789abcdef"], [prot.id], [rep.id], [unknownBasis.id], [rootCand.id], [orphan.id], [good.id, rep.id], ["XYZ"], []]) {
      await assert.rejects(c.delete({ ids }), e => e.message === "refused", JSON.stringify(ids));
    }
    await assert.rejects(c.delete({}), e => e.message === "refused");
    await assert.rejects(c.delete(null), e => e.message === "refused");
    // Scan Again: `gone` is no longer in the latest result, so its id (from the older scan) is refused
    const view = await c.scanAgain();
    assert.ok(view.removed.length >= 1);
    await assert.rejects(c.delete({ ids: [gone.id] }), e => e.message === "refused");
    assert.equal(startRun.calls.length, 0, "no server started");
    assert.equal(ui.confirms, 0, "refused before the warning");
    assert.equal(restoreCalls.length, 0);
    assert.ok(fs.existsSync(a) && fs.existsSync(b));
  } finally { t.cleanup(); }
});

test("a scan result holding duplicate ids is refused at delete time", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a"));
    const startRun = fakeStart();
    const { c } = make(t, { runScan: async () => resultFor(t, [a, { ...a }]), startRun });
    await c.scanSmart();
    await assert.rejects(c.delete({ ids: [a.id] }), e => e.message === "refused");
    assert.equal(startRun.calls.length, 0);
  } finally { t.cleanup(); }
});

test("companions of ticked ids are added by main; ids are de-duplicated; shared ids go to allowShared", async () => {
  const t = tree();
  try {
    const parent = vetted(t.f("rpair"));
    const comp = vetted(t.f("ipair"), { companionOf: parent.id });
    const shared = makeFinding({ kind: "file", path: t.f("sh"), label: "sh", bytes: 1, safe: { ok: true }, sharedWith: ["Other"], basis: "traced", userPicked: true });
    assert.equal(shared.group, "shared");
    const startRun = fakeStart();
    const { c } = make(t, { runScan: async () => resultFor(t, [parent, comp, shared]), startRun });
    await c.scanSmart();
    await c.delete({ ids: [parent.id, parent.id, shared.id] });
    assert.equal(startRun.calls.length, 1);
    const sel = startRun.calls[0].sel;
    assert.deepEqual(sel.paths.slice().sort(), [parent.path, comp.path, shared.path].sort());
    assert.equal(sel.sessionId, "nuke-uninstaller");
    assert.deepEqual(sel.livePaths, []);
    assert.ok(sel.protectedPaths.includes(path.join(t.root, "Documents")), "app protected paths are in the frozen selection");
  } finally { t.cleanup(); }
});

test("confirmPermanent false -> nothing started; restore off in settings -> restore never called", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a"));
    const startRun = fakeStart();
    let { c, ui, restoreCalls } = make(t, { runScan: async () => resultFor(t, [a]), startRun, ui: fakeUi({ confirm: false }) });
    await c.scanSmart();
    const r = await c.delete({ ids: [a.id] });
    assert.equal(r.ok, false);
    assert.equal(ui.confirms, 1);
    assert.equal(startRun.calls.length, 0);
    assert.equal(restoreCalls.length, 0);
    assert.equal(ui.closed, 0, "the results window stays open when the warning is cancelled");
    // the results are still there: a second try works
    await c.settingsSet({ restorePoint: false, plainConfirm: false });
    ({ c, ui, restoreCalls } = make(t, { runScan: async () => resultFor(t, [a]), startRun }));
    await c.scanSmart();
    const r2 = await c.delete({ ids: [a.id] });
    assert.equal(r2.ok, true);
    assert.equal(restoreCalls.length, 0, "restore switched off: never called");
    assert.equal(startRun.calls.length, 1);
    assert.ok(!ui.phases.some(p => p.phase === "restore"));
    assert.equal(ui.closed, 1);
  } finally { t.cleanup(); }
});

test("needs-admin + user stops: no server started, nothing deleted", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a"));
    const startRun = fakeStart();
    const { c, ui, restoreCalls } = make(t, { runScan: async () => resultFor(t, [a]), startRun, ui: fakeUi({ continue: false }),
      restore: async () => ({ outcome: "needs-admin", message: RESTORE_MESSAGES["needs-admin"], detail: "uac-cancelled" }) });
    await c.scanSmart();
    const r = await c.delete({ ids: [a.id] });
    assert.equal(r.ok, false);
    assert.equal(restoreCalls.length, 1);
    assert.equal(ui.asks.length, 1);
    assert.equal(startRun.calls.length, 0);
    assert.ok(fs.existsSync(a.path));
    const last = ui.phases.at(-1);
    assert.equal(last.phase, "done");
    assert.match(last.detail, /Nothing was deleted/);
    assert.ok(!ui.phases.some(p => p.phase === "ritual"));
  } finally { t.cleanup(); }
});

test("restore outcomes: each message shown verbatim; made -> no continue prompt", async () => {
  const t = tree();
  try {
    for (const outcome of ["skipped-24h", "needs-admin", "disabled", "failed"]) {
      const a = vetted(t.f("a" + outcome.length));
      const startRun = fakeStart();
      const { c, ui } = make(t, { runScan: async () => resultFor(t, [a]), startRun, ui: fakeUi({ continue: false }),
        restore: async () => ({ outcome, message: "ignored", detail: outcome }) });
      await c.scanSmart();
      await c.delete({ ids: [a.id] });
      assert.deepEqual(ui.asks, [RESTORE_MESSAGES[outcome] + " Continue without a restore point?"], outcome);
      const restorePhases = ui.phases.filter(p => p.phase === "restore");
      assert.equal(restorePhases[0].detail, undefined, "first the in-progress screen");
      assert.equal(restorePhases.at(-1).detail, RESTORE_MESSAGES[outcome], "then exactly what happened");
      assert.ok(!ui.phases.some(p => p.phase === "restore" && p.detail === RESTORE_MESSAGES.made), "never claims a restore point it did not get");
      assert.equal(startRun.calls.length, 0);
    }
    // continue without a restore point: the run starts
    {
      const a = vetted(t.f("cont"));
      const startRun = fakeStart();
      const { c, ui } = make(t, { runScan: async () => resultFor(t, [a]), startRun, ui: fakeUi({ continue: true }),
        restore: async () => ({ outcome: "disabled", message: "x", detail: "disabled" }) });
      await c.scanSmart();
      assert.equal((await c.delete({ ids: [a.id] })).ok, true);
      assert.equal(startRun.calls.length, 1);
      assert.equal(ui.asks.length, 1);
    }
    // a throwing restore step (e.g. its folder is missing) is reported as failed, never as made
    {
      const a = vetted(t.f("thr"));
      const startRun = fakeStart();
      const { c, ui } = make(t, { runScan: async () => resultFor(t, [a]), startRun, ui: fakeUi({ continue: false }),
        restore: async () => { throw new TypeError("resultDir must be an existing folder C:\\secret"); } });
      await c.scanSmart();
      await c.delete({ ids: [a.id] });
      assert.deepEqual(ui.asks, [RESTORE_MESSAGES.failed + " Continue without a restore point?"]);
      assert.ok(!JSON.stringify(ui.phases).includes("secret"));
    }
    // made: no prompt, the screen says it was made, the run starts with a 16-hex run id in paths.restoreDir
    {
      const a = vetted(t.f("made"));
      const startRun = fakeStart();
      const { c, ui, restoreCalls } = make(t, { runScan: async () => resultFor(t, [a]), startRun });
      await c.scanSmart();
      await c.delete({ ids: [a.id] });
      assert.equal(ui.asks.length, 0);
      assert.ok(ui.phases.some(p => p.phase === "restore" && p.detail === RESTORE_MESSAGES.made));
      assert.equal(startRun.calls.length, 1);
      assert.match(restoreCalls[0].runId, /^[0-9a-f]{16}$/);
      assert.equal(Object.hasOwn(restoreCalls[0], "resultDir"), false); // the outcome comes back as an exit code, not a file
      assert.equal(restoreCalls[0].elevated, false);
    }
  } finally { t.cleanup(); }
});

test("adminContents follows identity.elevated === true (Phase 1b)", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a"));
    const startRun = fakeStart();
    // R41: elevated, only files directly inside an administrator folder are deletable (here the temp tree stands in for one)
    const { c, restoreCalls } = make(t, { runScan: async () => resultFor(t, [a]), startRun, identity: { sid: SID, elevated: true }, adminDirs: () => [t.junk] });
    await c.scanSmart();
    await c.delete({ ids: [a.id] });
    assert.equal(startRun.calls.length, 1);
    assert.equal(startRun.calls[0].opts.adminContents, true);
    assert.deepEqual(Object.keys(startRun.calls[0].opts).sort(), ["adminContents", "onProgress", "plainConfirm", "runDir", "scanStartMs"]);
    assert.equal(startRun.calls[0].opts.runDir, t.paths.runDir);
    assert.equal(restoreCalls[0].elevated, true);
  } finally { t.cleanup(); }
});

test("busy: a second scan or delete while one runs is refused", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a"));
    let release;
    const gate = new Promise(r => { release = r; });
    let first = true;
    const runScan = async () => { if (first) { first = false; await gate; } return resultFor(t, [a]); };
    let confirmRelease;
    const confirmGate = new Promise(r => { confirmRelease = r; });
    const ui = fakeUi();
    ui.confirmPermanent = async () => { await confirmGate; return false; };
    const { c } = make(t, { runScan, ui });
    const p = c.scanSmart();
    await tick();
    await assert.rejects(c.scanSmart(), e => e.message === BUSY_MESSAGE);
    await assert.rejects(c.scanInvestigate(), e => e.message === BUSY_MESSAGE);
    await assert.rejects(c.scanAgain(), e => e.message === BUSY_MESSAGE);
    await assert.rejects(c.delete({ ids: [a.id] }), e => e.message === BUSY_MESSAGE);
    release();
    assert.equal((await p).ok, true);
    const d = c.delete({ ids: [a.id] });
    await tick();
    await assert.rejects(c.scanSmart(), e => e.message === BUSY_MESSAGE);
    await assert.rejects(c.delete({ ids: [a.id] }), e => e.message === BUSY_MESSAGE);
    confirmRelease();
    await d;
    assert.equal((await c.scanSmart()).ok, true, "free again afterwards");
  } finally { t.cleanup(); }
});

test("errors: one channel. Main-window calls send phase 'error' with a fixed text and resolve; paths never reach the renderer", async () => {
  const t = tree();
  try {
    const secret = path.join(t.root, "SECRET-PATH");
    const { c, ui } = make(t, { runScan: async () => { throw new Error("EACCES " + secret); } });
    const r = await c.scanSmart();
    assert.equal(r.ok, false);
    const last = ui.phases.at(-1);
    assert.equal(last.phase, "error");
    assert.ok(!JSON.stringify(ui.phases).includes("SECRET"));
    // a picked item that vanished between scan and delete: revalidate refuses it, the message is generic, nothing starts
    const a = vetted(t.f("a"));
    const startRun = fakeStart();
    const m = make(t, { runScan: async () => resultFor(t, [a]), startRun });
    await m.c.scanSmart();
    fs.rmSync(a.path);
    const d = await m.c.delete({ ids: [a.id] });
    assert.equal(d.ok, false);
    assert.equal(startRun.calls.length, 0);
    assert.equal(m.ui.phases.at(-1).phase, "error");
    assert.ok(!JSON.stringify(m.ui.phases).includes(t.root), "no path in any phase");
    // the start step failing (e.g. another run holds the lock) is generic too
    const b = vetted(t.f("b"));
    const m2 = make(t, { runScan: async () => resultFor(t, [b]), startRun: async () => { throw new Error("locked by " + secret); } });
    await m2.c.scanSmart();
    assert.equal((await m2.c.delete({ ids: [b.id] })).ok, false);
    assert.ok(!JSON.stringify(m2.ui.phases).includes("SECRET"));
    // results-window calls reject with a fixed message instead (that window shows its own error line)
    const m3 = make(t, { runScan: (() => { let n = 0; return async () => { if (++n > 1) throw new Error("boom " + secret); return resultFor(t, [b]); }; })() });
    await m3.c.scanSmart();
    await assert.rejects(m3.c.scanAgain(), e => e.message === GENERIC_ERROR);
    assert.ok((await m3.c.resultsGet()).rows.length === 1, "the earlier result is kept when Scan Again fails");
  } finally { t.cleanup(); }
});

test("results: nothing found -> no results window and a clear message; results:close returns to the start", async () => {
  const t = tree();
  try {
    const { c, ui } = make(t, { runScan: async () => resultFor(t, []) });
    const r = await c.scanSmart();
    assert.equal(r.ok, true);
    assert.equal(ui.shown, 0);
    assert.deepEqual(ui.phases.at(-1), { phase: "results", detail: "Scan finished. Nothing was found." });
    const a = vetted(t.f("a"));
    const m = make(t, { runScan: async () => resultFor(t, [a]) });
    await m.c.scanSmart();
    assert.equal(m.ui.shown, 1);
    assert.deepEqual(m.ui.phases.at(-1), { phase: "results", detail: "Scan finished." });
    const v = await m.c.resultsGet();
    assert.equal(v.rows[0].id, a.id);
    assert.equal(JSON.stringify(v).includes(t.root.slice(0, 3) + "nonexistent"), false);
    await m.c.resultsClose();
    assert.equal(m.ui.closed, 1);
    assert.equal(m.ui.phases.at(-1).phase, "idle");
    await assert.rejects(m.c.resultsGet(), /refused/);
    await assert.rejects(m.c.delete({ ids: [a.id] }), /refused/);
  } finally { t.cleanup(); }
});

test("picker cancelled -> back to the start, nothing scanned", async () => {
  const t = tree();
  try {
    let scans = 0;
    const { c, ui } = make(t, { runScan: async () => { scans++; return resultFor(t, []); } });
    assert.equal((await c.scanInvestigate()).ok, false);
    assert.equal((await c.scanFolder()).ok, false);
    assert.equal(scans, 0);
    assert.equal(ui.phases.at(-1).phase, "idle");
  } finally { t.cleanup(); }
});

test("ritual: server states map to honest endings; the window closing while armed closes the server", async () => {
  const t = tree();
  try {
    for (const [final, re] of [["expired", /Nothing was deleted/], ["aborted", /before anything was deleted/]]) {
      const a = vetted(t.f("a" + final));
      const startRun = fakeStart(final);
      const { c, ui } = make(t, { runScan: async () => resultFor(t, [a]), startRun });
      await c.scanSmart();
      await c.delete({ ids: [a.id] });
      assert.match(ui.phases.at(-1).detail, re, final);
      assert.equal(ui.ritual.closedByMain, true, "the ritual window is closed by main when the run ends early");
    }
    const a = vetted(t.f("closed"));
    let state = "armed";
    const server = { runId: "0123456789abcdef", getState: () => state, closed: false, close() { server.closed = true; } };
    const startRun = async sel => ({ url: "http://127.0.0.1:1/?t=" + "e".repeat(64), server, selection: sel, sha256: sel.sha256, runId: server.runId });
    const ui = fakeUi({ onRitual: (_u, w) => { state = "unlocked"; w.cb(); } });
    const { c } = make(t, { runScan: async () => resultFor(t, [a]), startRun, ui });
    await c.scanSmart();
    const r = await c.delete({ ids: [a.id] });
    assert.equal(r.ok, false);
    assert.equal(server.closed, true);
    assert.deepEqual(ui.phases.at(-1), { phase: "done", detail: "Cancelled. Nothing was deleted." });
    // done: counts come from this run's audit lines; "could not be measured" when measured is false
    const b = vetted(t.f("done"));
    const m = make(t, { runScan: async () => resultFor(t, [b]), startRun: fakeStart("done"),
      readAudit: () => [{ state: "done", runId: "0123456789abcdef", measured: false, freedBytes: 0,
        results: [{ status: "deleted", bytes: 5 }, { status: "deleted", bytes: 5 }, { status: "failed", bytes: 0 }, { status: "skipped", bytes: 0 }] },
      { state: "done", runId: "ffffffffffffffff", measured: true, freedBytes: 999, results: [] }] });
    await m.c.scanSmart();
    const d = await m.c.delete({ ids: [b.id] });
    assert.equal(d.ok, true);
    const last = m.ui.phases.at(-1);
    assert.equal(last.phase, "done");
    assert.deepEqual({ deleted: last.deleted, failed: last.failed, skipped: last.skipped, freedBytes: last.freedBytes, measured: last.measured },
      { deleted: 2, failed: 1, skipped: 1, freedBytes: 0, measured: false });
    assert.match(last.detail, /could not be measured/);
    assert.match(last.detail, /2 items deleted/);
    assert.match(last.detail, /1 could not be deleted/);
  } finally { t.cleanup(); }
});

test("Task 20 ritualCancel: before the press it cancels like closing the old window (server closed, audit cancelled, nothing deleted); after the press it is refused", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("rc"));
    let state = "armed";
    const server = { runId: "0123456789abcdef", getState: () => state, closed: false, close() { server.closed = true; } };
    const startRun = async sel => ({ url: "http://127.0.0.1:1/?t=" + "e".repeat(64), server, selection: sel, sha256: sel.sha256, runId: server.runId });
    let cancelResult;
    const ui = fakeUi({ onRitual: async (_u, w) => { w.close = () => { w.closedByMain = true; w.cb(); }; cancelResult = await ctl.ritualCancel(); } });
    const ctl = make(t, { runScan: async () => resultFor(t, [a]), startRun, ui }).c;
    await ctl.scanSmart();
    const r = await ctl.delete({ ids: [a.id] });
    assert.deepEqual(cancelResult, { ok: true });
    assert.equal(r.cancelled, true);
    assert.equal(server.closed, true);
    assert.deepEqual(ui.phases.at(-1), { phase: "done", detail: "Cancelled. Nothing was deleted." });
    assert.equal(fs.existsSync(a.path), true);
    await assert.rejects(ctl.ritualCancel(), /refused/, "nothing to cancel any more");
    // pressed (server past unlocked): refused, window untouched
    const b = vetted(t.f("rd"));
    let st2 = "unlocked"; let refusedErr = null;
    const server2 = { runId: "0123456789abcdef", getState: () => st2, closed: false, close() { server2.closed = true; } };
    const ui2 = fakeUi({ onRitual: async (_u, w) => { st2 = "deleting"; try { await ctl2.ritualCancel(); } catch (e) { refusedErr = e; } st2 = "done"; } });
    const ctl2 = make(t, { runScan: async () => resultFor(t, [b]), startRun: async sel => ({ url: "http://127.0.0.1:1/?t=" + "e".repeat(64), server: server2, selection: sel, sha256: sel.sha256, runId: server2.runId }), ui: ui2 }).c;
    await ctl2.scanSmart();
    await ctl2.delete({ ids: [b.id] });
    assert.match(refusedErr.message, /refused/);
    assert.equal(server2.closed, false);
  } finally { t.cleanup(); }
});

// ---- Fix round 1 ----
test("M6 busy is a friendly sentence", () => {
  assert.equal(BUSY_MESSAGE, "Another operation is still running. Please wait.");
});

test("M5 restore timeout shows the timeout message verbatim (not 'Windows reported an error')", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a"));
    const startRun = fakeStart();
    const { c, ui } = make(t, { runScan: async () => resultFor(t, [a]), startRun, ui: fakeUi({ continue: false }),
      restore: async () => ({ outcome: "failed", message: TIMEOUT_MESSAGE, detail: "timeout" }) });
    await c.scanSmart();
    await c.delete({ ids: [a.id] });
    assert.deepEqual(ui.asks, [TIMEOUT_MESSAGE + " Continue without a restore point?"]);
    assert.equal(ui.phases.filter(p => p.phase === "restore").at(-1).detail, TIMEOUT_MESSAGE);
    assert.equal(startRun.calls.length, 0);
  } finally { t.cleanup(); }
});

test("M2 closing the results window during Scan Again: the late scan neither restores the result nor sends 'results'", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a"));
    let n = 0, release;
    const gate = new Promise(r => { release = r; });
    const runScan = async () => { if (++n === 2) await gate; return resultFor(t, [a]); };
    const { c, ui } = make(t, { runScan });
    await c.scanSmart();
    const again = c.scanAgain();
    await tick();
    await c.resultsClose();
    assert.equal(ui.phases.at(-1).phase, "idle");
    release();
    await assert.rejects(again);
    assert.equal(ui.phases.at(-1).phase, "idle", "no late 'results' phase");
    await assert.rejects(c.resultsGet(), /refused/);
    await assert.rejects(c.delete({ ids: [a.id] }), /refused/);
  } finally { t.cleanup(); }
});

test("M3 audit: the done line is found in a bounded tail of a large log; a done run without readable audit is still reported as finished", async () => {
  const t = tree();
  try {
    const f = path.join(t.paths.runDir, "nuke-audit.log");
    const junk = JSON.stringify({ state: "done", runId: "1111111111111111", pad: "x".repeat(200) }) + "\n";
    fs.writeFileSync(f, junk.repeat(2000) + JSON.stringify({ state: "started", runId: "0123456789abcdef" }) + "\n" +
      JSON.stringify({ state: "done", runId: "0123456789abcdef", measured: true, freedBytes: 5, results: [{ status: "deleted" }] }) + "\n");
    assert.ok(fs.statSync(f).size > 64 * 1024);
    const lines = readAuditLines(t.paths.runDir, "0123456789abcdef", { maxBytes: 64 * 1024 });
    assert.deepEqual(lines.map(l => l.state), ["started", "done"]);
    // the server says done but the audit cannot be read: done (not error), counts unknown, nothing claimed
    const b = vetted(t.f("b"));
    const m = make(t, { runScan: async () => resultFor(t, [b]), startRun: fakeStart("done"), readAudit: () => [] });
    await m.c.scanSmart();
    const r = await m.c.delete({ ids: [b.id] });
    assert.equal(r.ok, true);
    const last = m.ui.phases.at(-1);
    assert.equal(last.phase, "done");
    assert.match(last.detail, /details could not be read/);
  } finally { t.cleanup(); }
});

test("M8 early-stop texts do not repeat themselves", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a"));
    const { c, ui } = make(t, { runScan: async () => resultFor(t, [a]), startRun: fakeStart("aborted") });
    await c.scanSmart();
    await c.delete({ ids: [a.id] });
    const d = ui.phases.at(-1).detail;
    assert.equal((d.match(/deleted/g) || []).length, 1, d);
  } finally { t.cleanup(); }
});
