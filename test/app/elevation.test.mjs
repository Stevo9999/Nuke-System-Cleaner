// test/app/elevation.test.mjs: Phase 1b relaunch (fake spawn only: nothing is ever started elevated here) and the
// controller's administrator-mode rules (adminContents from identity, relaunch refusals, Ruling R36 in choose()).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { relaunchAsAdmin, relaunchScript, makeRelaunchElevated } from "../../app/main/elevation.mjs";
import { createController, GENERIC_ERROR, BUSY_MESSAGE, RELAUNCH_TIMEOUT_MESSAGE, ADMIN_INVESTIGATE_MESSAGE, IDENTITY_UNKNOWN_MESSAGE,
  RELAUNCH_CANCELLED_MESSAGE } from "../../app/main/controller.mjs";
import { FIXED_MESSAGES } from "../../app/renderer/main.js";
import { appDataPaths, ensureAppData } from "../../app/main/appdata.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { RESTORE_MESSAGES } from "../../lib/restore.mjs";
import { scanArgs } from "../../app/main/scan-runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SID = "S-1-5-21-11-22-33-1001";
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const EXE = "C:\\Users\\me\\AppData\\Local\\Programs\\Nuke-Uninstaller\\Nuke-Uninstaller.exe";

// A spawn stand-in: records the call and ends the child with `code` (or an 'error' event) on the next tick.
function fakeSpawn({ code = 0, error = false, throws = false } = {}) {
  const calls = [];
  const fn = (exe, args, opts) => {
    calls.push({ exe, args, opts });
    if (throws) throw new Error("spawn failed " + args.join(" "));
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; };
    setImmediate(() => { if (error) child.emit("error", new Error("ENOENT " + exe)); else child.emit("exit", code); });
    return child;
  };
  fn.calls = calls;
  return fn;
}
const decode = b64 => Buffer.from(b64, "base64").toString("utf16le");

