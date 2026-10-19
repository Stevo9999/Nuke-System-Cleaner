// Flow end-to-end: real worker scan (Smart Scan), real investigator, real freeze + hash, real one-shot server and real deletion,
// all on fixture trees under os.tmpdir() (fixture/make-app-fixture.mjs). The fake ui "presses the button" by POSTing /unlock
// then /confirm with the token from the url handed to openRitual, exactly like test/e2e.test.mjs. Run from PowerShell.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeAppFixture } from "../../fixture/make-app-fixture.mjs";
import { createController } from "../../app/main/controller.mjs";
import { runScan } from "../../app/main/scan-runner.mjs";
import { appDataPaths, ensureAppData, appProtectedPaths, appProtectedRoots, saveSettings } from "../../app/main/appdata.mjs";
import { startFrozenRun } from "../../run.mjs";
import { investigate } from "../../lib/investigate.mjs";
import { readLnk } from "../../lib/lnk.mjs";
import { displayText } from "../../app/main/view-model.mjs";

const WIN = process.platform === "win32";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIN_GAP = 150;
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
const wait = ms => new Promise(r => setTimeout(r, ms));

function call(port, method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, res => {
      let d = ""; res.on("data", x => d += x); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject); if (method === "POST") req.write("{}"); req.end();
  });
}
// The "user": turns the key (POST /unlock), waits the minimum gap, presses the button (POST /confirm).
async function press(url) {
  const u = new URL(url);
  const port = Number(u.port), token = u.searchParams.get("t");
  const h = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-nuke-token": token };
  assert.equal((await call(port, "POST", "/unlock", h)).status, 200);
  await wait(MIN_GAP + 100);
  assert.equal((await call(port, "POST", "/confirm", h)).status, 200);
}

function fakeUi(o = {}) {
  const ui = {
    phases: [], progress: [], shown: 0, closed: 0, asks: [], ritualUrls: [], pressErrors: [],
    pickFile: async () => (o.file ?? null),
    pickFolder: async () => (o.folder ?? null),
    sendProgress: p => ui.progress.push(p),
    sendPhase: p => ui.phases.push(p),
    showResults: () => { ui.shown++; },
    closeResults: () => { ui.closed++; },
    confirmPermanent: async () => true,
    askContinueWithoutRestore: async m => { ui.asks.push(m); return true; },
    openRitual: url => {
      ui.ritualUrls.push(url);
      const w = { cb: null, onClosed(cb) { w.cb = cb; }, close() { w.closedByMain = true; } };
      ui.ritual = w;
      setImmediate(() => (o.onRitual ? o.onRitual(url, w) : press(url)).catch(e => ui.pressErrors.push(e)));
      return w;
    },
  };
  return ui;
}

