// test/server.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createCleanupServer, selectionHash } from "../server.mjs";

const WIN = process.platform === "win32";

function setup(extra = {}) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "srv-"));
  const root = path.join(t, "work"); fs.mkdirSync(path.join(root, "dir"), { recursive: true });
  const mk = (f, n = 1000) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(n)); return f; };
  const a = mk(path.join(root, "a.txt")), c = mk(path.join(root, "dir", "c.txt")), keep = mk(path.join(root, "keep.txt"));
  // canary outside every allowed root
  const victim = path.join(t, "victim"); const precious = mk(path.join(victim, "precious.txt"), 7);
  const dir = path.join(root, "dir");
  const base = { sessionId: "S", allowedRoots: [root], protectedPaths: [keep], livePaths: [], paths: [a, dir] };
  const sel = { ...base, ...(typeof extra === "function" ? extra({ root, a, c, keep, victim, precious, dir }) : extra) };
  sel.sha256 = selectionHash(sel);
  const selectionFile = path.join(t, "selection.json"); fs.writeFileSync(selectionFile, JSON.stringify(sel));
  const pageFile = path.join(t, "page.html"); fs.writeFileSync(pageFile, "<html>page</html>");
  const soundsDir = path.join(t, "sounds"); fs.mkdirSync(soundsDir); fs.writeFileSync(path.join(soundsDir, "x.mp3"), "mp3");
  return { t, root, a, c, keep, victim, precious, dir, selectionFile, pageFile, soundsDir, sel };
}
function call(port, { method = "GET", p = "/", headers = {}, body, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers, setHost, agent: false }, res => {
      let d = ""; res.on("data", x => d += x); res.on("end", () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on("error", reject); if (body !== undefined) req.write(body); req.end();
  });
}
const post = (srv, p, over = {}, body = "{}") => {
  const headers = { origin: `http://127.0.0.1:${srv.port}`, "content-type": "application/json", "x-nuke-token": srv.token, ...over };
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
  return call(srv.port, { method: "POST", p, body, headers });
};
const get = (srv, p, over = {}) => call(srv.port, { p: `${p}${p.includes("?") ? "&" : "?"}t=${srv.token}`, ...over });
async function start(env, opts = {}) {
  const s = createCleanupServer({ selectionFile: env.selectionFile, pageFile: env.pageFile, soundsDir: env.soundsDir, minGapMs: 150, ttlMs: 60000, afterDoneMs: 50, ageCheckOffForTests: true, ...opts });
  const { port, url } = await s.listen(); return { ...s, port, url };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Canaries: selection items, the protected file and the outside-root victim all still exist.
const nothingDeleted = env => {
  assert.ok(fs.existsSync(env.a), "a.txt survives"); assert.ok(fs.existsSync(env.c), "dir/c.txt survives");
  assert.ok(fs.existsSync(env.keep), "protected keep.txt survives");
  assert.equal(fs.readFileSync(env.precious).length, 7, "outside-root victim survives");
};
// Deadline-based (10 s), so a slow machine or a busy disk cannot make these flaky.
const until = async (cond, ms = 10000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(20); };
const waitDone = s => until(() => s.getState() === "done");
const link = (target, at) => fs.symlinkSync(target, at, WIN ? "junction" : "dir");
// R5: remove a link itself, never recursing through it.
const dropLink = at => { try { fs.unlinkSync(at); } catch { try { fs.rmdirSync(at); } catch { /* already gone */ } } };

const listen = (s, events) => http.get({ host: "127.0.0.1", port: s.port, path: `/events?t=${s.token}` }, res => res.on("data", d => {
  for (const m of String(d).matchAll(/data: (.*)\n/g)) events.push(JSON.parse(m[1]));
}));
const auditLines = (env, f = path.join(env.t, "nuke-audit.log")) =>
  fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
// Put a server into `unlocked` past the gap, so a bad /confirm is the ONLY thing between it and deleting.
async function readyToConfirm(env, opts = {}) {
  const s = await start(env, { minGapMs: 50, ...opts });
  assert.equal((await post(s, "/unlock")).status, 200); await sleep(120);
  return s;
}

// ---- brief tests ----
test("page and API need the token and the right Host", async () => {
  const env = setup(); const s = await start(env);
  assert.equal((await call(s.port, { p: "/" })).status, 403);
  assert.equal((await call(s.port, { p: "/?t=wrong" })).status, 403);
  assert.equal((await get(s, "/")).status, 200);
  assert.equal((await call(s.port, { p: `/state?t=${s.token}`, headers: { host: "evil.example" } })).status, 403);
  assert.equal((await get(s, "/state")).status, 200);
  s.close();
});
test("POST needs origin, json content type and token", async () => {
  const env = setup(); const s = await start(env);
  assert.equal((await post(s, "/unlock", { origin: undefined })).status, 403);
  assert.equal((await post(s, "/unlock", { origin: "http://evil.example" })).status, 403);
  assert.equal((await post(s, "/unlock", { "x-nuke-token": "nope" })).status, 403);
  assert.equal((await post(s, "/unlock", { "content-type": "text/plain" })).status, 415);
  assert.equal(s.getState(), "armed");
  s.close();
});
test("confirm before unlock, and confirm too soon after unlock, delete nothing", async () => {
  const env = setup(); const s = await start(env, { minGapMs: 400 });
  assert.equal((await post(s, "/confirm")).status, 409); nothingDeleted(env);
  assert.equal((await post(s, "/unlock")).status, 200);
  assert.equal((await post(s, "/confirm")).status, 409); nothingDeleted(env);
  assert.equal(s.getState(), "unlocked");
  s.close();
});
test("unlock, wait, confirm deletes exactly the selection; protected and others survive; second confirm refused", async () => {
  const env = setup(); const s = await start(env);
  await post(s, "/unlock"); await sleep(200);
  assert.equal((await post(s, "/confirm")).status, 200);
  assert.equal((await post(s, "/confirm")).status, 409, "double confirm while deleting");
  await waitDone(s);
  assert.equal(s.getState(), "done");
  assert.equal(fs.existsSync(env.a), false); assert.equal(fs.existsSync(path.join(env.root, "dir")), false);
  assert.ok(fs.existsSync(env.keep)); assert.equal(fs.readFileSync(env.precious).length, 7);
  assert.equal((await post(s, "/confirm")).status, 409);
  s.close();
});
test("a protected path inside the selection is skipped, not deleted", async () => {
  const env = setup();
  const sel = { ...env.sel, paths: [env.keep] }; sel.sha256 = selectionHash(sel);
  fs.writeFileSync(env.selectionFile, JSON.stringify(sel));
  const s = await start(env); await post(s, "/unlock"); await sleep(200); await post(s, "/confirm");
  await waitDone(s);
  nothingDeleted(env); s.close();
});
test("a selection file edited after start aborts the run, deletes nothing and closes the server (R2)", async () => {
  const env = setup(); const s = await start(env);
  const sel = { ...env.sel, paths: [env.keep] }; sel.sha256 = selectionHash(sel);
  fs.writeFileSync(env.selectionFile, JSON.stringify(sel));
  await post(s, "/unlock"); await sleep(200);
  assert.equal((await post(s, "/confirm")).status, 409);
  nothingDeleted(env); assert.equal(s.getState(), "aborted");
  await sleep(50);
  await assert.rejects(get(s, "/state"), "server is closed after abort");
  nothingDeleted(env);
});
test("a tampered selection is rejected at startup", () => {
  const env = setup(); const sel = { ...env.sel, paths: [env.keep] };
  fs.writeFileSync(env.selectionFile, JSON.stringify(sel));
  assert.throws(() => createCleanupServer({ selectionFile: env.selectionFile, pageFile: env.pageFile, soundsDir: env.soundsDir }), /hash/);
  nothingDeleted(env);
});
test("there is no way to add paths: unknown routes 404, wrong methods 405, no path traversal in sounds", async () => {
  const env = setup(); const s = await start(env);
  assert.equal((await post(s, "/select")).status, 404);
  assert.equal((await get(s, "/unlock")).status, 405);
  assert.equal((await get(s, "/sounds/..%2f..%2fselection.json")).status, 404);
  assert.equal((await get(s, "/sounds/x.mp3")).status, 200);
  s.close(); nothingDeleted(env);
});
test("an expired server deletes nothing", async () => {
  const env = setup(); const s = await start(env, { ttlMs: 80 });
  await sleep(250);
  assert.equal(s.getState(), "expired");
  await assert.rejects(post(s, "/unlock"));
  nothingDeleted(env);
});
test("SSE streams item and done events", async () => {
  const env = setup(); const s = await start(env);
  const events = [];
  const sse = http.get({ host: "127.0.0.1", port: s.port, path: `/events?t=${s.token}` }, res => res.on("data", d => {
    for (const m of String(d).matchAll(/data: (.*)\n/g)) events.push(JSON.parse(m[1]));
  }));
  await sleep(100);
  await post(s, "/unlock"); await sleep(200); await post(s, "/confirm");
  await until(() => events.some(e => e.type === "done"));
  assert.ok(events.some(e => e.type === "item" && e.status === "deleted"));
  assert.ok(events.find(e => e.type === "done").sumBytes >= 2000);
  sse.destroy(); s.close();
});

// ---- adversarial additions (spec section 8) ----
test("Host must be exactly 127.0.0.1:<port>: localhost, missing port, missing Host all 403", async () => {
  const env = setup(); const s = await start(env);
  for (const host of ["localhost:" + s.port, "127.0.0.1", `127.0.0.1:${s.port + 1}`, `127.0.0.1:${s.port}.evil.example`])
    assert.equal((await get(s, "/state", { headers: { host } })).status, 403, host);
  assert.equal((await get(s, "/state", { setHost: false })).status, 403, "missing Host");
  assert.equal((await post(s, "/unlock", { host: "evil.example" })).status, 403);
  assert.equal(s.getState(), "armed"); s.close(); nothingDeleted(env);
});
test("wrong Origin is 403 on GET and POST; null origin and cross-site fetch metadata refused", async () => {
  const env = setup(); const s = await start(env);
  assert.equal((await get(s, "/state", { headers: { origin: "http://evil.example" } })).status, 403);
  assert.equal((await get(s, "/state", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await post(s, "/unlock", { origin: "null" })).status, 403);
  assert.equal((await post(s, "/unlock", { origin: `http://localhost:${s.port}` })).status, 403);
  assert.equal((await post(s, "/unlock", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal(s.getState(), "armed"); s.close(); nothingDeleted(env);
});
test("token: missing on POST, only in query on POST, or wrong length are all 403; full flow with bad tokens deletes nothing", async () => {
  const env = setup(); const s = await start(env);
  assert.equal((await post(s, "/unlock", { "x-nuke-token": undefined })).status, 403);
  assert.equal((await post(s, `/unlock?t=${s.token}`, { "x-nuke-token": undefined })).status, 403);
  assert.equal((await post(s, "/unlock", { "x-nuke-token": s.token + "0" })).status, 403);
  assert.equal((await post(s, "/unlock", { "x-nuke-token": s.token.toUpperCase() === s.token ? "x" : s.token.toUpperCase() })).status, 403);
  assert.equal(s.getState(), "armed");
  assert.equal((await post(s, "/unlock")).status, 200); await sleep(200);
  assert.equal((await post(s, "/confirm", { "x-nuke-token": "" })).status, 403);
  assert.equal(s.getState(), "unlocked"); s.close(); nothingDeleted(env);
  assert.match(s.token, /^[0-9a-f]{64}$/, "32-byte token");
});
test("wrong order: double unlock refused; confirm is accepted only once even when fired concurrently", async () => {
  const env = setup(); const s = await start(env);
  assert.equal((await post(s, "/unlock")).status, 200);
  assert.equal((await post(s, "/unlock")).status, 409);
  await sleep(200);
  const events = []; const sse = listen(s, events); await sleep(50);
  const r = await Promise.all([post(s, "/confirm"), post(s, "/confirm"), post(s, "/confirm")]);
  assert.deepEqual(r.map(x => x.status).sort(), [200, 409, 409]);
  await waitDone(s); await sleep(50);
  assert.equal(fs.existsSync(env.a), false); assert.equal(fs.existsSync(env.dir), false);
  assert.ok(fs.existsSync(env.keep)); assert.equal(fs.readFileSync(env.precious).length, 7);
  assert.equal(events.filter(e => e.type === "done").length, 1, "exactly one done event");
  const lines = auditLines(env);
  assert.equal(lines.filter(l => l.state === "done").length, 1, "exactly one done audit line");
  assert.equal(lines.filter(l => l.state === "started").length, 1, "exactly one started audit line");
  assert.ok(lines.every(l => l.sha256 === env.sel.sha256), "every audit line carries the run's sha256");
  sse.destroy(); s.close();
});
test("the default gap is 2000 ms and request data cannot lower it", async () => {
  const env = setup();
  const s = createCleanupServer({ selectionFile: env.selectionFile, pageFile: env.pageFile, soundsDir: env.soundsDir, ageCheckOffForTests: true });
  const { port } = await s.listen(); const srv = { ...s, port };
  assert.equal(JSON.parse((await get(srv, "/state")).body).minGapMs, 2000);
  assert.equal((await post(srv, "/unlock?minGapMs=0", {}, JSON.stringify({ minGapMs: 0, ttlMs: 0 }))).status, 200);
  await sleep(300);
  const r = await post(srv, "/confirm?minGapMs=0", { "x-min-gap-ms": "0" }, JSON.stringify({ minGapMs: 0 }));
  assert.equal(r.status, 409); assert.equal(s.getState(), "unlocked");
  s.close(); nothingDeleted(env);
});
test("oversized bodies are refused with 413 and change nothing", async () => {
  const env = setup(); const s = await start(env);
  const big = JSON.stringify({ pad: "x".repeat(5000) });
  assert.equal((await post(s, "/unlock", { "content-length": String(Buffer.byteLength(big)) }, big)).status, 413);
  // chunked (no content-length): either a 413 or the connection is cut, never a state change
  try { assert.equal((await post(s, "/unlock", {}, big)).status, 413); } catch (e) { assert.match(String(e.code), /ECONNRESET|EPIPE/); }
  assert.equal(s.getState(), "armed");
  assert.equal((await post(s, "/unlock", {}, "not json")).status, 400, "body must be JSON");
  assert.equal(s.getState(), "armed"); s.close(); nothingDeleted(env);
});
test("wrong Content-Type variants are 415", async () => {
  const env = setup(); const s = await start(env);
  for (const ct of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx", "text/plain; application/json"])
    assert.equal((await post(s, "/unlock", { "content-type": ct })).status, 415, String(ct));
  assert.equal(s.getState(), "armed"); s.close(); nothingDeleted(env);
});
test("GET on POST routes, other methods and unknown routes: 405/404, never a state change, no CORS headers", async () => {
  const env = setup(); const s = await start(env);
  assert.equal((await get(s, "/confirm")).status, 405);
  assert.equal((await post(s, "/state")).status, 405);
  for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const r = await call(s.port, { method, p: `/confirm?t=${s.token}`, headers: { origin: `http://127.0.0.1:${s.port}`, "x-nuke-token": s.token } });
    assert.equal(r.status, 405, method);
    assert.ok(!Object.keys(r.headers).some(h => h.startsWith("access-control-")), "no CORS headers");
  }
  for (const p of ["/delete", "/select", "/state/../confirm", "//evil.example/", "/sounds/x.wav", "/sounds/X.mp3", "/selection.json"])
    assert.ok([404, 405].includes((await get(s, p)).status), p);
  assert.equal((await post(s, "/add")).status, 404);
  assert.equal(s.getState(), "armed"); s.close(); nothingDeleted(env);
});
test("R3: /state checks every path before sizing; refused paths show size 0 and are never deleted", async () => {
  const env = setup(e => ({ paths: [e.a, e.keep, e.precious, "relative.txt", "\\\\evil-host\\share\\x.txt", e.root + path.sep + ".." + path.sep + "victim"] }));
  const s = await start(env);
  const st = JSON.parse((await get(s, "/state")).body);
  assert.equal(st.state, "armed"); assert.equal(st.sessionId, "S"); assert.equal(st.minGapMs, 150);
  const byPath = Object.fromEntries(st.items.map(i => [i.path, i]));
  assert.equal(byPath[path.resolve(env.a)].bytes, 1000); assert.ok(!byPath[path.resolve(env.a)].refused);
  for (const i of st.items.filter(i => i.path !== path.resolve(env.a))) { assert.equal(i.refused, true, i.path); assert.equal(i.bytes, 0, i.path); }
  assert.equal(st.items.length, 6);
  const dotdot = st.items.find(i => i.path === env.root + path.sep + ".." + path.sep + "victim");
  assert.ok(dotdot, "raw .. entry is shown unnormalised"); assert.equal(dotdot.reason, "parent segment");
  assert.equal(st.totalBytes, 1000);
  // drives only for accepted local paths: never the UNC host
  assert.deepEqual(Object.keys(st.drives), [path.parse(env.a).root]);
  assert.ok(st.drives[path.parse(env.a).root].total > 0);
  await post(s, "/unlock"); await sleep(200); assert.equal((await post(s, "/confirm")).status, 200); await waitDone(s);
  assert.equal(fs.existsSync(env.a), false, "the one valid item is deleted");
  assert.ok(fs.existsSync(env.keep)); assert.equal(fs.readFileSync(env.precious).length, 7);
  s.close();
});
test("a path refused at launch is never deleted even if it becomes valid later", async () => {
  const env = setup(e => ({ paths: [path.join(e.root, "later.txt")] }));
  const s = await start(env);
  const later = path.join(env.root, "later.txt"); fs.writeFileSync(later, "new");
  await post(s, "/unlock"); await sleep(200); await post(s, "/confirm"); await waitDone(s);
  assert.ok(fs.existsSync(later)); s.close(); nothingDeleted(env);
});
test("junction swapped in after the scan: refused, the target survives, nothing deleted", async () => {
  const env = setup(e => ({ paths: [e.dir] }));
  const s = await start(env);
  const events = [];
  const sse = http.get({ host: "127.0.0.1", port: s.port, path: `/events?t=${s.token}` }, res => res.on("data", d => {
    for (const m of String(d).matchAll(/data: (.*)\n/g)) events.push(JSON.parse(m[1]));
  }));
  try {
    fs.rmSync(env.dir, { recursive: true }); link(env.victim, env.dir);
    await sleep(50);
    await post(s, "/unlock"); await sleep(200); assert.equal((await post(s, "/confirm")).status, 200); await waitDone(s);
    await until(() => events.some(e => e.type === "done"));
    assert.equal(fs.readFileSync(env.precious).length, 7, "junction target survives");
    const item = events.find(e => e.type === "item");
    assert.notEqual(item.status, "deleted");
    assert.equal(events.find(e => e.type === "done").sumBytes, 0);
    assert.ok(fs.existsSync(env.a) && fs.existsSync(env.keep));
  } finally { sse.destroy(); s.close(); dropLink(env.dir); }
});
test("tampered selection variants are rejected at startup (bad shape, missing hash, non-string paths)", () => {
  const env = setup();
  const opts = { selectionFile: env.selectionFile, pageFile: env.pageFile, soundsDir: env.soundsDir };
  for (const bad of ["not json", JSON.stringify({ ...env.sel, sha256: undefined }), JSON.stringify([]),
    (() => { const s = { ...env.sel, paths: [42] }; s.sha256 = selectionHash(s); return JSON.stringify(s); })(),
    (() => { const s = { ...env.sel, paths: "x" }; s.sha256 = selectionHash(s); return JSON.stringify(s); })()]) {
    fs.writeFileSync(env.selectionFile, bad);
    assert.throws(() => createCleanupServer(opts), String(bad).slice(0, 40));
  }
  nothingDeleted(env);
});
test("timing options are validated: nonsense values throw", () => {
  const env = setup();
  const opts = { selectionFile: env.selectionFile, pageFile: env.pageFile, soundsDir: env.soundsDir };
  for (const o of [{ minGapMs: -1 }, { ttlMs: "5" }, { afterDoneMs: NaN }, { minGapMs: Infinity }])
    assert.throws(() => createCleanupServer({ ...opts, ...o }), JSON.stringify(o));
});
test("selection file removed before confirm aborts and deletes nothing", async () => {
  const env = setup(); const s = await start(env);
  await post(s, "/unlock"); fs.rmSync(env.selectionFile); await sleep(200);
  assert.equal((await post(s, "/confirm")).status, 409);
  assert.equal(s.getState(), "aborted"); nothingDeleted(env);
});
test("done: audit log appended with paths and sizes only; freed space measured; server closes after afterDoneMs", async () => {
  const env = setup();
  fs.writeFileSync(env.a, "SECRET-CONTENT-" + "z".repeat(985));
  const s = await start(env);
  assert.match(s.url, new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/\\?t=${s.token}$`));
  await post(s, "/unlock"); await sleep(200); await post(s, "/confirm"); await waitDone(s);
  const log = fs.readFileSync(path.join(env.t, "nuke-audit.log"), "utf8").trim().split("\n");
  assert.equal(log.length, 2);
  const started = JSON.parse(log[0]);
  assert.equal(started.state, "started"); assert.equal(started.sha256, env.sel.sha256); assert.equal(started.count, 2);
  assert.deepEqual(started.items.map(i => i.bytes), [1000, 1000]);
  const rec = JSON.parse(log[1]);
  assert.equal(rec.state, "done");
  assert.equal(rec.sessionId, "S"); assert.equal(rec.sumBytes, 2000);
  assert.equal(typeof rec.freedBytes, "number"); assert.ok(rec.freedBytes >= 0);
  assert.equal(rec.results.length, 2); assert.ok(rec.results.every(r => r.status === "deleted"));
  assert.ok(!log.join("").includes("SECRET-CONTENT"), "no file contents in audit");
  await sleep(150);
  await assert.rejects(get(s, "/state"), "closed after done");
  assert.ok(fs.existsSync(env.keep)); assert.equal(fs.readFileSync(env.precious).length, 7);
});
test("audit log is append-only and honours auditFile; abort and expiry are recorded without deleting", async () => {
  const env = setup(); const auditFile = path.join(env.t, "custom-audit.log");
  fs.writeFileSync(auditFile, "previous line\n");
  const s = await start(env, { auditFile, ttlMs: 80 });
  await sleep(250); assert.equal(s.getState(), "expired");
  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
  assert.equal(lines[0], "previous line");
  assert.equal(JSON.parse(lines[1]).state, "expired");
  nothingDeleted(env);
});
test("served page carries no-store, nosniff, frame-deny and no CORS headers", async () => {
  const env = setup(); const s = await start(env);
  const r = await get(s, "/");
  assert.equal(r.body, "<html>page</html>");
  assert.equal(r.headers["x-frame-options"], "DENY"); assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["cache-control"], "no-store"); assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.ok(!Object.keys(r.headers).some(h => h.startsWith("access-control-")));
  s.close();
});

// ---- fix round 1 ----
test("non-vacuous: bad Host / Origin / Content-Type / query token / oversized body on /confirm while unlocked past the gap delete nothing", async () => {
  const env = setup(); const s = await readyToConfirm(env);
  const big = JSON.stringify({ p: "x".repeat(4000) });
  const attempts = [
    ["host evil", () => post(s, "/confirm", { host: "evil.example" })],
    ["host localhost", () => post(s, "/confirm", { host: `localhost:${s.port}` })],
    ["origin evil", () => post(s, "/confirm", { origin: "http://evil.example" })],
    ["origin null", () => post(s, "/confirm", { origin: "null" })],
    ["origin missing", () => post(s, "/confirm", { origin: undefined })],
    ["content-type text/plain", () => post(s, "/confirm", { "content-type": "text/plain" })],
    ["content-type missing", () => post(s, "/confirm", { "content-type": undefined })],
    ["token only in query", () => post(s, `/confirm?t=${s.token}`, { "x-nuke-token": undefined })],
    ["oversized declared", () => post(s, "/confirm", { "content-length": String(big.length) }, big)],
  ];
  for (const [name, fn] of attempts) {
    const r = await fn();
    assert.ok(r.status >= 400 && r.status < 500, `${name}: ${r.status}`);
    assert.equal(s.getState(), "unlocked", name); nothingDeleted(env);
  }
  // chunked oversize: 413 or a cut connection, never a delete
  try { const r = await post(s, "/confirm", {}, big); assert.equal(r.status, 413); } catch (e) { assert.match(String(e.code), /ECONNRESET|EPIPE/); }
  assert.equal(s.getState(), "unlocked"); nothingDeleted(env);
  // control: the same server really was one good request away from deleting
  assert.equal((await post(s, "/confirm")).status, 200); await waitDone(s);
  assert.equal(fs.existsSync(env.a), false); assert.ok(fs.existsSync(env.keep));
  s.close();
});
test("Origin null on GET, [::1] Host and trailing-dot Host are 403", async () => {
  const env = setup(); const s = await start(env);
  assert.equal((await get(s, "/state", { headers: { origin: "null" } })).status, 403);
  for (const host of [`[::1]:${s.port}`, `127.0.0.1.:${s.port}`, `127.0.0.1:${s.port}.`, `127.000.000.001:${s.port}`, `2130706433:${s.port}`])
    assert.equal((await get(s, "/state", { headers: { host } })).status, 403, host);
  s.close(); nothingDeleted(env);
});
test("duplicate and overlapping selection entries are not double counted and delete cleanly", async () => {
  const env = setup(e => ({ paths: [e.dir, e.c, e.a, e.a, e.dir] }));
  const s = await start(env);
  const st = JSON.parse((await get(s, "/state")).body);
  assert.equal(st.totalBytes, 2000);
  assert.deepEqual(st.items.map(i => i.bytes), [1000, 0, 1000, 0, 0]);
  assert.equal(st.items[1].coveredBy, path.resolve(env.dir)); assert.equal(st.items[3].coveredBy, path.resolve(env.a));
  const events = []; const sse = listen(s, events); await sleep(50);
  await post(s, "/unlock"); await sleep(200); assert.equal((await post(s, "/confirm")).status, 200); await waitDone(s);
  await until(() => events.some(e => e.type === "done"));
  const done = events.find(e => e.type === "done");
  assert.equal(done.sumBytes, 2000);
  assert.deepEqual(done.results.map(r => r.status), ["deleted", "skipped", "deleted", "skipped", "skipped"]);
  assert.ok(fs.existsSync(env.keep)); assert.equal(fs.readFileSync(env.precious).length, 7);
  sse.destroy(); s.close();
});
test("R16a: audit log cannot be opened => aborted, nothing deleted, server closed", async () => {
  const env = setup(); const auditFile = path.join(env.t, "audit-is-a-dir"); fs.mkdirSync(auditFile);
  const s = await readyToConfirm(env, { auditFile });
  const r = await post(s, "/confirm");
  assert.equal(r.status, 409); assert.match(r.body, /audit/);
  assert.equal(s.getState(), "aborted"); nothingDeleted(env);
  await sleep(50); await assert.rejects(get(s, "/state"));
  nothingDeleted(env);
});
test("R16b: trusted options override the selection file's roots; a widened allowedRoots in the file is ignored", async () => {
  // selection.json claims the whole temp folder (victim included) is allowed; the caller says only work/
  const env = setup(e => ({ allowedRoots: [path.dirname(e.root)], paths: [e.precious, e.a] }));
  const s = await start(env, { expectedSha256: env.sel.sha256, allowedRoots: [env.root], protectedPaths: [env.keep], livePaths: [] });
  const st = JSON.parse((await get(s, "/state")).body);
  assert.equal(st.items[0].refused, true); assert.match(st.items[0].reason, /outside allowed roots/);
  await post(s, "/unlock"); await sleep(200); await post(s, "/confirm"); await waitDone(s);
  assert.equal(fs.readFileSync(env.precious).length, 7, "outside the trusted root: survives");
  assert.equal(fs.existsSync(env.a), false);
  s.close();
});
test("R16b: expectedSha256 mismatch aborts at startup", () => {
  const env = setup();
  const o = { selectionFile: env.selectionFile, pageFile: env.pageFile, soundsDir: env.soundsDir };
  assert.throws(() => createCleanupServer({ ...o, expectedSha256: "0".repeat(64) }), /hash/);
  assert.throws(() => createCleanupServer({ ...o, expectedSha256: 42 }), /hash/);
  nothingDeleted(env);
});
test("R16b: UNC and device forms in any root list are refused at startup (file or trusted option)", () => {
  const opts = env => ({ selectionFile: env.selectionFile, pageFile: env.pageFile, soundsDir: env.soundsDir });
  for (const bad of ["\\\\evil-host\\share", "//evil-host/share", "//?/C:/x", "//./pipe/x", "\\\\?\\C:\\x", "\\\\.\\C:\\x", "\\/evil/share"]) {
    for (const field of ["allowedRoots", "protectedPaths", "livePaths"]) {
      const env = setup(e => ({ [field]: field === "allowedRoots" ? [e.root, bad] : [bad] }));
      assert.throws(() => createCleanupServer(opts(env)), /UNC or device/, `file ${field} ${bad}`);
      const env2 = setup();
      assert.throws(() => createCleanupServer({ ...opts(env2), [field]: field === "allowedRoots" ? [env2.root, bad] : [bad] }), /UNC or device/, `option ${field} ${bad}`);
    }
  }
});
test("abort closes the server even with an SSE listener attached, and the TTL does not change it", async () => {
  const env = setup(); const s = await readyToConfirm(env, { ttlMs: 400 });
  const events = []; const sse = listen(s, events); await sleep(50);
  fs.appendFileSync(env.selectionFile, " ");
  assert.equal((await post(s, "/confirm")).status, 409);
  await sleep(50);
  assert.equal(s.getState(), "aborted");
  await assert.rejects(get(s, "/state"), "closed after abort");
  assert.ok(events.some(e => e.type === "state" && e.state === "aborted"));
  await sleep(450); assert.equal(s.getState(), "aborted");
  nothingDeleted(env); sse.destroy();
});

test.after(() => { for (const d of fs.readdirSync(os.tmpdir())) if (d.startsWith("srv-")) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); });

// ---- free-space measurement honesty (R21) ----
const runToDone = async (env, patch) => {
  const s = await start(env); const events = []; listen(s, events);
  await post(s, "/unlock"); await sleep(200);
  const real = fs.statfsSync; let n = 0;
  if (patch) fs.statfsSync = (...a) => patch(++n, real, a);
  try { await post(s, "/confirm"); await waitDone(s); await sleep(30); } finally { fs.statfsSync = real; }
  return events.find(e => e.type === "done");
};
test("done event says measured:true with per-drive before/after when statfs works", async () => {
  const env = setup(); const d = await runToDone(env);
  assert.equal(d.measured, true);
  const root = path.parse(env.a).root;
  assert.ok(d.drivesBefore[root].ok && d.drivesAfter[root].ok && d.drivesBefore[root].total > 0);
  assert.ok(d.freedBytes >= 0);
});
test("statfs failing before OR after the run gives measured:false (never a fake zero as a measurement)", async () => {
  for (const failAt of [1, 2]) {
    const env = setup();
    const d = await runToDone(env, (n, real, a) => { if (n === failAt) throw new Error("EIO"); return real(...a); });
    assert.equal(d.measured, false, `fail at call ${failAt}`);
    assert.equal(d.results.filter(r => r.status === "deleted").length, 2, "deletion itself is unaffected");
    const rec = auditLines(env).find(r => r.state === "done"); assert.equal(rec.measured, false);
  }
});
