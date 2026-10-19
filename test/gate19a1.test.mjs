// Task 19A1: release-gate delete-path safety. Temp-dir fixtures only.
// (1) delete-time age re-check from a trusted scan-start option; (2) R41 admin-contents defence in depth; (3) per-segment
// trailing dot/space refusal in checkPath.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { removeItem } from "../lib/delete.mjs";
import { removeTreeGuarded } from "../lib/delete-internal.mjs";
import { checkPath } from "../lib/safepath.mjs";
import { createCleanupServer, selectionHash } from "../server.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sandbox() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "g19-"));
  const root = path.join(t, "work"); fs.mkdirSync(root, { recursive: true });
  return { t, root, done: () => fs.rmSync(t, { recursive: true, force: true }) };
}
const mk = (f, n = 10) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(n)); return f; };
const bump = (f, ms) => { const d = new Date(ms); fs.utimesSync(f, d, d); };   // mtime := ms (a file "modified after the scan started")

test("removeItem: a file modified after the scan start survives (skipped as changed); an old one is deleted", () => {
  const s = sandbox();
  try {
    const old = mk(path.join(s.root, "old.txt")), young = mk(path.join(s.root, "young.txt"));
    const scanStartMs = Date.now();
    bump(young, scanStartMs + 60000);
    const check = { allowedRoots: [s.root] };
    const r = removeItem(young, check, { notAfterMs: scanStartMs });
    assert.equal(r.status, "skipped"); assert.match(r.reason, /changed/);
    assert.ok(fs.existsSync(young));
    assert.equal(removeItem(old, check, { notAfterMs: scanStartMs }).status, "deleted");
    assert.equal(fs.existsSync(old), false);
  } finally { s.done(); }
});

test("removeItem: a folder holding one young file is kept whole; the young file and its old siblings survive", () => {
  const s = sandbox();
  try {
    const dir = path.join(s.root, "d");
    const a = mk(path.join(dir, "a.txt")), b = mk(path.join(dir, "sub", "b.txt")), y = mk(path.join(dir, "sub", "y.txt"));
    const scanStartMs = Date.now();
    bump(y, scanStartMs + 60000);
    const r = removeItem(dir, { allowedRoots: [s.root] }, { notAfterMs: scanStartMs });
    assert.equal(r.status, "skipped"); assert.match(r.reason, /changed/);
    for (const f of [a, b, y]) assert.ok(fs.existsSync(f), f);
    // the same folder with every entry old is deleted whole
    bump(y, scanStartMs - 60000);
    assert.equal(removeItem(dir, { allowedRoots: [s.root] }, { notAfterMs: scanStartMs }).status, "deleted");
    assert.equal(fs.existsSync(dir), false);
  } finally { s.done(); }
});

test("removeTreeGuarded: pass 1 refuses before anything is removed (CHANGED), also for a young sub-folder", () => {
  const s = sandbox();
  try {
    const dir = path.join(s.root, "d");
    const a = mk(path.join(dir, "a.txt")); mk(path.join(dir, "sub", "b.txt"));
    const scanStartMs = Date.now();
    bump(path.join(dir, "sub"), scanStartMs + 60000);
    assert.throws(() => removeTreeGuarded(dir, { allowedRoots: [s.root] }, { notAfterMs: scanStartMs }), e => e.code === "CHANGED");
    assert.ok(fs.existsSync(a));
    // no option: behaves as before
    removeTreeGuarded(dir, { allowedRoots: [s.root] });
    assert.equal(fs.existsSync(dir), false);
  } finally { s.done(); }
});

// ---- the trusted server option ----
function srvSetup(paths, extra = {}) {
  const s = sandbox();
  const items = paths(s);
  const sel = { sessionId: "S", allowedRoots: [s.root], protectedPaths: [], livePaths: [], paths: items, ...extra };
  sel.sha256 = selectionHash(sel);
  const selectionFile = path.join(s.t, "selection.json"); fs.writeFileSync(selectionFile, JSON.stringify(sel));
  const pageFile = path.join(s.t, "page.html"); fs.writeFileSync(pageFile, "<html>x</html>");
  const soundsDir = path.join(s.t, "sounds"); fs.mkdirSync(soundsDir);
  return { ...s, selectionFile, pageFile, soundsDir, items, sel };
}
const call = (port, method, p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: p, method, headers, agent: false }, res => {
    let d = ""; res.on("data", x => d += x); res.on("end", () => resolve({ status: res.statusCode, body: d }));
  });
  req.on("error", reject); if (method === "POST") req.write("{}"); req.end();
});
async function runServer(env, opts) {
  const s = createCleanupServer({ selectionFile: env.selectionFile, pageFile: env.pageFile, soundsDir: env.soundsDir, minGapMs: 100, ttlMs: 60000, afterDoneMs: 50, ...("scanStartMs" in opts ? {} : { ageCheckOffForTests: true }), ...opts });
  const { port } = await s.listen();
  const h = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-nuke-token": s.token };
  assert.equal((await call(port, "POST", "/unlock", h)).status, 200);
  await sleep(200);
  assert.equal((await call(port, "POST", "/confirm", h)).status, 200);
  for (let i = 0; i < 400 && s.getState() !== "done"; i++) await sleep(25);
  assert.equal(s.getState(), "done");
  s.close();
}
const lastDone = env => fs.readFileSync(path.join(env.t, "nuke-audit.log"), "utf8").trim().split("\n").map(l => JSON.parse(l)).find(l => l.state === "done");