// Everything the main process would pass, pointed at the fixture. Restore is switched off (no real restore point in tests).
function setup({ ui = fakeUi(), inProcessInvestigate = false, sid } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-flow-"));
  const fx = makeAppFixture(path.join(base, "fx"));
  assert.ok(!WIN || fx.creationTimesSet, "fixture creation times back-dated: " + fx.notes.join("; "));
  const env = { ...fx.env, SystemRoot: path.join(fx.dir, "Windows") };
  const paths = appDataPaths(env);
  ensureAppData(paths);
  saveSettings(paths.settingsFile, { restorePoint: false, plainConfirm: false });
  const protectedPaths = appProtectedPaths({ appDir: REPO, dataRoot: paths.root, home: fx.dir, env });
  const protectedRoots = appProtectedRoots({ home: fx.dir, env });
  const regQuery = async name => {
    if (name === "uninstallHKCU") return { ok: true, keys: [{ path: "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FakeApp", values: {
      DisplayName: { type: "REG_SZ", data: "FakeApp" }, Publisher: { type: "REG_SZ", data: "FakePub" },
      InstallLocation: { type: "REG_SZ", data: fx.paths.appDir }, UninstallString: { type: "REG_SZ", data: '"' + fx.paths.exe + '" /uninstall' } } }] };
    return { ok: true, keys: [] };
  };
  // Smart Scan goes through the real worker (runScan); env is the fixture's (main itself passes nothing: the worker uses process.env).
  const scan = async (kind, args, opts) => {
    if (kind === "investigate" && inProcessInvestigate) {
      return investigate(args.target, { ...args, env, home: fx.dir, regQuery, listScheduledTasks: async () => ({ ok: true, tasks: [] }), readLnk,
        onProgress: m => opts.onProgress({ fraction: null, label: String(m) }), signal: opts.signal });
    }
    return runScan(kind, { ...args, env }, opts);
  };
  const startRun = (sel, opts) => startFrozenRun(sel, { ...opts, serverOpts: { minGapMs: MIN_GAP, afterDoneMs: 50, ttlMs: 20000 } });
  const controller = createController({ ui, paths, identity: { sid: sid ?? fx.sid, elevated: false }, runScan: scan, startRun,
    protectedPaths, protectedRoots, profileRoot: fx.dir, pollMs: 20 });
  const cleanup = () => {
    try { fs.unlinkSync(fx.paths.junction); } catch { try { fs.rmdirSync(fx.paths.junction); } catch { /* gone */ } }
    fs.rmSync(base, { recursive: true, force: true });
  };
  return { base, fx, env, paths, ui, controller, cleanup };
}
const tickedIds = view => view.rows.filter(r => r.ticked && !r.companionOf).map(r => r.id);
const auditLines = paths => {
  const f = path.join(paths.runDir, "nuke-audit.log");
  return exists(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
};
const rowFor = (view, p) => view.rows.find(r => r.path.toLowerCase() === displayText(p, 260).toLowerCase());

test("e2e smart scan: only old, unlocked, link-free items deleted; young file, junction victim and protected folders survive; audit in paths.runDir", async () => {
  const s = setup();
  try {
    const { fx, controller, ui, paths } = s;
    const r = await controller.scanSmart();
    assert.equal(r.ok, true);
    assert.equal(ui.shown, 1);
    const view = await controller.resultsGet();
    for (const p of [...fx.paths.oldFiles, fx.paths.oldDir, fx.paths.dump, ...fx.paths.hostile]) {
      const row = rowFor(view, p);
      assert.ok(row && row.ticked, "pre-ticked: " + JSON.stringify(p));
    }
    assert.ok(fx.paths.hostile.length >= 3, "RTL / zero-width / unicode names were created");
    assert.ok(view.rows.every(r => !/[\u202e\u200b\n]/.test(r.path + r.label)), "hostile characters never reach the view");
    for (const p of [fx.paths.youngFile, fx.paths.youngDir, fx.paths.junction]) assert.equal(rowFor(view, p), undefined, "not offered: " + p);
    assert.ok(ui.progress.length > 0 && ui.progress.every(p => Object.keys(p).sort().join() === "fraction,label"));
    const d = await controller.delete({ ids: tickedIds(view) });
    assert.equal(d.ok, true, JSON.stringify(ui.phases.at(-1)) + ui.pressErrors.join());
    for (const p of [...fx.paths.oldFiles, fx.paths.oldDir, fx.paths.dump, ...fx.paths.hostile]) assert.equal(exists(p), false, "deleted: " + p);
    for (const p of [fx.paths.youngFile, fx.paths.youngDir, fx.paths.temp, fx.paths.precious, fx.paths.victim, fx.paths.documents, fx.paths.exe,
      fx.paths.roamingLeft, fx.paths.rbI, fx.paths.rbR, paths.root]) assert.ok(exists(p), "kept: " + p);
    if (fx.junctionCreated) assert.ok(exists(fx.paths.junction), "the junction itself is not offered and stays");
    const lines = auditLines(paths);
    const done = lines.find(l => l.state === "done");
    assert.ok(lines.find(l => l.state === "started") && done, "started + done lines in paths.runDir");
    assert.equal(done.results.filter(x => x.status === "deleted").length, tickedIds(view).length);
    const last = ui.phases.at(-1);
    assert.equal(last.phase, "done");
    assert.equal(last.deleted, tickedIds(view).length);
    assert.equal(typeof last.measured, "boolean");
    assert.match(last.detail, last.measured ? /Free space went up by/ : /could not be measured/);
    // "checking" / "deleting" are live-count phases (whether "deleting" is seen depends on the poll timing), so they are left out here.
    assert.deepEqual(ui.phases.map(p => p.phase).filter(p => p !== "checking" && p !== "deleting").filter((p, i, a) => a.indexOf(p) === i), ["scanning", "results", "ritual", "done"]);
    assert.equal(ui.closed, 1, "results window closed once the warning was accepted");
    await assert.rejects(controller.resultsGet(), /refused/, "the old result is gone after a run");
  } finally { s.cleanup(); }
});

test("e2e investigate FakeApp: high leftovers deleted, report-only entry untouched, shared publisher folder kept unless ticked", async () => {
  let s = setup({ inProcessInvestigate: true });
  try {
    const { fx, controller, ui } = s;
    ui.pickFile = async () => fx.paths.exe;
    assert.equal((await controller.scanInvestigate()).ok, true);
    const view = await controller.resultsGet();
    const high = [fx.paths.exe, fx.paths.appDir, fx.paths.localLeft, fx.paths.roamingLeft, fx.paths.publisherProduct, fx.paths.shortcut];
    for (const p of high) { const row = rowFor(view, p); assert.ok(row && row.ticked && row.confidence === "high", "high + ticked: " + p); }
    const pub = rowFor(view, fx.paths.publisher);
    assert.ok(pub && pub.group === "shared" && !pub.ticked && pub.selectable, "publisher folder is shared and unticked");
    const entry = view.rows.find(r => r.group === "report-only" && r.label === "FakeApp");
    assert.ok(entry && entry.selectable === false, "program entry is report-only");
    await assert.rejects(controller.delete({ ids: [entry.id] }), /refused/);
    const d = await controller.delete({ ids: tickedIds(view) });
    assert.equal(d.ok, true, JSON.stringify(ui.phases.at(-1)) + ui.pressErrors.join());
    for (const p of high) assert.equal(exists(p), false, "deleted: " + p);
    assert.ok(exists(fx.paths.publisher) && exists(fx.paths.publisherOther), "shared publisher folder kept");
    assert.ok(exists(fx.paths.documents) && exists(path.join(fx.dir, "Local", "Programs")) && exists(fx.paths.temp));
  } finally { s.cleanup(); }
  s = setup({ inProcessInvestigate: true });
  try {
    const { fx, controller, ui } = s;
    ui.pickFile = async () => fx.paths.exe;
    await controller.scanInvestigate();
    const view = await controller.resultsGet();
    const pub = rowFor(view, fx.paths.publisher);
    assert.equal((await controller.delete({ ids: [pub.id] })).ok, true, ui.pressErrors.join());
    assert.equal(exists(fx.paths.publisher), false, "ticked by the user: deleted");
    assert.ok(exists(fx.paths.exe) && exists(fx.paths.roamingLeft), "nothing else");
  } finally { s.cleanup(); }
});

// A child process that holds a file open with no sharing, so the delete genuinely fails. Absolute exe path, array args.
function lockFile(f) {
  const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$h=[IO.File]::Open('${f.replace(/'/g, "''")}','Open','ReadWrite','None'); Write-Host LOCKED; Start-Sleep 60`;
  const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((res, rej) => {
    child.stdout.on("data", d => { if (String(d).includes("LOCKED")) res(child); });
    child.on("exit", () => rej(new Error("lock helper exited")));
  });
}

