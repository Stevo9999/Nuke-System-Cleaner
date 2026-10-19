// Guided "Pick a folder to investigate": detect the owning program, ask FIRST, run its uninstaller, restart check, sweep, re-check.
// Fakes only: no process is started, nothing is uninstalled, and the only files touched are in a temp folder.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectAppForFolder, canonPath, pendingRenameHit, rebootAssessment, mergeInvestigations } from "../../lib/app-folder.mjs";
import { parseRegOutput } from "../../lib/sysread.mjs";
import { runUninstaller } from "../../lib/uninstall-run.mjs";
import { createController } from "../../app/main/controller.mjs";
import { appDataPaths, ensureAppData } from "../../app/main/appdata.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { RESTORE_MESSAGES } from "../../lib/restore.mjs";

const prog = (over = {}) => ({ id: "0123456789abcdef", name: "Foo Tool", publisher: "", version: "", sizeKb: null, installLocation: "", displayIcon: "", uninstallCommand: "", hive: "user", lossy: false, ...over });
const CMD = '"C:\\Foo\\unins000.exe" /SILENT';

// ---------- detection ----------

test("detect: equal InstallLocation matches (case and trailing separator ignored); the command is returned parsed", () => {
  for (const loc of ["C:\\Foo", "c:\\foo\\", "C:\\FOO"]) {
    const d = detectAppForFolder([prog({ installLocation: loc, uninstallCommand: CMD })], "C:\\Foo");
    assert.equal(d.kind, "one");
    assert.equal(d.runnable, true);
    assert.deepEqual(d.command, { exe: "C:\\Foo\\unins000.exe", args: "/SILENT", verbatim: true });
  }
});

test("detect: the folder equals or contains the folder of the DisplayIcon or of the uninstaller", () => {
  const icon = prog({ displayIcon: '"C:\\Apps\\Foo\\bin\\foo.exe",0', uninstallCommand: '"C:\\Apps\\Foo\\unins.exe"' });
  assert.equal(detectAppForFolder([icon], "C:\\Apps\\Foo\\bin").kind, "one", "folder equals the icon's folder");
  assert.equal(detectAppForFolder([icon], "C:\\Apps\\Foo").kind, "one", "folder contains the icon's folder");
  assert.equal(detectAppForFolder([prog({ uninstallCommand: '"C:\\Apps\\Bar\\unins.exe"' })], "C:\\Apps\\Bar").kind, "one", "uninstaller folder");
  assert.equal(detectAppForFolder([prog({ uninstallCommand: '"C:\\Apps\\Bar\\unins.exe"' })], "C:\\Apps").kind, "one", "folder contains the uninstaller folder");
});

test("detect: parent/child mismatch and lookalike prefixes never match", () => {
  const inst = prog({ installLocation: "C:\\Foo", uninstallCommand: CMD });
  assert.equal(detectAppForFolder([inst], "C:\\Foo\\sub").kind, "none", "a child of the install location is not the install location");
  assert.equal(detectAppForFolder([inst], "C:\\FooBar").kind, "none", "lookalike prefix");
  assert.equal(detectAppForFolder([inst], "C:\\Fo").kind, "none");
  const icon = prog({ displayIcon: "C:\\Foo\\bin\\f.exe", uninstallCommand: "" });
  assert.equal(detectAppForFolder([icon], "C:\\Foo\\bin\\deeper").kind, "none", "the folder must equal or contain the icon folder");
  assert.equal(detectAppForFolder([icon], "C:\\Foo\\bi").kind, "none");
  assert.equal(detectAppForFolder([icon], "C:\\FooBar\\bin").kind, "none");
});

