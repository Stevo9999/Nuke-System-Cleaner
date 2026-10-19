// test/plain-confirm.test.mjs
// The "simple confirm screen" option: cleanup-plain.html is only a different front end. The one-time server still enforces
// token, unlock, minimum gap, confirm, audit, age re-check and expiry; the mode is chosen by the app (startFrozenRun option),
// never by a URL parameter or a request.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createCleanupServer, selectionHash } from "../server.mjs";
import { startFrozenRun } from "../run.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const plainFile = path.join(root, "cleanup-plain.html");
const plainSrc = fs.readFileSync(plainFile, "utf8");
const threeSrc = fs.readFileSync(path.join(root, "cleanup.html"), "utf8");
const moduleScript = /<script type="module">([\s\S]*?)<\/script>/.exec(plainSrc)[1];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const call = (port, { method = "GET", p = "/", headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: p, method, headers, agent: false }, res => {
    let d = ""; res.on("data", x => d += x); res.on("end", () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
  });
  req.on("error", reject); if (body !== undefined) req.write(body); req.end();
});
const post = (srv, p) => call(srv.port, { method: "POST", p, body: "{}", headers: { origin: `http://127.0.0.1:${srv.port}`, "content-type": "application/json", "x-nuke-token": srv.token } });

async function withPlainServer(fn, opts = {}) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "plain-"));
  try {
    const wr = path.join(t, "work"); fs.mkdirSync(wr);
    const f = path.join(wr, "a.txt"); fs.writeFileSync(f, "x");
    const sel = { sessionId: "S", allowedRoots: [wr], protectedPaths: [], livePaths: [], paths: [f] };
    sel.sha256 = selectionHash(sel);
    const selectionFile = path.join(t, "selection.json"); fs.writeFileSync(selectionFile, JSON.stringify(sel));
    const s = createCleanupServer({ selectionFile, pageFile: plainFile, soundsDir: path.join(root, "sounds"), minGapMs: 200, ttlMs: 60000, afterDoneMs: 50, ageCheckOffForTests: true, ...opts });
    const { port } = await s.listen();
    try { await fn({ port, token: s.token, s, file: f, port2: port, audit: path.join(t, "nuke-audit.log") }); } finally { s.close(); }
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}

