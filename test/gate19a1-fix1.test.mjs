// Task 19A1 fix round 1: fail-closed age option, tighter tolerance, partial-delete reporting, fixture-root guard.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { removeItem } from "../lib/delete.mjs";
import { AGE_SKEW_MS } from "../lib/age.mjs";
import { createCleanupServer, selectionHash } from "../server.mjs";
import { startFrozenRun } from "../run.mjs";
import { fixtureRootProblem, MARKER } from "../fixture/fixture-root.mjs";

function sandbox() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "g19f-"));
  const root = path.join(t, "work"); fs.mkdirSync(root, { recursive: true });
  return { t, root, done: () => fs.rmSync(t, { recursive: true, force: true }) };
}
const mk = (f, n = 10) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(n)); return f; };
const bump = (f, ms) => { const d = new Date(ms); fs.utimesSync(f, d, d); };
function srvSetup() {
  const s = sandbox();
  const items = [mk(path.join(s.root, "a.txt"))];
  const sel = { sessionId: "S", allowedRoots: [s.root], protectedPaths: [], livePaths: [], paths: items };
  sel.sha256 = selectionHash(sel);
  const selectionFile = path.join(s.t, "selection.json"); fs.writeFileSync(selectionFile, JSON.stringify(sel));
  const pageFile = path.join(s.t, "page.html"); fs.writeFileSync(pageFile, "<html>x</html>");
  const soundsDir = path.join(s.t, "sounds"); fs.mkdirSync(soundsDir);
  return { ...s, selectionFile, pageFile, soundsDir, sel };
}

test("I3: the clock-skew tolerance is 250 ms, for the age comparison and for the future bound alike", () => {
  assert.equal(AGE_SKEW_MS, 250);
  const env = srvSetup();
  try {
    const make = scanStartMs => createCleanupServer({ selectionFile: env.selectionFile, pageFile: env.pageFile, soundsDir: env.soundsDir, scanStartMs });
    assert.throws(() => make(Date.now() + 1000), /bad option scanStartMs/);
    make(Date.now() + 100).close();
  } finally { env.done(); }
  const s = sandbox();
  try {
    const f = mk(path.join(s.root, "f.txt")); const t0 = Date.now(); bump(f, t0 + 1000);
    assert.equal(removeItem(f, { allowedRoots: [s.root] }, { notAfterMs: t0 }).status, "skipped", "1 s after the scan start is a change");
  } finally { s.done(); }
});

test("I1: the server requires scanStartMs (only the explicit test-only opt-out skips the age check); startFrozenRun requires it and never forwards the opt-out", async () => {
  const env = srvSetup();
  try {
    const base = { selectionFile: env.selectionFile, pageFile: env.pageFile, soundsDir: env.soundsDir };
    assert.throws(() => createCleanupServer(base), /scanStartMs/);
    assert.throws(() => createCleanupServer({ ...base, ageCheckOffForTests: "yes" }), /ageCheckOffForTests/);
    assert.throws(() => createCleanupServer({ ...base, scanStartMs: Date.now(), ageCheckOffForTests: true }), /both/);
    createCleanupServer({ ...base, ageCheckOffForTests: true }).close();
    createCleanupServer({ ...base, scanStartMs: Date.now() }).close();
    for (const bad of [undefined, NaN, "1", null]) {
      await assert.rejects(startFrozenRun(env.sel, { runDir: path.join(env.t, "run"), scanStartMs: bad, createServer: () => { throw new Error("must not start"); } }), /scanStartMs/, String(bad));
    }
    assert.equal(fs.existsSync(path.join(env.t, "run", "selection.json")), false, "nothing written");
    let seen = null;
    const fake = o => { seen = o; return { listen: async () => ({ url: "http://127.0.0.1:1/?t=x" }), runId: "r", close() {} }; };
    await startFrozenRun(env.sel, { runDir: path.join(env.t, "run2"), scanStartMs: Date.now(), createServer: fake, serverOpts: { ageCheckOffForTests: true, minGapMs: 5 } });
    assert.equal(seen.ageCheckOffForTests, undefined, "the opt-out is never forwarded");
    assert.equal(seen.minGapMs, 5);
    assert.ok(Number.isFinite(seen.scanStartMs));
  } finally { env.done(); }
});

