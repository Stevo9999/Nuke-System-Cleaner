// End-to-end tests: real fixture sandbox, real scan, real launch path (run.mjs), real server and deletion.
// Only fixture/sandbox is ever touched. Run from PowerShell (junction tests need it on Windows).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { scanSession, readRunningSessions, pidAlive } from "../scan.mjs";
import { buildSelection, launchNuke, bindToken, assertTargetAllowed } from "../run.mjs";
import { createCleanupServer, selectionHash } from "../server.mjs";

// Its own temp sandbox (never the shared fixture/sandbox, which other test files also rebuild); removed when the run ends.
const sb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-sbx-")), "sandbox");
after(() => fs.rmSync(path.dirname(sb), { recursive: true, force: true }));
const at = (...p) => path.join(sb, ...p);
const roots = [at("work"), at("claude")];
const exists = (...p) => fs.existsSync(at(...p));
const rel = (...s) => s.flatMap(x => x.split("/"));
const A = "dummy-session-A", LIVE = "dummy-session-LIVE";
const MIN_GAP = 150;

function rebuild() { execFileSync(process.execPath, ["fixture/make-fixture.mjs"], { stdio: "ignore", env: { ...process.env, NUKE_FIXTURE_ROOT: sb } }); }
function scan(sessionId = A, targetIsLive = false) {
  return scanSession({ claudeDir: at("claude"), sessionId, roots, tmpDir: at("tmp"), targetIsLive });
}
function call(port, method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, res => {
      let d = ""; res.on("data", x => d += x); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject); if (method === "POST") req.write("{}"); req.end();
  });
}
const TERMINAL = new Set(["done", "aborted", "failed", "expired"]);
// Drives an already-created server through unlock + confirm, waits for it to finish.
async function drive(s, listening) {
  try {
    const { port } = listening ?? await s.listen();
    const h = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-nuke-token": s.token };
    assert.equal((await call(port, "POST", "/unlock", h)).status, 200);
    await new Promise(r => setTimeout(r, MIN_GAP + 100));
    const c = await call(port, "POST", "/confirm", h);
    for (let i = 0; i < 500 && !TERMINAL.has(s.getState()); i++) await new Promise(r => setTimeout(r, 20));
    return { confirmStatus: c.status, state: s.getState() };
  } finally { s.close(); }
}
const SERVER_OPTS = { minGapMs: MIN_GAP, afterDoneMs: 50, ttlMs: 5000 };
function readAudit(file) {
  if (!fs.existsSync(file)) return { lines: [], text: "" };
  const text = fs.readFileSync(file, "utf8");
  return { text, lines: text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) };
}
function assertAuditShape({ lines, text }) {
  const si = lines.findIndex(l => l.state === "started"), di = lines.findIndex(l => l.state === "done");
  assert.ok(si >= 0 && di > si, "started line then done line");
  assert.equal(lines[si].items.every(i => Object.keys(i).every(k => ["path", "bytes", "refused"].includes(k))), true, "paths and sizes only");
  assert.ok(!text.includes("DO NOT DELETE ME"), "no file contents in the audit log");
  return lines[di];
}
// The way the real command does it: launchNuke with the bind token from a scan of the same thing.
async function launchAndRun(map, ids, { allowShared = [], targetIsLive = false, sessionId = A } = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  try {
    const r = await launchNuke({ claudeDir: at("claude"), sessionId, roots, targetIsLive, tmpDir: at("tmp"), ids, allowShared, outDir,
      bind: bindToken(map, targetIsLive), serverOpts: SERVER_OPTS });
    const run = await drive(r.server, { port: Number(new URL(r.url).port) });
    const audit = readAudit(path.join(outDir, "nuke-audit.log"));
    return { ...run, audit, done: assertAuditShape(audit), selection: r.selection };
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
}
// Hand-built selection file but with all four trusted options, exactly as launchNuke passes them.
async function handBuilt(sel, map, { trusted = {}, rawSel } = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  try {
    const selectionFile = path.join(outDir, "selection.json");
    fs.writeFileSync(selectionFile, JSON.stringify(rawSel ?? sel));
    const mk = () => createCleanupServer({ selectionFile, pageFile: path.resolve("cleanup.html"), soundsDir: path.resolve("sounds"),
      ...SERVER_OPTS, scanStartMs: Date.now(), expectedSha256: sel.sha256, allowedRoots: map.allowedRoots, protectedPaths: map.protectedPaths,
      livePaths: map.livePaths, ...trusted });
    return { outDir, selectionFile, mk, cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }) };
  } catch (e) { fs.rmSync(outDir, { recursive: true, force: true }); throw e; }
}
const sumBytes = items => items.reduce((n, i) => n + i.bytes, 0);