test("the plain page is served only with the token, has no 3D bootstrap, no vendor files, and a CSP that hashes its inline scripts", async () => {
  await withPlainServer(async ({ port, token }) => {
    assert.equal((await call(port, { p: "/" })).status, 403);
    const ok = await call(port, { p: `/?t=${token}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, plainSrc);
    assert.ok(!/\/vendor\/|three|importmap|<canvas|WebGL|\.mp3|sounds\//i.test(ok.body), "no 3D library, canvas, importmap or sounds");
    const csp = ok.headers["content-security-policy"];
    assert.ok(!/unsafe-inline/.test(csp.split("style-src")[0]) && !/https?:/.test(csp));
    const hashes = [...ok.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/\bsrc\s*=/i.test(m[1])).map(m => "'sha256-" + crypto.createHash("sha256").update(m[2], "utf8").digest("base64") + "'");
    assert.equal(hashes.length, 2);
    for (const h of hashes) assert.ok(csp.includes(h), "inline script hashed in the CSP");
  });
});

test("plain page source: same server calls as the 3D page (state, events, unlock, confirm), nothing external, no markup injection", () => {
  assert.deepEqual(plainSrc.match(/https?:\/\/[^\s"'`)<>]+/g) || [], []);
  assert.ok(!/<(link|img|iframe|object|embed|form)\b/i.test(plainSrc) && !/<script[^>]*\ssrc=/i.test(plainSrc));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setTimeout\(\s*['"`]/.test(moduleScript));
  assert.ok(!/(^|[^.\w])(WebSocket|XMLHttpRequest|sendBeacon|importScripts)\b/.test(moduleScript));
  assert.ok(moduleScript.includes("postApi('unlock')") && moduleScript.includes("postApi('confirm')") && moduleScript.includes("getJson('state')") && moduleScript.includes("new EventSource('events?t='"));
  assert.ok(moduleScript.includes("'x-nuke-token': TOKEN"));
  // the token is scrubbed from the address bar before anything else runs
  assert.match(plainSrc, /history\.replaceState\(null, '', location\.pathname\)/);
  // wording: both buttons exist with the requested labels; the page cannot read a mode from the address bar
  assert.ok(plainSrc.includes(">Unlock</button>") && plainSrc.includes(">Delete permanently</button>"));
  assert.ok(!/location\.(search|hash)|URLSearchParams\(location/.test(moduleScript));
  // the countdown and the done summary are there
  assert.ok(plainSrc.includes('role="timer"') && plainSrc.includes("Closes automatically in"));
  assert.ok(/e\.type === 'done'/.test(moduleScript));
  // parses
  new vm.Script("(async()=>{" + moduleScript.replace(/^\s*boot\(\);\s*$/m, "") + "})", { filename: "cleanup-plain.module.js" });
});

test("the plain page cannot skip a gate: delete is refused until Unlock, and again during the minimum gap; then it deletes", async () => {
  await withPlainServer(async ({ s, file, port, token, audit }) => {
    const srv = { port, token };
    assert.equal((await post(srv, "/confirm")).status, 409, "confirm before unlock refused");
    assert.ok(fs.existsSync(file));
    assert.equal((await post(srv, "/unlock")).status, 200);
    const early = await post(srv, "/confirm");
    assert.equal(early.status, 409, "confirm inside the minimum gap refused");
    assert.equal(JSON.parse(early.body).error, "too fast");
    assert.ok(fs.existsSync(file), "nothing deleted by the early confirm");
    await sleep(260);
    assert.equal((await post(srv, "/confirm")).status, 200);
    const end = Date.now() + 10000;
    while (s.getState() !== "done" && Date.now() < end) await sleep(20);
    assert.equal(s.getState(), "done");
    assert.ok(!fs.existsSync(file));
    assert.ok(fs.readFileSync(audit, "utf8").includes('"state":"started"'), "the audit log is written first, as in the 3D mode");
  });
});

test("the plain page still needs the token on every call and expires like the 3D page", async () => {
  await withPlainServer(async ({ port, token, s, file }) => {
    const noTok = await call(port, { method: "POST", p: "/unlock", body: "{}", headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" } });
    assert.equal(noTok.status, 403);
    assert.equal((await call(port, { p: "/state" })).status, 403);
    const st = JSON.parse((await call(port, { p: `/state?t=${token}` })).body);
    assert.equal(st.state, "armed");
    assert.ok(st.remainingMs > 0, "the countdown value the page shows comes from the server");
    assert.equal(st.items.length, 1);
    await sleep(300);
    assert.ok(fs.existsSync(file));
  }, { ttlMs: 60000 });
  await withPlainServer(async ({ s, file }) => {
    await sleep(400);
    assert.equal(s.getState(), "expired");
    assert.ok(fs.existsSync(file), "expiry deletes nothing");
  }, { ttlMs: 150 });
});

// ---- the choice is made by the app (startFrozenRun option), not by a page, URL or serverOpts ----
async function frozen(opts) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "plainrun-"));
  try {
    const wr = path.join(t, "work"); fs.mkdirSync(wr);
    const f = path.join(wr, "a.txt"); fs.writeFileSync(f, "x");
    const sel = { sessionId: "S", paths: [f], allowedRoots: [wr], protectedPaths: [], livePaths: [] };
    sel.sha256 = selectionHash(sel);
    const seen = [];
    const createServer = o => { seen.push(o); return { runId: "0123456789abcdef", listen: async () => ({ url: "http://127.0.0.1:1/?t=" + "a".repeat(64) }), close() {} }; };
    await startFrozenRun(sel, { runDir: path.join(t, "run"), createServer, scanStartMs: Date.now(), ...opts });
    return seen[0];
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}

test("startFrozenRun: default and plainConfirm:false serve cleanup.html; plainConfirm:true serves cleanup-plain.html; serverOpts cannot change the page", async () => {
  assert.equal(path.basename((await frozen({})).pageFile), "cleanup.html");
  assert.equal(path.basename((await frozen({ plainConfirm: false })).pageFile), "cleanup.html");
  assert.equal(path.basename((await frozen({ plainConfirm: true })).pageFile), "cleanup-plain.html");
  const forged = await frozen({ serverOpts: { pageFile: "C:\\evil.html", plainConfirm: true } });
  assert.equal(path.basename(forged.pageFile), "cleanup.html", "serverOpts is a whitelist: no pageFile, no mode");
  for (const bad of ["true", 1, null, {}, []]) await assert.rejects(frozen({ plainConfirm: bad }), TypeError);
});

test("default 3D page is unchanged by the option: still the module with three.js, importmap and the key/glass/button steps", () => {
  assert.ok(threeSrc.includes('<script type="importmap">') && threeSrc.includes("/vendor/three.module.js"));
  assert.ok(threeSrc.includes("postApi('unlock')") && threeSrc.includes("postApi('confirm')"));
  assert.ok(!threeSrc.includes("plainConfirm") && !threeSrc.includes("cleanup-plain"), "the 3D page knows nothing about the plain mode");
});