test("pass 2 finding a file young after earlier siblings were removed: failed with the bytes actually freed, not 'skipped, 0'", () => {
  const s = sandbox();
  try {
    const dir = path.join(s.root, "d");
    const a = mk(path.join(dir, "a.txt"), 10), b = mk(path.join(dir, "b.txt"), 10);
    const t0 = Date.now();
    let n = 0;
    const lstat = p => {
      const st = fs.lstatSync(p);
      if (p !== b) return st;
      return ++n >= 2 ? Object.create(st, { mtimeMs: { value: t0 + 60000 } }) : st;   // changes between pass 1 and pass 2
    };
    const r = removeItem(dir, { allowedRoots: [s.root] }, { notAfterMs: t0, lstat });
    assert.equal(r.status, "failed"); assert.match(r.reason, /changed/);
    assert.equal(r.bytes, 10, "the freed bytes (a.txt) are reported");
    assert.equal(fs.existsSync(a), false); assert.ok(fs.existsSync(b));
  } finally { s.done(); }
});

test("overlapping selections ordered child-first: the parent is then 'changed' (the child's removal touched it) and fails safe", () => {
  const s = sandbox();
  try {
    const dir = path.join(s.root, "d");
    const a = mk(path.join(dir, "a.txt")), b = mk(path.join(dir, "b.txt"));
    const t0 = Date.now();
    const check = { allowedRoots: [s.root] };
    assert.equal(removeItem(a, check, { notAfterMs: t0 }).status, "deleted");
    bump(dir, t0 + 5000);   // removing the child updated the parent's mtime; here a little later than the tolerance
    const r = removeItem(dir, check, { notAfterMs: t0 });
    assert.equal(r.status, "skipped"); assert.match(r.reason, /changed/);
    assert.ok(fs.existsSync(b), "nothing in the parent was deleted");
  } finally { s.done(); }
});

test("server: a selected folder and a selected item inside it (child listed first) are both handled; the folder is deleted whole, results stay in selection order", async () => {
  const s = sandbox();
  try {
    const dir = path.join(s.root, "app");
    const child = mk(path.join(dir, "fake.exe")); mk(path.join(dir, "other.dat"));
    const sel = { sessionId: "S", allowedRoots: [s.root], protectedPaths: [], livePaths: [], paths: [child, dir] };
    sel.sha256 = selectionHash(sel);
    const selectionFile = path.join(s.t, "selection.json"); fs.writeFileSync(selectionFile, JSON.stringify(sel));
    const pageFile = path.join(s.t, "page.html"); fs.writeFileSync(pageFile, "<html>x</html>");
    const soundsDir = path.join(s.t, "sounds"); fs.mkdirSync(soundsDir);
    const scanStartMs = Date.now();
    await new Promise(r => setTimeout(r, 400));   // longer than the tolerance: an inner removal would now make the folder look changed
    const srv = createCleanupServer({ selectionFile, pageFile, soundsDir, minGapMs: 50, afterDoneMs: 50, scanStartMs });
    const { port } = await srv.listen();
    const h = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-nuke-token": srv.token };
    const post = p => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: h, body: "{}" });
    assert.equal((await post("/unlock")).status, 200);
    await new Promise(r => setTimeout(r, 150));
    assert.equal((await post("/confirm")).status, 200);
    for (let i = 0; i < 400 && srv.getState() !== "done"; i++) await new Promise(r => setTimeout(r, 25));
    srv.close();
    assert.equal(fs.existsSync(dir), false, "folder deleted whole");
    const done = fs.readFileSync(path.join(s.t, "nuke-audit.log"), "utf8").trim().split("\n").map(l => JSON.parse(l)).find(l => l.state === "done");
    assert.deepEqual(done.results.map(r => [path.basename(r.path), r.status]), [["fake.exe", "skipped"], ["app", "deleted"]]);
    assert.equal(done.results[0].reason, "already gone");
  } finally { s.done(); }
});