test("server: scanStartMs protects a file modified after the scan and a folder with a young entry; old items are deleted", async () => {
  const env = srvSetup(s => [mk(path.join(s.root, "old.txt")), mk(path.join(s.root, "young.txt")), path.join(s.root, "dir"), path.join(s.root, "olddir")]);
  try {
    const [oldF, youngF, dir, olddir] = env.items;
    mk(path.join(dir, "a.txt")); mk(path.join(dir, "y.txt")); mk(path.join(olddir, "a.txt"));
    const scanStartMs = Date.now();
    bump(youngF, scanStartMs + 60000); bump(path.join(dir, "y.txt"), scanStartMs + 60000);
    await runServer(env, { scanStartMs });
    assert.equal(fs.existsSync(oldF), false, "old file deleted");
    assert.ok(fs.existsSync(youngF), "young file survives");
    assert.ok(fs.existsSync(path.join(dir, "a.txt")) && fs.existsSync(path.join(dir, "y.txt")), "folder with a young entry survives whole");
    assert.equal(fs.existsSync(olddir), false, "old folder deleted");
    const done = lastDone(env);
    assert.deepEqual(done.results.map(r => r.status), ["deleted", "skipped", "skipped", "deleted"]);
    assert.ok(done.results.filter(r => r.status === "skipped").every(r => /changed/.test(r.reason)));
  } finally { env.done(); }
});

test("server: scanStartMs is validated (finite number, not negative, not in the future) and is not read from selection.json", async () => {
  const env = srvSetup(s => [mk(path.join(s.root, "a.txt"))]);
  try {
    const make = scanStartMs => () => createCleanupServer({ selectionFile: env.selectionFile, pageFile: env.pageFile, soundsDir: env.soundsDir, scanStartMs });
    for (const bad of [NaN, Infinity, -1, "1", null, {}, [], Date.now() + 3600000]) assert.throws(make(bad), /bad option scanStartMs/, String(bad));
    const ok = make(Date.now() + 100)(); ok.close();   // a little clock skew is tolerated
    const ok2 = make(Date.now() - 5000)(); ok2.close();
  } finally { env.done(); }
  // a scanStartMs smuggled into the selection file is ignored (the hash covers only the known fields, and the value is never read)
  const e2 = srvSetup(s => [mk(path.join(s.root, "a.txt"))], {});
  try {
    const sel = { ...e2.sel, scanStartMs: 1 }; fs.writeFileSync(e2.selectionFile, JSON.stringify(sel));
    await runServer(e2, {});
    assert.equal(fs.existsSync(e2.items[0]), false, "no option given: no age check, and the file value did nothing");
  } finally { e2.done(); }
});

// ---- R41 defence in depth ----
test("removeItem with adminContents: only a direct-child FILE of an administrator folder is removable", () => {
  const s = sandbox();
  try {
    const adm = path.join(s.root, "AdminTemp"); fs.mkdirSync(adm);
    const direct = mk(path.join(adm, "x.tmp")), nested = mk(path.join(adm, "sub", "n.tmp")), elsewhere = mk(path.join(s.root, "userfile.txt"));
    const check = { allowedRoots: [s.root], adminContents: true };
    const hooks = { adminDirs: () => [adm] };
    for (const p of [elsewhere, nested, path.join(adm, "sub")]) {
      const r = removeItem(p, check, hooks);
      assert.equal(r.status, "skipped", p);
    }
    assert.ok(fs.existsSync(elsewhere) && fs.existsSync(nested));
    assert.equal(removeItem(direct, check, hooks).status, "deleted");
    // without the flag a per-user path is fine (standard mode)
    assert.equal(removeItem(elsewhere, { allowedRoots: [s.root] }, hooks).status, "deleted");
  } finally { s.done(); }
});

test("server with adminContents: a per-user path is refused at launch and never deleted", async () => {
  const env = srvSetup(s => [mk(path.join(s.root, "user.txt"))]);
  try {
    await runServer(env, { adminContents: true });
    assert.ok(fs.existsSync(env.items[0]));
    assert.equal(lastDone(env).results[0].status, "skipped");
  } finally { env.done(); }
});

// ---- checkPath: per-segment trailing dot/space ----
test("checkPath refuses a trailing dot or space on ANY segment, not only the end", () => {
  const s = sandbox();
  try {
    const good = mk(path.join(s.root, "ok", "f.txt"));
    assert.equal(checkPath(good, { allowedRoots: [s.root] }).ok, true);
    for (const raw of [path.join(s.root, "ok. ", "f.txt"), s.root + path.sep + "ok." + path.sep + "f.txt", s.root + path.sep + "ok " + path.sep + "f.txt", good + ".", good + " "]) {
      const v = checkPath(raw, { allowedRoots: [s.root] });
      assert.equal(v.ok, false, raw);
      assert.match(v.reason, /trailing dot or space/, raw);
    }
  } finally { s.done(); }
});