test("item locked after the scan is caught before the run starts: nothing is deleted, no confirm window", { skip: !WIN }, async () => {
  const s = setup();
  let locker = null;
  try {
    const { fx, controller, ui } = s;
    await controller.scanSmart();
    const view = await controller.resultsGet();
    const ids = tickedIds(view);
    const victim = fx.paths.oldFiles[0];
    locker = await lockFile(victim);
    // Task 19A1: main re-checks age and lock just before the run starts. (A file that becomes locked after that still fails alone
    // at delete time: see "a locked file fails that item only" in test/delete.test.mjs.)
    assert.equal((await controller.delete({ ids })).ok, false);
    assert.equal(ui.ritualUrls.length, 0, "no confirm window");
    assert.match(ui.phases.at(-1).detail, /changed or are no longer safe/);
    for (const p of [victim, fx.paths.oldFiles[1], fx.paths.oldDir, fx.paths.dump]) assert.ok(exists(p), p);
  } finally {
    if (locker) await new Promise(r => { locker.once("exit", r); locker.kill(); });
    s.cleanup();
  }
});

test("ritual window closed before the button -> server closed, phase says nothing was deleted, files intact", async () => {
  let port = 0;
  const ui = fakeUi({ onRitual: async (url, w) => { port = Number(new URL(url).port); w.cb(); } });
  const s = setup({ ui });
  try {
    const { fx, controller, paths } = s;
    await controller.scanSmart();
    const view = await controller.resultsGet();
    const r = await controller.delete({ ids: tickedIds(view) });
    assert.equal(r.ok, false);
    assert.deepEqual(ui.phases.at(-1), { phase: "done", detail: "Cancelled. Nothing was deleted." });
    for (const p of [...fx.paths.oldFiles, fx.paths.oldDir, fx.paths.dump]) assert.ok(exists(p), p);
    assert.ok(port > 0);
    await assert.rejects(call(port, "GET", "/state"), "the server no longer listens");
    assert.ok(!auditLines(paths).some(l => l.state === "started" || l.state === "done"));
    assert.equal(exists(path.join(paths.runDir, "nuke.lock")), false, "lock released");
  } finally { s.cleanup(); }
});