test("I2: fixtureRootProblem refuses everything but a fresh/marked folder strictly inside temp (pure checks, injected stand-ins)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g19f-fr-"));
  try {
    const fakeHome = path.join(tmp, "home");
    const o = { tmp, home: fakeHome };
    assert.equal(fixtureRootProblem(path.join(tmp, "work", "sandbox"), o), null, "a fresh folder inside temp");
    for (const [raw, re] of [["relative\\x", /absolute/], [path.parse(tmp).root, /drive root/], [fakeHome, /home/], [tmp + "\\..\\x", /parent/],
      [path.dirname(tmp) + path.sep + "elsewhere", /not inside/], ["", /not a path/], [path.join(tmp, "a\0b"), /not a path/]]) {
      assert.match(String(fixtureRootProblem(raw, o)), re, JSON.stringify(raw));
    }
    assert.match(String(fixtureRootProblem(tmp, { tmp, home: path.join(path.dirname(tmp), "zz") })), /not inside/, "the temp folder itself");
    assert.match(String(fixtureRootProblem(path.join(tmp, "up"), { tmp, home: path.join(tmp, "up", "deep") })), /home/, "a parent of home");
    const full = path.join(tmp, "full"); fs.mkdirSync(full); fs.writeFileSync(path.join(full, "precious.txt"), "x");
    assert.match(String(fixtureRootProblem(full, o)), /marker/);
    fs.writeFileSync(path.join(full, MARKER), "m");
    assert.equal(fixtureRootProblem(full, o), null);
    const bad = path.join(tmp, "bad"); fs.mkdirSync(path.join(bad, MARKER), { recursive: true });
    assert.match(String(fixtureRootProblem(bad, o)), /marker/);
    const empty = path.join(tmp, "empty"); fs.mkdirSync(empty);
    assert.equal(fixtureRootProblem(empty, o), null);
    const file = path.join(tmp, "afile"); fs.writeFileSync(file, "x");
    assert.match(String(fixtureRootProblem(file, o)), /plain folder/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("I2: make-fixture.mjs refuses a bad NUKE_FIXTURE_ROOT before deleting anything, and a marked temp root is rebuilt", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g19f-mf-"));
  const run = (root, ...args) => spawnSync(process.execPath, ["fixture/make-fixture.mjs", ...args], { env: { ...process.env, NUKE_FIXTURE_ROOT: root }, encoding: "utf8", timeout: 120000 });
  try {
    const victim = path.join(tmp, "victim"); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, "keep.txt"), "x");
    for (const args of [[], ["--clean"]]) { const r = run(victim, ...args); assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /refused/); assert.ok(fs.existsSync(path.join(victim, "keep.txt"))); }
    const out = fs.mkdtempSync(path.join(path.resolve("fixture"), "g19-out-"));   // outside temp: a throw-away folder this test creates and removes
    try {
      fs.writeFileSync(path.join(out, "keep.txt"), "x");
      const r = run(out); assert.equal(r.status, 2); assert.match(r.stderr, /not inside the temp/); assert.ok(fs.existsSync(path.join(out, "keep.txt")));
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
    assert.equal(run("relative").status, 2);
    assert.equal(run(tmp + "\\..\\x").status, 2);
    const root = path.join(tmp, "sbx");
    const a = run(root); assert.equal(a.status, 0, a.stderr);
    assert.ok(fs.existsSync(path.join(root, MARKER)) && fs.existsSync(path.join(root, "expected.json")));
    fs.writeFileSync(path.join(root, "stray.txt"), "x");
    const b = run(root); assert.equal(b.status, 0, b.stderr);
    assert.equal(fs.existsSync(path.join(root, "stray.txt")), false);
    assert.equal(run(root, "--clean").status, 0);
    assert.equal(fs.existsSync(root), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