test("e2e: cleaning every exclusive item removes exactly those and nothing else", async () => {
  rebuild();
  const map = scan();
  const expected = JSON.parse(fs.readFileSync(at("expected.json"), "utf8"));
  const excl = map.items.filter(i => i.group === "exclusive");
  const norm = p => path.relative(sb, p).split(path.sep).join("/");
  // the scan agrees with the fixture's own expectations: every expected exclusive path is an item or inside one
  for (const e of expected.exclusive) assert.ok(excl.some(i => { const r = norm(i.path); return r === e || e.startsWith(r + "/"); }), `exclusive: ${e}`);
  for (const sh of expected.shared) assert.ok(map.items.some(i => norm(i.path) === sh && i.group === "shared"), `shared: ${sh}`);
  assert.ok(excl.some(i => norm(i.path) === "claude/projects/SBX-project/memory/note-proj-A.md"));

  const r = await launchAndRun(map, excl.map(i => i.id));
  assert.equal(r.state, "done");
  for (const e of expected.exclusive) assert.equal(exists(...rel(e)), false, e);
  for (const k of [...expected.shared, ...expected.mustSurvive, ...expected.protected.filter(p => p.includes("/") && !p.endsWith("projB")),
    ...expected.live]) assert.ok(exists(...rel(k)), `kept: ${k}`);
  assert.equal(exists("work", "projA", "assets", "big-texture.bin"), true, "bash-only item is shared and stays");
  assert.equal(r.done.results.filter(x => x.status === "deleted").length, excl.length);
  const want = sumBytes(excl);
  assert.ok(Math.abs(r.done.sumBytes - want) / want < 0.01);
  // freed-bytes sanity: a real measurement lands near what we selected, otherwise it says it is not one
  assert.equal(typeof r.done.measured, "boolean");
  // The disk is shared with every other process (and other test runs), so its free space can move by far more than this tree is
  // worth: a measured number is only checked for being a sane non-negative count. Accuracy is asserted on sumBytes above.
  assert.ok(Number.isFinite(r.done.freedBytes) && r.done.freedBytes >= 0, `freed ${r.done.freedBytes}`);
});

test("e2e: a hostile selection (hash is valid, contents are not) deletes nothing it should not", async t => {
  rebuild();
  // Without the junction trap the link-to-precious cases below would be vacuous: say so loudly.
  if (!JSON.parse(fs.readFileSync(at("expected.json"), "utf8")).junctionTrapCreated) return t.skip("SKIPPED: junction trap could not be created on this machine");
  assert.ok(exists("work", "projA", "link-to-precious", "precious.txt"), "the junction really points at the victim");
  // note: the home-folder and drive-root hostile paths use the real ones; checkPath reads os.homedir() directly
  // (not injectable) and only ever refuses them, so no stand-in is possible and none is needed.
  const map = scan();
  const hostile = [
    at("claude", "settings.json"), at("claude", "memory", "MEMORY.md"), at("claude", "projects", "SBX-project", "dummy-session-B.jsonl"),
    at("work", "projA") + path.sep + ".." + path.sep + "protected-victim" + path.sep + "precious.txt",
    at("work", "projA", "link-to-precious"), at("work", "projA", "link-to-precious", "precious.txt"),
    path.parse(sb).root, os.homedir(), "relative\\path.txt", at("work") + "\0evil",
  ];
  const sel = { sessionId: A, allowedRoots: map.allowedRoots, protectedPaths: map.protectedPaths, livePaths: map.livePaths, paths: hostile };
  sel.sha256 = selectionHash(sel);
  const h = await handBuilt(sel, map);
  try {
    const r = await drive(h.mk());
    assert.equal(r.state, "done");
    const audit = readAudit(path.join(h.outDir, "nuke-audit.log"));
    const done = assertAuditShape(audit);
    assert.equal(done.results.length, hostile.length);
    assert.ok(done.results.every(x => x.status === "skipped"), JSON.stringify(done.results));
    for (const kept of [["claude", "settings.json"], ["claude", "memory", "MEMORY.md"], ["work", "protected-victim", "precious.txt"],
      ["work", "protected-victim", "precious-big.bin"], ["claude", "projects", "SBX-project", "dummy-session-B.jsonl"]]) assert.ok(exists(...kept), kept.join("/"));
  } finally { h.cleanup(); }
});