test("Scan Again after an external delete reports it as removed; selection is rebuilt from the new result", async () => {
  const s = setup();
  try {
    const { fx, controller, ui } = s;
    await controller.scanSmart();
    const first = await controller.resultsGet();
    const goneRow = rowFor(first, fx.paths.oldFiles[1]);
    fs.rmSync(fx.paths.oldFiles[1]);
    const again = await controller.scanAgain();
    assert.ok(again.removed.length === 1 && again.removed[0].toLowerCase().includes("old-b.log"), JSON.stringify(again.removed));
    assert.equal(rowFor(again, fx.paths.oldFiles[1]), undefined);
    assert.deepEqual(await controller.resultsGet(), again, "results:get now serves the new view with its diff");
    await assert.rejects(controller.delete({ ids: [goneRow.id] }), /refused/);
    assert.equal((await controller.delete({ ids: tickedIds(again) })).ok, true, ui.pressErrors.join());
    assert.equal(exists(fx.paths.oldFiles[0]), false);
  } finally { s.cleanup(); }
});

test("cancel terminates the worker and leaves no result", async () => {
  const s = setup();
  try {
    const { controller, ui } = s;
    const p = controller.scanSmart();
    await controller.scanCancel();
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(ui.phases.at(-1).phase, "idle");
    assert.equal(ui.shown, 0);
    await assert.rejects(controller.resultsGet(), /refused/);
    const n = ui.progress.length;
    await wait(300);
    assert.equal(ui.progress.length, n, "no progress after the worker was stopped");
    // the runner itself: an aborted signal rejects AbortError and the worker never reports again
    const ac = new AbortController();
    const seen = [];
    const q = runScan("smart", { env: s.env }, { onProgress: x => seen.push(x), signal: ac.signal });
    ac.abort();
    await assert.rejects(q, e => e.name === "AbortError");
    const m = seen.length;
    await wait(300);
    assert.equal(seen.length, m);
    await assert.rejects(runScan("smart", { env: s.env }, { signal: AbortSignal.abort() }), e => e.name === "AbortError");
  } finally { s.cleanup(); }
});

test("the token/url never reaches sendPhase, sendProgress, the results view, the audit or any file in paths.root", async () => {
  const s = setup();
  try {
    const { controller, ui, paths } = s;
    await controller.scanSmart();
    const view = await controller.resultsGet();
    await controller.delete({ ids: tickedIds(view) });
    assert.equal(ui.ritualUrls.length, 1);
    const url = ui.ritualUrls[0];
    const token = new URL(url).searchParams.get("t");
    assert.match(token, /^[0-9a-f]{64}$/);
    const said = JSON.stringify([ui.phases, ui.progress, view]);
    assert.ok(!said.includes(token) && !said.includes("127.0.0.1"));
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const files = walk(paths.root);
    assert.ok(files.some(f => f.endsWith("nuke-audit.log")) && files.some(f => f.endsWith("selection.json")));
    for (const f of files) assert.ok(!fs.readFileSync(f, "latin1").includes(token), "token in " + f);
  } finally { s.cleanup(); }
});