test("detect: never by name; odd paths, drive roots and the Windows folder never match", () => {
  assert.equal(detectAppForFolder([prog({ name: "Foo", installLocation: "D:\\Other", uninstallCommand: '"D:\\Other\\u.exe"' })], "C:\\Foo").kind, "none");
  for (const bad of ["C:\\", "C:", "relative\\Foo", "C:\\Foo\\..\\Foo", "C:\\Foo/", "\\\\host\\share\\Foo", "C:\\Fo?o", "C:\\Foo.", "", null, 5, "C:\\Foo\\\\bar"])
    assert.equal(detectAppForFolder([prog({ installLocation: "C:\\Foo", uninstallCommand: CMD })], bad).kind, "none", String(bad));
  const sys = prog({ displayIcon: "C:\\Windows\\Installer\\{1}\\icon.exe", uninstallCommand: "MsiExec.exe /X{AC76BA86-7AD7-1033-7B44-AC0F074E4100}" });
  assert.equal(detectAppForFolder([sys], "C:\\Windows").kind, "none");
  assert.equal(detectAppForFolder([sys], "C:\\Windows\\Installer").kind, "none");
  assert.equal(detectAppForFolder([sys], "C:\\Windows\\System32").kind, "none", "the msiexec folder is no evidence");
  assert.equal(detectAppForFolder([prog({ installLocation: "C:\\Foo", uninstallCommand: CMD })], "C:\\").kind, "none");
});

test("detect: lossy text or an unparsable command is found but NOT runnable", () => {
  const lossy = detectAppForFolder([prog({ installLocation: "C:\\Foo", uninstallCommand: CMD, lossy: true })], "C:\\Foo");
  assert.deepEqual([lossy.kind, lossy.runnable, lossy.reason], ["one", false, "lossy"]);
  for (const cmd of ["cmd.exe /c del x", "%ProgramFiles%\\Foo\\u.exe", "", "MsiExec.exe /X{bad}", "C:\\Foo\\u.bat"]) {
    const d = detectAppForFolder([prog({ installLocation: "C:\\Foo", uninstallCommand: cmd })], "C:\\Foo");
    assert.deepEqual([d.kind, d.runnable, d.reason, d.command], ["one", false, "unparsable", undefined], cmd);
  }
});

test("detect: two different matching programs are never guessed between; the same program registered twice is one", () => {
  const a = prog({ id: "aaaaaaaaaaaaaaaa", name: "Foo Tool", installLocation: "C:\\Foo", uninstallCommand: CMD });
  const b = prog({ id: "bbbbbbbbbbbbbbbb", name: "Foo Helper", installLocation: "C:\\Foo", uninstallCommand: '"C:\\Foo\\h.exe"' });
  const d = detectAppForFolder([a, b], "C:\\Foo");
  assert.equal(d.kind, "several");
  assert.equal(d.programs.length, 2);
  assert.equal(detectAppForFolder([a, { ...a, id: "cccccccccccccccc" }], "C:\\Foo").kind, "one");
  assert.equal(canonPath("C:\\Foo\\"), "c:\\foo");
});

// ---------- restart evidence ----------

const regText = data => Buffer.from("\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\r\n    PendingFileRenameOperations    REG_MULTI_SZ    " + data + "\r\n\r\n", "latin1");
const regResult = data => ({ ok: true, keys: parseRegOutput(regText(data)) });