test("relaunchAsAdmin: full-path powershell, -EncodedCommand, -Verb RunAs, quoted args, 1223 -> cancelled", async () => {
  const sp = fakeSpawn({ code: 0 });
  const app = "E:\\My Apps\\it's nuke";
  assert.equal(await relaunchAsAdmin({ execPath: EXE, args: [app], spawnFn: sp, systemRoot: "C:\\Windows" }), "started");
  assert.equal(sp.calls.length, 1);
  const { exe, args, opts } = sp.calls[0];
  assert.equal(exe, PS);
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(args.length, 4);
  assert.equal(opts.shell, false);
  const script = decode(args[3]);
  assert.match(script, /Start-Process -FilePath 'C:\\Users\\me\\AppData\\Local\\Programs\\Nuke-Uninstaller\\Nuke-Uninstaller\.exe'/);
  assert.match(script, /-Verb RunAs/);
  // each argument is a single-quoted literal (quote doubled) wrapping a double-quoted path, so spaces survive
  assert.ok(script.includes(`-ArgumentList '"E:\\My Apps\\it''s nuke"'`), script);
  assert.ok(!/-Wait/.test(script));
  assert.ok(!/Stop-Service|sc\.exe|net stop/i.test(script));

  assert.equal(await relaunchAsAdmin({ execPath: EXE, args: [], spawnFn: fakeSpawn({ code: 1223 }), systemRoot: "C:\\Windows" }), "cancelled");
  assert.equal(await relaunchAsAdmin({ execPath: EXE, args: [], spawnFn: fakeSpawn({ code: 1 }), systemRoot: "C:\\Windows" }), "failed");
  assert.equal(await relaunchAsAdmin({ execPath: EXE, args: [], spawnFn: fakeSpawn({ error: true }), systemRoot: "C:\\Windows" }), "failed");
  assert.equal(await relaunchAsAdmin({ execPath: EXE, args: [], spawnFn: fakeSpawn({ throws: true }), systemRoot: "C:\\Windows" }), "failed");
  // M1: a prompt that never finishes is its own outcome, and the waiting PowerShell is killed
  let child;
  const never = () => { child = new EventEmitter(); child.kill = () => { child.killed = true; }; return child; };
  assert.equal(await relaunchAsAdmin({ execPath: EXE, args: [], spawnFn: never, systemRoot: "C:\\Windows", timeoutMs: 20 }), "timeout");
  assert.equal(child.killed, true);
  // no arguments: no -ArgumentList at all (Start-Process refuses an empty one)
  const sp2 = fakeSpawn();
  await relaunchAsAdmin({ execPath: EXE, args: [], spawnFn: sp2, systemRoot: "D:\\Win" });
  assert.equal(sp2.calls[0].exe, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(!decode(sp2.calls[0].args[3]).includes("-ArgumentList"));
  // curly quotes count as quotes in PowerShell: doubled too
  const s3 = relaunchScript({ execPath: "C:\\a\u2019b\\x.exe", args: [] });
  assert.ok(s3.includes("'C:\\a\u2019\u2019b\\x.exe'"), s3);
});

test("relaunchAsAdmin refuses relative paths and control characters before spawning", async () => {
  const bad = [
    { execPath: "nuke.exe", args: [] },
    { execPath: ".\\nuke.exe", args: [] },
    { execPath: "\\\\host\\share\\nuke.exe", args: [] },
    { execPath: "C:/x/nuke.exe", args: [] },
    { execPath: "C:\\x\\nu\nke.exe", args: [] },
    { execPath: "C:\\x\\nu\u2028ke.exe", args: [] },
    { execPath: "C:\\x\\nuke.exe", args: ["relative\\app"] },
    { execPath: "C:\\x\\nuke.exe", args: ["--inspect=9229"] },
    { execPath: "C:\\x\\nuke.exe", args: ["C:\\app\\" + ".." + "\\evil"] },
    { execPath: "C:\\x\\nuke.exe", args: ["C:\\app\u0007"] },
    { execPath: "C:\\x\\nuke.exe", args: ["C:\\a\"b"] },
    { execPath: "C:\\x\\nuke.exe", args: ["C:\\app\\"] },
    { execPath: "C:\\x\\nuke.exe", args: [5] },
    { execPath: "C:\\x\\nuke.exe", args: "C:\\app" },
    { execPath: "C:\\x\\nuke.exe", args: Array(9).fill("C:\\app") },
    { execPath: 7, args: [] },
    // Fix round 1 (I1): Start-Process -FilePath is a wildcard pattern ('a[1]\x.exe' would start 'a1\x.exe')
    { execPath: "C:\\a[1]\\x.exe", args: [] },
    { execPath: "C:\\a]\\x.exe", args: [] },
    { execPath: "C:\\a\\x[.exe", args: [] },
    { execPath: "C:\\a*\\x.exe", args: [] },
    { execPath: "C:\\a\\x?.exe", args: [] },
  ];
  for (const b of bad) {
    const sp = fakeSpawn();
    await assert.rejects(relaunchAsAdmin({ ...b, spawnFn: sp, systemRoot: "C:\\Windows" }), TypeError, JSON.stringify(b));
    assert.equal(sp.calls.length, 0, JSON.stringify(b));
  }
  // arguments are passed literally (no wildcard expansion), so brackets there are fine
  const ok = fakeSpawn();
  assert.equal(await relaunchAsAdmin({ execPath: EXE, args: ["E:\\apps[1]\\nuke"], spawnFn: ok, systemRoot: "C:\\Windows" }), "started");
  assert.ok(decode(ok.calls[0].args[3]).includes(`'"E:\\apps[1]\\nuke"'`));
  for (const systemRoot of ["Windows", "\\\\host\\Windows", "C:\\Windows\\" + ".." + "\\Users", "C:\\..", 5]) {
    const sp = fakeSpawn();
    await assert.rejects(relaunchAsAdmin({ execPath: EXE, args: [], spawnFn: sp, systemRoot }), TypeError, String(systemRoot));
    assert.equal(sp.calls.length, 0);
  }
});

// ---- controller ----
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-elev-"));
  const la = path.join(root, "Local");
  const junk = path.join(la, "Temp");
  const adminA = path.join(root, "Win", "Temp"), adminB = path.join(root, "PD", "WER", "ReportQueue");
  for (const d of [junk, adminA, adminB]) fs.mkdirSync(d, { recursive: true });
  const mk = (p, s = "x") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
  const paths = appDataPaths({ LOCALAPPDATA: la });
  ensureAppData(paths);
  return { root, la, junk, adminA, adminB, mk, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const vetted = (p, extra = {}) => makeFinding({ kind: "file", path: p, label: p, bytes: 1, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false,
  reason: "r", category: "c", ...extra });
const fakeUi = () => ({
  phases: [], sendProgress() {}, sendPhase(p) { this.phases.push(p); }, showResults() {}, closeResults() {},
  confirmPermanent: async () => true, askContinueWithoutRestore: async () => true,
  openRitual: () => ({ onClosed() {}, close() {} }),
});
function fakeStart() {
  const calls = [];
  const fn = async (sel, opts) => {
    calls.push({ sel, opts });
    const server = { runId: "0123456789abcdef", getState: () => "done", close() {} };
    return { url: "http://127.0.0.1:1/?t=" + "f".repeat(64), server, runId: server.runId };
  };
  fn.calls = calls;
  return fn;
}
function make(t, { elevated = false, items = [], roots, relaunch, startRun = fakeStart(), runScan, restoreCalls = [] } = {}) {
  const seen = [];
  const c = createController({
    ui: fakeUi(), paths: t.paths, identity: { sid: SID, elevated },
    runScan: runScan || (async (kind, args) => { seen.push([kind, args]); return { kind: "smart", target: null, items, allowedRoots: roots || [t.junk, t.adminA, t.adminB], protectedPaths: [], notes: [], adminExtraBytes: null, partial: false }; }),
    restore: async o => { restoreCalls.push(o); return { outcome: "made", message: RESTORE_MESSAGES.made, detail: "made" }; },
    startRun, readAudit: () => [], pollMs: 1, adminDirs: () => [t.adminA, t.adminB], ...(relaunch ? { relaunch: "allowed" in relaunch ? relaunch : Object.assign(relaunch, { allowed: true }) } : {}),
  });
  return { c, seen, startRun, restoreCalls };
}

test("controller: adminContents true only when identity.elevated === true; relaunch refused when elevated", async () => {
  const t = tree();
  try {
    // (anything that is not a real boolean is "unknown": see the R44 test below)
    for (const [elevated, want] of [[true, true], [false, false]]) {
      // R41: elevated, only administrator-folder files can be deleted; standard, only per-user items
      const a = vetted(t.mk(path.join(elevated === true ? t.adminA : t.junk, "a" + String(elevated))));
      const restoreCalls = [];
      const { c, seen, startRun } = make(t, { elevated, items: [a], restoreCalls });
      await c.scanSmart();
      // the scan gets elevated only when it is really true; nothing else from a caller reaches it
      assert.deepEqual(seen[0], ["smart", want ? { sid: SID, elevated: true, protectedPaths: [] } : { sid: SID, protectedPaths: [] }], String(elevated));
      assert.deepEqual(await c.statusGet(), { elevated: want, canRelaunchAdmin: false });
      await c.delete({ ids: [a.id] });
      assert.equal(startRun.calls.length, 1, String(elevated));
      assert.equal(startRun.calls[0].opts.adminContents, want, String(elevated));
      assert.deepEqual(Object.keys(startRun.calls[0].opts).sort(), ["adminContents", "plainConfirm", "runDir", "scanStartMs"]);
      assert.equal(restoreCalls[0].elevated, want); // restore step: no extra prompt when elevated
    }
    // the worker-side sanitiser keeps only a strict true
    assert.deepEqual(scanArgs("smart", { sid: SID, elevated: true }), { sid: SID, elevated: true });
    for (const v of ["true", 1, {}, false]) assert.deepEqual(scanArgs("smart", { sid: SID, elevated: v }), { sid: SID });
    assert.ok(!("elevated" in scanArgs("investigate", { target: "C:\\a\\b.exe", elevated: true })));

    // relaunch: refused when already elevated (never calls the relauncher)
    let calls = 0;
    const relaunch = async () => { calls++; return "started"; };
    let { c } = make(t, { elevated: true, relaunch });
    await assert.rejects(c.adminRelaunch(), /refused/);
    assert.equal(calls, 0);
    // standard mode: started / cancelled / failed
    for (const [out, check] of [["started", r => assert.deepEqual(r, { ok: true })], ["cancelled", r => assert.deepEqual(r, { ok: false, cancelled: true })]]) {
      ({ c } = make(t, { relaunch: async () => out }));
      check(await c.adminRelaunch());
    }
    for (const bad of [async () => "failed", async () => { throw new Error("C:\\secret path"); }, async () => "weird"]) {
      ({ c } = make(t, { relaunch: bad }));
      await assert.rejects(c.adminRelaunch(), e => e.message === GENERIC_ERROR);
    }
    // M1: a prompt that never finished has its own fixed text
    ({ c } = make(t, { relaunch: async () => "timeout" }));
    await assert.rejects(c.adminRelaunch(), e => e.message === RELAUNCH_TIMEOUT_MESSAGE);
    assert.equal(RELAUNCH_TIMEOUT_MESSAGE, "The administrator prompt did not finish.");
    // no relauncher wired (or one that is not allowed, R46): refused
    ({ c } = make(t));
    await assert.rejects(c.adminRelaunch(), /refused/);
    // refused while busy (a scan is running), and a relaunch in flight makes other operations busy
    let release;
    const gate = new Promise(r => { release = r; });
    ({ c } = make(t, { relaunch: async () => "cancelled", runScan: async () => { await gate; return { kind: "smart", items: [], allowedRoots: [], protectedPaths: [], notes: [] }; } }));
    const p = c.scanSmart();
    await assert.rejects(c.adminRelaunch(), e => e.message === BUSY_MESSAGE);
    release(); await p;
    let rel2;
    const g2 = new Promise(r => { rel2 = r; });
    ({ c } = make(t, { relaunch: async () => { await g2; return "cancelled"; } }));
    const pr = c.adminRelaunch();
    await assert.rejects(c.scanSmart(), e => e.message === BUSY_MESSAGE);
    rel2(); assert.deepEqual(await pr, { ok: false, cancelled: true });
  } finally { t.cleanup(); }
});

test("controller R36: under an administrator folder only direct-child files are accepted, and only when elevated", async () => {
  const t = tree();
  try {
    const fileA = vetted(t.mk(path.join(t.adminA, "junk.tmp")));
    const fileB = vetted(t.mk(path.join(t.adminB, "Report.wer")));
    const dirA = vetted(t.mk(path.join(t.adminA, "sub", "deep.tmp")), { kind: "dir", path: path.join(t.adminA, "sub"), label: "sub" });
    const nested = vetted(path.join(t.adminA, "sub", "deep.tmp"));
    const folderItself = vetted(t.adminA, { label: "itself" });
    const caseTwin = vetted(path.join(t.adminA.toUpperCase(), "OTHER", "X.TMP"), { label: "upper" }); // nested, other case
    const userFile = vetted(t.mk(path.join(t.junk, "u.tmp")));
    const userDir = vetted(t.mk(path.join(t.junk, "ud", "x")), { kind: "dir", path: path.join(t.junk, "ud"), label: "ud" });
    const items = [fileA, fileB, dirA, nested, folderItself, caseTwin, userFile, userDir];

    for (const bad of [dirA, nested, folderItself, caseTwin]) {
      const { c, startRun } = make(t, { elevated: true, items });
      await c.scanSmart();
      await assert.rejects(c.delete({ ids: [bad.id] }), /refused/, bad.label);
      await assert.rejects(c.delete({ ids: [fileA.id, bad.id] }), /refused/, bad.label); // one bad id refuses the whole request
      assert.equal(startRun.calls.length, 0);
    }
    // standard mode: even a direct-child file of an administrator folder is refused
    let m = make(t, { elevated: false, items });
    await m.c.scanSmart();
    await assert.rejects(m.c.delete({ ids: [fileA.id] }), /refused/);
    // R41: elevated, per-user items (files and folders) are refused: only the administrator-folder files pass
    for (const bad of [userFile, userDir]) {
      m = make(t, { elevated: true, items });
      await m.c.scanSmart();
      await assert.rejects(m.c.delete({ ids: [bad.id] }), /refused/, bad.label);
      await assert.rejects(m.c.delete({ ids: [fileA.id, bad.id] }), /refused/, bad.label);
      assert.equal(m.startRun.calls.length, 0);
    }
    // an unreadable administrator list refuses everything while elevated
    m = make(t, { elevated: true, items });
    const c2 = createController({ ui: fakeUi(), paths: t.paths, identity: { sid: SID, elevated: true }, runScan: async () => ({ kind: "smart", items, allowedRoots: [t.adminA], protectedPaths: [], notes: [] }),
      restore: async () => ({ outcome: "made" }), startRun: m.startRun, readAudit: () => [], pollMs: 1, adminDirs: () => { throw new Error("x"); } });
    await c2.scanSmart();
    await assert.rejects(c2.delete({ ids: [fileA.id] }), /refused/);
    m = make(t, { elevated: true, items });
    await m.c.scanSmart();
    const r = await m.c.delete({ ids: [fileA.id, fileB.id] });
    assert.equal(m.startRun.calls.length, 1, JSON.stringify(r));
    assert.deepEqual([...m.startRun.calls[0].sel.paths].sort(), [fileA.path, fileB.path].sort());
    assert.equal(m.startRun.calls[0].opts.adminContents, true);
    // standard mode is unchanged: per-user files and folders pass
    m = make(t, { elevated: false, items });
    await m.c.scanSmart();
    await m.c.delete({ ids: [userFile.id, userDir.id] });
    assert.deepEqual([...m.startRun.calls[0].sel.paths].sort(), [userFile.path, userDir.path].sort());
    assert.equal(m.startRun.calls[0].opts.adminContents, false);
  } finally { t.cleanup(); }
});

test("controller R44: unknown integrity level -> scans read-only in standard form, delete refused with the fixed text", async () => {
  const t = tree();
  try {
    assert.equal(IDENTITY_UNKNOWN_MESSAGE, "Could not tell whether this app is running as administrator, so deleting is turned off.");
    for (const identity of [{ sid: SID, elevated: null }, { sid: null, elevated: null }, { sid: SID }, null, undefined, { sid: SID, elevated: "false" }, { sid: SID, elevated: 0 }]) {
      const a = vetted(t.mk(path.join(t.junk, "k" + JSON.stringify(identity ?? "none").replace(/\W/g, ""))));
      const seen = [], restoreCalls = [];
      const startRun = fakeStart();
      const ui = fakeUi();
      const c = createController({ ui, paths: t.paths, identity, runScan: async (kind, args) => { seen.push([kind, args]); return { kind: "smart", target: null, items: [a], allowedRoots: [t.junk], protectedPaths: [], notes: [] }; },
        restore: async o => { restoreCalls.push(o); return { outcome: "made" }; }, startRun, readAudit: () => [], pollMs: 1, adminDirs: () => [t.adminA],
        relaunch: async () => "started" });
      assert.deepEqual(await c.statusGet(), { elevated: null, canRelaunchAdmin: false }, JSON.stringify(identity));
      assert.deepEqual(await c.scanSmart(), { ok: true, count: 1 });
      assert.equal(seen[0][1].elevated, undefined, "the scan runs in its standard (non-administrator) form");
      await assert.rejects(c.delete({ ids: [a.id] }), e => e.message === IDENTITY_UNKNOWN_MESSAGE);
      assert.ok(ui.phases.some(p => p.phase === "error" && p.detail === IDENTITY_UNKNOWN_MESSAGE));
      assert.equal(startRun.calls.length, 0); assert.equal(restoreCalls.length, 0);
      await assert.rejects(c.adminRelaunch(), /refused/);
    }
  } finally { t.cleanup(); }
});

test("controller R41: investigate scans are not run in administrator mode", async () => {
  const t = tree();
  try {
    let scans = 0;
    const ui = fakeUi();
    ui.pickFile = async () => path.join(t.junk, "x.exe");
    ui.pickFolder = async () => t.junk;
    const c = createController({ ui, paths: t.paths, identity: { sid: SID, elevated: true }, runScan: async () => { scans++; return { kind: "investigate", items: [] }; },
      startRun: fakeStart(), readAudit: () => [], pollMs: 1, adminDirs: () => [t.adminA] });
    assert.deepEqual(await c.scanInvestigate(), { ok: false });
    assert.deepEqual(await c.scanFolder(), { ok: false });
    assert.equal(scans, 0);
    assert.ok(ui.phases.filter(p => p.phase === "error" && p.detail === ADMIN_INVESTIGATE_MESSAGE).length === 2, JSON.stringify(ui.phases));
    // standard mode still investigates
    const c3 = createController({ ui: Object.assign(fakeUi(), { pickFile: async () => path.join(t.junk, "x.exe") }), paths: t.paths, identity: { sid: SID, elevated: false },
      runScan: async () => { scans++; return { kind: "investigate", items: [] }; }, startRun: fakeStart(), readAudit: () => [], pollMs: 1 });
    await c3.scanInvestigate();
    assert.equal(scans, 1);
  } finally { t.cleanup(); }
});

test("renderer fixed messages are the controller's exact texts", () => {
  assert.equal(FIXED_MESSAGES.relaunchTimeout, RELAUNCH_TIMEOUT_MESSAGE);
  assert.equal(FIXED_MESSAGES.relaunchCancelled, RELAUNCH_CANCELLED_MESSAGE);
  assert.equal(FIXED_MESSAGES.identityUnknown, IDENTITY_UNKNOWN_MESSAGE);
  assert.equal(FIXED_MESSAGES.busy, BUSY_MESSAGE);
});

// M2: behavioural test of the relaunch wiring main.mjs uses (fake app, fake relauncher; nothing is started).
function fakeApp({ packaged = false, relock = true } = {}) {
  const log = [];
  return {
    log, isPackaged: packaged,
    getAppPath: () => "E:\\Claude\\nuke",
    releaseSingleInstanceLock: () => log.push("release"),
    requestSingleInstanceLock: () => { log.push("request"); return relock; },
    quit: () => log.push("quit"),
  };
}
test("relaunch wiring: lock released before the relaunch, quit on started, lock taken back otherwise", async () => {
  // R46: only a packaged app under C:\Program Files can relaunch elevated, so the wiring is exercised with such a path.
  const EXE = "C:\\Program Files\\Nuke-Uninstaller\\1.0\\Nuke-Uninstaller.exe";
  for (const [out, packaged, want, wantArgs] of [
    ["started", true, ["release", "relaunch", "quit"], []],
    ["cancelled", true, ["release", "relaunch", "request"], []],
    ["failed", true, ["release", "relaunch", "request"], []],
    ["timeout", true, ["release", "relaunch", "request"], []],
  ]) {
    const app = fakeApp({ packaged });
    const seen = [];
    const fn = makeRelaunchElevated({ app, execPath: EXE, relaunch: async o => { app.log.push("relaunch"); seen.push(o); return out; } });
    assert.equal(await fn(), out);
    assert.deepEqual(app.log, want, out);
    assert.deepEqual(seen[0], { execPath: EXE, args: wantArgs });
  }
  // a relauncher that throws is "failed" and the lock is taken back
  let app = fakeApp({ packaged: true });
  assert.equal(await makeRelaunchElevated({ app, execPath: EXE, relaunch: async () => { throw new Error("x"); } })(), "failed");
  assert.deepEqual(app.log, ["release", "request"]);
  // another instance took the lock meanwhile: this one quits rather than run beside it
  app = fakeApp({ packaged: true, relock: false });
  assert.equal(await makeRelaunchElevated({ app, execPath: EXE, relaunch: async () => "cancelled" })(), "failed");
  assert.deepEqual(app.log, ["release", "request", "quit"]);
  // main.mjs uses this wiring with the real relauncher
  const src = fs.readFileSync(path.join(here, "..", "..", "app", "main", "main.mjs"), "utf8");
  assert.match(src, /makeRelaunchElevated\(\{ app, execPath: process\.execPath \}\)/);
  assert.match(src, /relaunch:\s*relaunchElevated/);
});

test("R46 controller: canRelaunchAdmin only when the relauncher says it is allowed and standard mode is known; adminRelaunch refused otherwise", async () => {
  const t = tree();
  try {
    let calls = 0;
    const mkRel = allowed => Object.assign(async () => { calls++; return "started"; }, { allowed });
    for (const [allowed, elevated, want] of [[true, false, true], [false, false, false], [undefined, false, false], [true, true, false], ["yes", false, false]]) {
      const { c } = make(t, { elevated, relaunch: mkRel(allowed) });
      const st = await c.statusGet();
      assert.equal(st.canRelaunchAdmin, want, JSON.stringify([allowed, elevated]));
      assert.equal(typeof st.canRelaunchAdmin, "boolean");
      if (!want) await assert.rejects(c.adminRelaunch(), /refused/);
    }
    assert.equal(calls, 0, "a refused relaunch never reaches the relauncher");
    const { c } = make(t, { relaunch: mkRel(true) });
    assert.deepEqual(await c.adminRelaunch(), { ok: true });
    assert.equal(calls, 1);
  } finally { t.cleanup(); }
});