test("e2e: a tampered selection (roots widened, protection removed, hash recomputed) is ignored or aborted", async () => {
  rebuild();
  const map = scan();
  const good = { sessionId: A, allowedRoots: map.allowedRoots, protectedPaths: map.protectedPaths, livePaths: map.livePaths,
    paths: [at("work", "projA", "notes.txt")] };
  good.sha256 = selectionHash(good);
  const evil = { sessionId: A, allowedRoots: [...map.allowedRoots, path.parse(sb).root], protectedPaths: [], livePaths: [],
    paths: [at("claude", "settings.json"), at("claude", "projects", "SBX-project", "dummy-session-B.jsonl"), at("work", "projA", "notes.txt")] };
  evil.sha256 = selectionHash(evil);

  // (1) launch pinned the good hash: the swapped file is refused outright, before anything can happen
  let h = await handBuilt(good, map, { rawSel: evil });
  try {
    assert.throws(() => h.mk(), /selection hash mismatch/);
    assert.equal(fs.existsSync(path.join(h.outDir, "nuke-audit.log")), false);
  } finally { h.cleanup(); }

  // (2) even if the hash were not pinned, the trusted roots/protected paths override what the file says
  h = await handBuilt(evil, map);
  try {
    const s = createCleanupServer({ selectionFile: h.selectionFile, pageFile: path.resolve("cleanup.html"), soundsDir: path.resolve("sounds"),
      ...SERVER_OPTS, scanStartMs: Date.now(), allowedRoots: map.allowedRoots, protectedPaths: map.protectedPaths, livePaths: map.livePaths });
    const r = await drive(s);
    assert.equal(r.state, "done");
    const done = assertAuditShape(readAudit(path.join(h.outDir, "nuke-audit.log")));
    const by = p => done.results.find(x => x.path.toLowerCase() === p.toLowerCase());
    assert.equal(by(at("claude", "settings.json")).status, "skipped");
    assert.equal(by(at("claude", "projects", "SBX-project", "dummy-session-B.jsonl")).status, "skipped");
    assert.ok(exists("claude", "settings.json") && exists("claude", "projects", "SBX-project", "dummy-session-B.jsonl"));
  } finally { h.cleanup(); }

  // (3) the file edited after launch (same pinned hash path through the real launcher): confirm aborts, nothing deleted
  rebuild();
  const map3 = scan();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  try {
    const r = await launchNuke({ claudeDir: at("claude"), sessionId: A, roots, targetIsLive: false, tmpDir: at("tmp"), ids: [map3.items.find(i => i.path.endsWith("notes.txt")).id],
      outDir, bind: bindToken(map3, false), serverOpts: SERVER_OPTS });
    fs.writeFileSync(path.join(outDir, "selection.json"), JSON.stringify(evil));
    const run = await drive(r.server, { port: Number(new URL(r.url).port) });
    assert.equal(run.state, "aborted");
    assert.ok(exists("work", "projA", "notes.txt"));
    const lines = readAudit(path.join(outDir, "nuke-audit.log")).lines;
    assert.ok(!lines.some(l => l.state === "done"));
    const ab = lines.find(l => l.state === "aborted");
    assert.ok(ab && ab.sha256 === r.sha256, "aborted line carries the launch's sha256");
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

test("e2e: a shared item can be deleted only when the user listed it in allowShared", async () => {
  rebuild();
  const m = scan();
  const shared = m.items.find(i => i.path.endsWith("config.json"));
  const tex = m.items.find(i => i.path.endsWith("big-texture.bin"));
  assert.equal(tex.group, "shared");
  assert.deepEqual(tex.sharedWith, ["(shell command only)"]);
  assert.throws(() => buildSelection(m, [shared.id]), /shared with/);
  assert.throws(() => buildSelection(m, [tex.id]), /shared with/);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  try {  // the real launcher refuses too, and writes nothing
    await assert.rejects(launchNuke({ claudeDir: at("claude"), sessionId: A, roots, targetIsLive: false, tmpDir: at("tmp"), ids: [tex.id], outDir: path.join(out, "o"), bind: bindToken(m, false) }), /shared with/);
    assert.equal(fs.existsSync(path.join(out, "o")), false);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  const r = await launchAndRun(m, [shared.id, tex.id], { allowShared: [shared.id, tex.id] });
  assert.equal(r.state, "done");
  assert.equal(exists("work", "shared", "config.json"), false);
  assert.equal(exists("work", "projA", "assets", "big-texture.bin"), false);
  assert.ok(exists("work", "shared", "dataset.bin"));
  assert.ok(exists("work", "projA", "assets", "audio.bin"));
});

test("e2e: launch refuses (exit 2, nothing written) with a wrong --bind or --session auto", () => {
  rebuild();
  const outDir = path.join(os.tmpdir(), `e2e-cli-${process.pid}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  const base = ["run.mjs", "--claude-dir", at("claude"), "--roots", roots.join(";"), "--tmp-dir", at("tmp"), "--live", "false", "--out", path.join(outDir, "map.json")];
  const cli = (cmd, extra) => spawnSync(process.execPath, [base[0], cmd, ...base.slice(1), ...extra], { encoding: "utf8", timeout: 60000 });
  const NONCE = "E2eNonceWord91";
  fs.appendFileSync(at("claude", "projects", "SBX-project", `${A}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: `run.mjs scan --nonce ${NONCE}` } }) + "\n");
  try {
    const s = cli("scan", ["--session", A, "--nonce", NONCE]);
    assert.equal(s.status, 0, s.stderr);
    const bind = /^NUKE_META=(.*)$/m.exec(s.stdout) && JSON.parse(/^NUKE_META=(.*)$/m.exec(s.stdout)[1]).bind;
    assert.match(bind, /^[0-9a-f]{64}$/, "scan prints NUKE_META with the bind token");
    const id = JSON.parse(fs.readFileSync(path.join(outDir, "map.json"), "utf8")).items.find(i => i.group === "exclusive").id;
    fs.rmSync(path.join(outDir, "map.json"));
    const wrong = bind.slice(0, -1) + (bind.endsWith("0") ? "1" : "0");
    const bad = cli("launch", ["--session", A, "--nonce", NONCE, "--bind", wrong, "--ids", id]);
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
    assert.ok(!bad.stdout.includes("NUKE_URL"));
    const noNonce = cli("launch", ["--session", A, "--bind", bind, "--ids", id]);
    assert.equal(noNonce.status, 2, noNonce.stdout + noNonce.stderr);
    const auto = cli("launch", ["--session", "auto", "--nonce", NONCE, "--bind", bind, "--ids", id]);
    assert.equal(auto.status, 2, auto.stdout + auto.stderr);
    assert.equal(fs.existsSync(path.join(outDir, "selection.json")), false);
    assert.equal(fs.existsSync(path.join(outDir, "nuke-audit.log")), false);
    // the real session cannot be pointed at a sandbox-style override: --live false needs a sandbox --claude-dir
    const live = spawnSync(process.execPath, ["run.mjs", "scan", "--live", "false"], { encoding: "utf8", timeout: 60000 });
    assert.equal(live.status, 2);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

test("e2e: the live session's own transcript and file-history are never offered as exclusive and survive even if requested", async () => {
  rebuild();
  const map = scan(LIVE, true);
  const mine = p => [at("claude", "projects", "SBX-project", `${LIVE}.jsonl`), at("claude", "file-history", LIVE)].some(x => x.toLowerCase() === p.toLowerCase());
  const live = map.items.filter(i => mine(i.path));
  assert.ok(live.length >= 1);
  assert.ok(live.every(i => i.group === "live"), JSON.stringify(live.map(i => [i.path, i.group])));
  assert.ok(!map.items.some(i => i.group === "exclusive" && mine(i.path)));
  for (const i of live) assert.throws(() => buildSelection(map, [i.id]), /live/);
  const rejOut = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  try {
    await assert.rejects(launchNuke({ claudeDir: at("claude"), sessionId: LIVE, roots, targetIsLive: true, tmpDir: at("tmp"), ids: live.map(i => i.id),
      outDir: rejOut, bind: bindToken(map, true) }), /live session/);
  } finally { fs.rmSync(rejOut, { recursive: true, force: true }); }
  // even a hand-made selection naming them: the trusted livePaths (as launchNuke builds them) make the server skip them
  const livePaths = [...new Set([...map.livePaths, ...map.items.filter(i => i.group === "live").map(i => i.path)])];
  const sel = { sessionId: LIVE, allowedRoots: map.allowedRoots, protectedPaths: map.protectedPaths, livePaths, paths: live.map(i => i.path) };
  sel.sha256 = selectionHash(sel);
  const h = await handBuilt(sel, { ...map, livePaths });
  try {
    const r = await drive(h.mk());
    assert.equal(r.state, "done");
    const done = assertAuditShape(readAudit(path.join(h.outDir, "nuke-audit.log")));
    assert.ok(done.results.every(x => x.status === "skipped"), JSON.stringify(done.results));
    assert.ok(exists("claude", "projects", "SBX-project", `${LIVE}.jsonl`));
    assert.ok(exists("claude", "file-history", LIVE, "h1"));
  } finally { h.cleanup(); }
});

// ---- Fix round 1: session identity, liveness from Claude's own session files, sha256 on every audit line ----
const writeRunning = (pid, obj) => fs.writeFileSync(at("claude", "sessions", `${pid}.json`), typeof obj === "string" ? obj : JSON.stringify({ pid, ...obj }));
const addNonce = (id, word) => fs.appendFileSync(at("claude", "projects", "SBX-project", `${id}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: `run.mjs scan --nonce ${word}` } }) + "\n");
const sbCli = (args, extra = []) => spawnSync(process.execPath, ["run.mjs", ...args, "--claude-dir", at("claude"), "--roots", roots.join(";"), "--tmp-dir", at("tmp"), "--live", "false", ...extra], { encoding: "utf8", timeout: 60000 });

test("e2e: running sessions are read from sessions/<pid>.json, strictly; dead pids and junk are ignored", () => {
  rebuild();
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  writeRunning(process.pid, { sessionId: "dummy-session-B", cwd: "x", status: "busy", name: "Bee\u001b[31m\nsecond line" });
  writeRunning(gone, { sessionId: A });                                    // process is gone
  writeRunning(4000001, { sessionId: LIVE, pid: 5 });                      // pid in file differs from file name
  writeRunning(4000002, "{ not json");
  writeRunning(4000003, { sessionId: "bad id;x" });
  fs.writeFileSync(at("claude", "sessions", "notapid.json"), JSON.stringify({ sessionId: LIVE, pid: process.pid }));
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(gone), false);
  const r = readRunningSessions(at("claude", "sessions"), p => p === process.pid || p === 4000001 || p === 4000002 || p === 4000003);
  assert.deepEqual(r.map(x => x.sessionId), ["dummy-session-B"]);
  assert.ok(!/[\u0000-\u001f]/.test(r[0].name), "name has no control characters");
  const map = scan(A, false); // real pidAlive: B is alive (this process), so its transcript is a live path
  assert.ok(map.livePaths.some(p => p.toLowerCase().endsWith("dummy-session-b.jsonl")));
});

test("e2e: a running session other than the current one cannot be targeted (launchNuke and CLI)", async () => {
  rebuild();
  writeRunning(process.pid, { sessionId: "dummy-session-B", name: "Bee" });
  const map = scan(A, false);
  const out = path.join(os.tmpdir(), `e2e-alive-${process.pid}`);
  try {
    await assert.rejects(launchNuke({ claudeDir: at("claude"), sessionId: "dummy-session-B", roots, targetIsLive: false, tmpDir: at("tmp"), ids: ["x"], outDir: out,
      bind: "0".repeat(64), currentId: A }), /running right now/);
    await assert.rejects(launchNuke({ claudeDir: at("claude"), sessionId: "dummy-session-B", roots, targetIsLive: false, tmpDir: at("tmp"), ids: ["x"], outDir: out,
      bind: "0".repeat(64) }), /running right now/);
    assert.equal(fs.existsSync(out), false);
    assert.doesNotThrow(() => assertTargetAllowed(at("claude"), "dummy-session-B", "dummy-session-B"), "the current session itself may be targeted");
    assert.doesNotThrow(() => assertTargetAllowed(at("claude"), A, "dummy-session-B"), "a session with no live process may be targeted");
    // CLI: current = A (by nonce); B is running => exit 2, nothing written
    addNonce(A, "AliveNonce1234");
    const mapFile = path.join(out, "map.json");
    const r = sbCli(["scan"], ["--session", "dummy-session-B", "--nonce", "AliveNonce1234", "--out", mapFile]);
    assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /running right now/);
    const r2 = sbCli(["scan"], ["--session", "dummy-session-B", "--out", mapFile]);   // no nonce: cannot prove it is the current one
    assert.equal(r2.status, 2, r2.stdout + r2.stderr);
    assert.equal(fs.existsSync(mapFile), false);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  assert.ok(map.sessionId === A);
});

test("e2e: --session auto needs a nonce, resolves only by nonce, and the scan shows session id, name and last active", () => {
  rebuild();
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
  const out = path.join(os.tmpdir(), `e2e-auto-${process.pid}`);
  try {
    writeRunning(child.pid, { sessionId: A, name: "Cleanup \u001b[31mtest" });
    addNonce(A, "AutoNonce12345");
    const mapFile = path.join(out, "map.json");
    const none = sbCli(["scan"], ["--session", "auto", "--out", mapFile]);
    assert.equal(none.status, 2, none.stdout + none.stderr);
    const wrong = sbCli(["scan"], ["--session", "auto", "--nonce", "NoSuchWord9999", "--out", mapFile]);
    assert.equal(wrong.status, 2, wrong.stdout + wrong.stderr); assert.match(wrong.stderr, /no transcript contains/);
    assert.equal(fs.existsSync(mapFile), false);
    const ok = sbCli(["scan"], ["--session", "auto", "--nonce", "AutoNonce12345", "--out", mapFile]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^Session dummy-session-A$/m);
    assert.match(ok.stdout, /name \(untrusted text\): "Cleanup .?\[31mtest"\s+last active: "\d{4}-\d\d-\d\dT/);
    assert.ok(!ok.stdout.includes("\u001b"));
    assert.match(ok.stdout, /^NUKE_META=\{"session":"dummy-session-A","bind":"[0-9a-f]{64}"\}$/m);
    // a second transcript holding the nonce makes the identity ambiguous: refuse
    addNonce("dummy-session-B", "AutoNonce12345");
    const two = sbCli(["scan"], ["--session", "auto", "--nonce", "AutoNonce12345", "--out", mapFile]);
    assert.equal(two.status, 2, two.stdout + two.stderr); assert.match(two.stderr, /more than one/);
  } finally { child.kill(); fs.rmSync(out, { recursive: true, force: true }); }
});

test("e2e: every audit line (started, done, aborted, expired) carries the run's sha256, and launch can print it", async () => {
  rebuild();
  const map = scan();
  const notes = map.items.find(i => i.path.endsWith("notes.txt"));
  const run = await launchAndRun(map, [notes.id]);
  assert.ok(run.audit.lines.length >= 2 && run.audit.lines.every(l => l.sha256 === run.selection.sha256));
  // expired: never unlocked
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  try {
    const map2 = scan();
    const left = map2.items.find(i => i.path.endsWith("main.js"));
    const r = await launchNuke({ claudeDir: at("claude"), sessionId: A, roots, targetIsLive: false, tmpDir: at("tmp"), ids: [left.id], outDir,
      bind: bindToken(map2, false), serverOpts: { ...SERVER_OPTS, ttlMs: 300 } });
    try {
      for (let i = 0; i < 100 && r.server.getState() !== "expired"; i++) await new Promise(x => setTimeout(x, 20));
      assert.equal(r.server.getState(), "expired");
    } finally { r.server.close(); }
    const ex = readAudit(path.join(outDir, "nuke-audit.log")).lines.find(l => l.state === "expired");
    assert.ok(ex && ex.sha256 === r.sha256 && /^[0-9a-f]{64}$/.test(r.sha256));
    assert.ok(exists("work", "projA", "src", "main.js"));
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});