test("restart evidence: exit codes 3010 and 1641 (1641 = initiated), or a PendingFileRenameOperations path inside the folders", () => {
  assert.deepEqual(rebootAssessment({ code: 3010, pending: null, folders: [] }), { needed: true, initiated: false });
  assert.deepEqual(rebootAssessment({ code: 1641, pending: null, folders: [] }), { needed: true, initiated: true });
  for (const code of [0, 1, 1602, 1603, null]) assert.equal(rebootAssessment({ code, pending: null, folders: ["C:\\Foo"] }).needed, false, String(code));
  const inside = regResult("\\??\\C:\\Foo\\bin\\a.dll\\0\\0\\??\\C:\\other\\x\\0\\0");
  assert.equal(pendingRenameHit(inside, ["C:\\Foo"]), true);
  assert.equal(rebootAssessment({ code: 0, pending: inside, folders: ["C:\\Zed", "c:\\foo"] }).needed, true);
  assert.equal(pendingRenameHit(regResult("!\\??\\C:\\Foo\\a.dll"), ["C:\\Foo"]), true, "the ! form");
  assert.equal(pendingRenameHit(regResult("\\??\\C:\\FooBar\\a.dll"), ["C:\\Foo"]), false, "lookalike prefix");
  assert.equal(pendingRenameHit(regResult("\\??\\C:\\other\\a.dll"), ["C:\\Foo"]), false);
  assert.equal(pendingRenameHit({ ok: true, keys: [] }, ["C:\\Foo"]), false, "value absent");
  for (const bad of [null, undefined, { ok: false }, { ok: true }, 5]) assert.equal(pendingRenameHit(bad, ["C:\\Foo"]), false);
});

test("mergeInvestigations: items de-duplicated by id, roots and notes united", () => {
  const f = p => makeFinding({ kind: "dir", path: p, label: p, bytes: 1, safe: { ok: true }, basis: "traced", reason: "r", category: "x" });
  const a = { kind: "investigate", target: "C:\\a", items: [f("C:\\a"), f("C:\\x")], allowedRoots: ["C:\\r"], protectedPaths: [], notes: ["n1"], partial: false };
  const b = { kind: "investigate", target: "C:\\b", items: [f("C:\\x"), f("C:\\b")], allowedRoots: ["C:\\r", "C:\\s"], protectedPaths: [], notes: ["n1", "n2"], partial: true };
  const m = mergeInvestigations(a, b);
  assert.equal(m.items.length, 3);
  assert.equal(m.target, "C:\\a");
  assert.deepEqual(m.allowedRoots, ["C:\\r", "C:\\s"]);
  assert.deepEqual(m.notes, ["n1", "n2"]);
  assert.equal(m.partial, true);
});

test("runUninstaller: Stop waiting ends the waiting only; the uninstaller is not killed", async () => {
  let killed = 0;
  const spawnFn = () => ({ once() {}, kill() { killed++; } });
  const ac = new AbortController();
  const p = runUninstaller({ exe: "C:\\a\\u.exe", args: "", spawnFn, exists: () => true, signal: ac.signal });
  ac.abort();
  assert.deepEqual(await p, { ok: false, reason: "stopped" });
  assert.equal(killed, 0);
  let started = 0;
  assert.deepEqual(await runUninstaller({ exe: "C:\\a\\u.exe", args: "", spawnFn: () => { started++; }, exists: () => true, signal: ac.signal }), { ok: false, reason: "stopped" });
  assert.equal(started, 0, "an already stopped wait starts nothing");
});

// ---------- the controller flow ----------

const SID = "S-1-5-21-11-22-33-1001";
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-flow-"));
  const home = path.join(root, "home");
  const app = path.join(home, "Apps", "Foo");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "left.txt"), "x");
  const paths = appDataPaths({ LOCALAPPDATA: path.join(home, "Local") });
  ensureAppData(paths);
  return { root, home, app, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const found = p => makeFinding({ kind: "dir", path: p, label: path.basename(p), bytes: 1, safe: { ok: true }, basis: "traced", userPicked: true, reason: "r", category: "picked" });

// answers: { first, restart }. events records the order of everything that matters.
function harness(t, o = {}) {
  const events = [];
  const phases = [];
  const asked = [];
  const programs = o.programs ?? [prog({ installLocation: t.app, uninstallCommand: '"' + path.join(t.app, "unins000.exe") + '" /SILENT' })];
  const u = {
    sendProgress() {}, sendPhase: p => phases.push(p), showResults() { events.push("results"); }, closeResults() {},
    confirmPermanent: async () => true, askContinueWithoutRestore: async () => true, pickFile: async () => null,
    pickFolder: async () => o.picked ?? t.app,
    askUninstallFirst: async m => { events.push("ask-first"); asked.push(m); return o.first ?? true; },
    askRestartContinue: async m => { events.push("ask-restart"); asked.push(m); return o.restart ?? true; },
    openRitual() { return { onClosed() {}, close() {} }; },
  };
  const scans = [];
  const ran = [];
  const startCalls = [];
  const c = createController({
    ui: u, paths: t.paths, identity: { sid: SID, elevated: false }, profileRoot: t.home,
    readPrograms: async () => { events.push("list"); return { ok: o.listOk ?? true, programs, notes: [] }; },
    readPendingRenames: o.noPending ? null : async () => { events.push("pending"); return o.pending ?? { ok: true, keys: [] }; },
    runProgramUninstaller: async x => { events.push("run"); ran.push(x); return o.run ? o.run(x) : { ok: true, code: o.code ?? 0 }; },
    runScan: async (k, a) => {
      events.push("scan"); scans.push({ k, a });
      const items = (o.itemsFor ? o.itemsFor(a.target) : [a.target]).map(found);
      return { kind: "investigate", target: a.target, items, allowedRoots: [path.dirname(a.target)], protectedPaths: [], notes: [] };
    },
    restore: async () => ({ outcome: "made", message: RESTORE_MESSAGES.made, detail: "made" }),
    startRun: async (sel, opts) => {
      events.push("start-run"); startCalls.push(sel);
      if (o.onRun) o.onRun(sel);
      let n = 0;
      const server = { runId: "0123456789abcdef", getState: () => (++n > 1 ? "done" : "armed"), close() {} };
      return { url: "http://127.0.0.1:1/?t=" + "f".repeat(64), server, selection: sel, sha256: sel.sha256, runId: server.runId };
    },
    readAudit: () => [{ state: "done", runId: "0123456789abcdef", results: [{ status: "deleted" }], measured: false }], pollMs: 1,
  });
  return { c, events, phases, asked, scans, ran, startCalls };
}

test("flow: the question comes first; Yes runs the exact parsed command, then the restart check, then the scan; the results screen is shown and nothing is deleted", async () => {
  const t = tree();
  try {
    const h = harness(t);
    const r = await h.c.scanFolder();
    assert.equal(r.ok, true);
    assert.deepEqual(h.events, ["list", "ask-first", "run", "pending", "scan", "results"]);
    assert.match(h.asked[0], /^This folder belongs to Foo Tool\. Run its own uninstaller first\? It will run: .*unins000\.exe \/SILENT/);
    assert.deepEqual(h.ran, [{ exe: path.join(t.app, "unins000.exe"), args: "/SILENT", signal: h.ran[0].signal }]);
    assert.ok(h.phases.some(p => p.phase === "uninstalling" && p.detail === "Running the uninstaller of Foo Tool..."));
    assert.equal(h.scans.length, 1);
    assert.equal(h.scans[0].a.target, t.app);
    assert.equal(h.startCalls.length, 0, "nothing is deleted by this part of the flow");
    assert.ok(fs.existsSync(path.join(t.app, "left.txt")));
    assert.match(h.phases.at(-1).detail, /uninstaller of Foo Tool has finished/);
  } finally { t.cleanup(); }
});

test("flow: answering No runs nothing at all and scans for leftovers only (the old behaviour); a dismissed question counts as No", async () => {
  const t = tree();
  try {
    const h = harness(t, { first: false });
    await h.c.scanFolder();
    assert.deepEqual(h.events, ["list", "ask-first", "scan", "results"]);
    assert.deepEqual(h.ran, []);
    assert.equal(h.scans[0].a.target, t.app);
    assert.equal(h.scans[0].a.also, undefined);
  } finally { t.cleanup(); }
});

test("flow: no detection, several matches, a lossy or unparsable command: no question, nothing run, leftovers-only with a clear line", async () => {
  const t = tree();
  try {
    const cases = [
      [[], /^Scan finished/],
      [[prog({ installLocation: t.app, uninstallCommand: CMD }), prog({ name: "Other", installLocation: t.app, uninstallCommand: '"C:\\Q\\u.exe"' })], /Several installed programs match this folder \(Foo Tool, Other\)/],
      [[prog({ installLocation: t.app, uninstallCommand: "cmd.exe /c del x" })], /Foo Tool, but its uninstall command cannot be read exactly/],
      [[prog({ installLocation: t.app, uninstallCommand: CMD, lossy: true })], /cannot be read exactly/],
    ];
    for (const [programs, re] of cases) {
      const h = harness(t, { programs });
      await h.c.scanFolder();
      assert.deepEqual(h.events, ["list", "scan", "results"]);
      assert.deepEqual(h.ran, []);
      assert.match(h.phases.at(-1).detail, re);
    }
    // an incomplete program list never offers an uninstaller
    const h = harness(t, { listOk: false });
    await h.c.scanFolder();
    assert.deepEqual(h.events, ["list", "scan", "results"]);
  } finally { t.cleanup(); }
});

test("restart: exit code 3010 asks first (before any scan), remembers the notice; Yes continues to the scan, No stops without scanning", async () => {
  const t = tree();
  try {
    const yes = harness(t, { code: 3010 });
    await yes.c.scanFolder();
    assert.deepEqual(yes.events, ["list", "ask-first", "run", "pending", "ask-restart", "scan", "results"]);
    assert.match(yes.asked[1], /^The uninstaller says Windows must restart to finish removing Foo Tool\. You can keep cleaning leftovers now and restart later\. Continue\?$/);
    assert.equal(yes.phases.at(-1).notice, "Restart Windows when you are ready to finish removing Foo Tool.");
    const no = harness(t, { code: 3010, restart: false });
    const r = await no.c.scanFolder();
    assert.deepEqual(no.events, ["list", "ask-first", "run", "pending", "ask-restart"]);
    assert.equal(r.ok, true);
    assert.equal(no.scans.length, 0);
    assert.equal(no.phases.at(-1).phase, "done");
    assert.match(no.phases.at(-1).detail, /Stopped after the uninstaller/);
    assert.match(no.phases.at(-1).notice, /^Restart Windows when you are ready to finish removing Foo Tool\.$/);
  } finally { t.cleanup(); }
});

test("restart: exit code 1641 warns that Windows may restart on its own; code 0 asks nothing; a pending rename inside the folder asks; outside does not", async () => {
  const t = tree();
  try {
    const a = harness(t, { code: 1641 });
    await a.c.scanFolder();
    assert.match(a.asked[1], /Windows may restart on its own/);
    assert.match(a.asked[1], /Continue\?$/);
    const b = harness(t, { code: 0 });
    await b.c.scanFolder();
    assert.equal(b.events.includes("ask-restart"), false);
    assert.equal(b.phases.some(p => p.notice), false);
    const c1 = harness(t, { code: 0, pending: regResult("\\??\\" + path.join(t.app, "x.dll") + "\\0\\0") });
    await c1.c.scanFolder();
    assert.ok(c1.events.includes("ask-restart"));
    const c2 = harness(t, { code: 0, pending: regResult("\\??\\C:\\Elsewhere\\x.dll\\0\\0") });
    await c2.c.scanFolder();
    assert.equal(c2.events.includes("ask-restart"), false);
    // an unreadable restart answer is not evidence; the exit code still counts
    const d = harness(t, { code: 3010, pending: { ok: false } });
    await d.c.scanFolder();
    assert.ok(d.events.includes("ask-restart"));
  } finally { t.cleanup(); }
});

test("flow: a failed uninstaller scans nothing; Stop waiting aborts the wait (no scan, nothing deleted) and leaves a clear text", async () => {
  const t = tree();
  try {
    const f = harness(t, { run: async () => ({ ok: false, reason: "missing" }) });
    const r = await f.c.scanFolder();
    assert.equal(r.ok, false);
    assert.equal(f.scans.length, 0);
    assert.ok(f.phases.some(p => p.phase === "error" && /could not be run/.test(p.detail)));
    let release;
    const h = harness(t, { run: x => new Promise(res => { x.signal.addEventListener("abort", () => res({ ok: false, reason: "stopped" })); release = res; }) });
    const pr = h.c.scanFolder();
    await new Promise(r2 => setTimeout(r2, 20));
    assert.ok(h.phases.some(p => p.phase === "uninstalling"));
    await h.c.scanCancel();
    const out = await pr;
    assert.equal(out.stopped, true);
    assert.equal(h.scans.length, 0);
    assert.match(h.phases.at(-1).detail, /Stopped waiting/);
    assert.equal(h.startCalls.length, 0);
    void release;
  } finally { t.cleanup(); }
});

test("flow: when the folder is gone after the uninstaller there is nothing to scan; when the install folder differs both are swept (merged)", async () => {
  const t = tree();
  try {
    const gone = harness(t, { run: async () => { fs.rmSync(t.app, { recursive: true, force: true }); return { ok: true, code: 0 }; } });
    const r = await gone.c.scanFolder();
    assert.equal(r.scanned, false);
    assert.equal(gone.scans.length, 0);
    assert.match(gone.phases.at(-1).detail, /Re-check: nothing left/);
    const t2 = tree();
    try {
      const parent = path.dirname(t2.app); // the picked folder holds the app folder (its icon lives in the app folder)
      const h = harness(t2, { picked: parent, programs: [prog({ installLocation: t2.app, displayIcon: path.join(t2.app, "f.exe"), uninstallCommand: '"' + path.join(t2.app, "u.exe") + '"' })] });
      await h.c.scanFolder();
      assert.deepEqual(h.scans.map(s => s.a.target), [parent, t2.app]);
    } finally { t2.cleanup(); }
  } finally { t.cleanup(); }
});

test("delete after the guided sweep: only through the funnel (confirm, run start); then the re-check says nothing left", async () => {
  const t = tree();
  try {
    const h = harness(t, { code: 3010, onRun: sel => { for (const p of sel.paths) fs.rmSync(p, { recursive: true, force: true }); } });
    await h.c.scanFolder();
    const view = await h.c.resultsGet();
    const ids = view.rows.filter(r => r.ticked).map(r => r.id);
    assert.equal(ids.length, 1);
    assert.equal(h.startCalls.length, 0);
    const r = await h.c.delete({ ids });
    assert.equal(r.ok, true);
    assert.equal(h.startCalls.length, 1);
    assert.deepEqual(h.startCalls[0].paths, [t.app]);
    const done = h.phases.at(-1);
    assert.equal(done.phase, "done");
    assert.match(done.detail, /Re-check: nothing left\.$/);
    assert.equal(done.notice, "Restart Windows when you are ready to finish removing Foo Tool.", "the restart notice persists on the done screen");
    assert.deepEqual(h.events.filter(e => e === "scan" || e === "start-run"), ["scan", "start-run", "scan"], "the target is scanned again after the run");
  } finally { t.cleanup(); }
});

test("re-check: items that could not be removed are counted with up to 5 names and make the restart notice appear", async () => {
  const t = tree();
  try {
    const kids = ["k1", "k2", "k3", "k4", "k5", "k6", "k7"].map(n => path.join(t.app, n));
    for (const k of kids) fs.writeFileSync(k, "x");
    const h = harness(t, { code: 0, itemsFor: () => kids }); // the fake run deletes nothing: everything stays
    await h.c.scanFolder();
    assert.equal(h.phases.some(p => p.notice), false, "no restart is known yet");
    const view = await h.c.resultsGet();
    const ids = view.rows.map(x => x.id);
    await h.c.delete({ ids });
    const done = h.phases.at(-1);
    assert.match(done.detail, /Re-check: 7 items could not be removed \(in use or waiting for a restart\): k1, k2, k3, k4, k5 and 2 more\.$/);
    assert.equal(done.notice, "Restart Windows when you are ready to finish removing Foo Tool.");
    // a single one
    const h1 = harness(t, { itemsFor: () => [kids[0]] });
    await h1.c.scanFolder();
    await h1.c.delete({ ids: (await h1.c.resultsGet()).rows.map(x => x.id) });
    assert.match(h1.phases.at(-1).detail, /Re-check: 1 item could not be removed \(in use or waiting for a restart\): k1\.$/);
  } finally { t.cleanup(); }
});

test("re-check applies only after a guided uninstall: the 'No' path and plain investigate deletes never add it", async () => {
  const t = tree();
  try {
    const h = harness(t, { first: false });
    await h.c.scanFolder();
    await h.c.delete({ ids: (await h.c.resultsGet()).rows.map(x => x.id) });
    assert.doesNotMatch(h.phases.at(-1).detail, /Re-check/);
    assert.deepEqual(h.events.filter(e => e === "scan"), ["scan"], "no second scan");
    assert.equal(h.phases.at(-1).notice, undefined);
  } finally { t.cleanup(); }
});

test("cancelling the delete after a restart-needed uninstall still keeps the restart notice; cancelling the confirmation deletes nothing", async () => {
  const t = tree();
  try {
    const h = harness(t, { code: 3010 });
    await h.c.scanFolder();
    // the user declines the permanent warning
    const c = createController({
      ui: { sendProgress() {}, sendPhase: p => h.phases.push(p), showResults() {}, closeResults() {}, confirmPermanent: async () => false, askContinueWithoutRestore: async () => true, pickFile: async () => null, pickFolder: async () => t.app,
        askUninstallFirst: async () => true, askRestartContinue: async () => true },
      paths: t.paths, identity: { sid: SID, elevated: false }, profileRoot: t.home,
      readPrograms: async () => ({ ok: true, programs: [prog({ installLocation: t.app, uninstallCommand: '"' + path.join(t.app, "u.exe") + '"' })], notes: [] }),
      runProgramUninstaller: async () => ({ ok: true, code: 3010 }),
      runScan: async (k, a) => ({ kind: "investigate", target: a.target, items: [found(a.target)], allowedRoots: [path.dirname(a.target)], protectedPaths: [], notes: [] }),
      startRun: async () => { throw new Error("must not start"); },
    });
    await c.scanFolder();
    const r = await c.delete({ ids: (await c.resultsGet()).rows.map(x => x.id) });
    assert.equal(r.cancelled, true);
    assert.ok(fs.existsSync(path.join(t.app, "left.txt")));
    assert.ok(h.phases.length > 0);
  } finally { t.cleanup(); }
});

test("administrator mode still refuses the folder flow before anything is read, asked or run", async () => {
  const t = tree();
  try {
    const events = [];
    const c = createController({
      ui: { sendProgress() {}, sendPhase() {}, showResults() {}, closeResults() {}, pickFolder: async () => { events.push("pick"); return t.app; }, askUninstallFirst: async () => { events.push("ask"); return true; } },
      paths: t.paths, identity: { sid: SID, elevated: true }, profileRoot: t.home,
      readPrograms: async () => { events.push("list"); return { ok: true, programs: [], notes: [] }; },
      runProgramUninstaller: async () => { events.push("run"); return { ok: true, code: 0 }; },
      runScan: async () => { events.push("scan"); return { kind: "investigate", items: [] }; },
    });
    assert.equal((await c.scanFolder()).ok, false);
    assert.deepEqual(events, []);
  } finally { t.cleanup(); }
});
