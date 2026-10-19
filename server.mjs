// server.mjs
// Single-use localhost server: one selection, one run. Holds the state machine and is the only
// code path that triggers deletion. Every request is treated as hostile.
// No outbound requests, no shell, no exec. Binds 127.0.0.1 only.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { checkPath, within } from "./lib/safepath.mjs";
import { removeItem, adminProblem } from "./lib/delete.mjs";
import { dirSize } from "./lib/sizes.mjs";
import { AGE_SKEW_MS } from "./lib/age.mjs";

const WIN = process.platform === "win32";
const MAX_BODY = 1024;          // bytes accepted on POST bodies
const BODY_TIMEOUT_MS = 5000;   // time allowed to receive a POST body
const MAX_SSE_CLIENTS = 8;

export function selectionHash(sel) {
  const { sessionId, paths, allowedRoots, protectedPaths, livePaths } = sel;
  return crypto.createHash("sha256").update(JSON.stringify({ sessionId, paths, allowedRoots, protectedPaths, livePaths })).digest("hex");
}

const deepFreeze = o => { for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v); return Object.freeze(o); };
const strList = l => Array.isArray(l) && l.every(s => typeof s === "string");
// UNC and device forms (\\host\share, \\?\, \\.\, //?/, //./, mixed slashes): rejected in any root
// list BEFORE checkPath sees them, because checkPath canonicalises option lists with realpath (an SMB request).
const isUncOrDevice = p => /^[\\/]{2}/.test(p);
function rootList(name, l) {
  if (!strList(l)) throw new Error(`bad ${name}`);
  for (const p of l) if (isUncOrDevice(p)) throw new Error(`bad ${name}: UNC or device path refused`);
  return l;
}

// Parse and validate the selection file. Fails closed: anything odd throws.
function loadSelection(raw) {
  let s;
  try { s = JSON.parse(raw); } catch { throw new Error("bad selection: not JSON"); }
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("bad selection: not an object");
  if (typeof s.sessionId !== "string" || !strList(s.paths) || !strList(s.allowedRoots) || !strList(s.protectedPaths) || !strList(s.livePaths))
    throw new Error("bad selection: missing or malformed field");
  if (typeof s.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(s.sha256)) throw new Error("bad selection: missing hash");
  if (selectionHash(s) !== s.sha256) throw new Error("selection hash mismatch");
  const { sessionId, paths, allowedRoots, protectedPaths, livePaths, sha256 } = s;
  return deepFreeze(structuredClone({ sessionId, paths, allowedRoots, protectedPaths, livePaths, sha256 }));
}

const ms = (name, v) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`bad option ${name}`);
  return v;
};

// The scan's start time (ms since the epoch) is a trusted option: finite, not negative, and not (beyond a little clock skew) in the future.
// Same small tolerance as the age comparison (lib/age.mjs): the value is taken from this machine's own clock a moment ago.
const scanStart = v => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > Date.now() + AGE_SKEW_MS) throw new Error("bad option scanStartMs");
  return v;
};

const baseHeaders = {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// No 'unsafe-inline' for scripts: every inline <script> block of the page that is actually served is allowed by its
// sha256 (computed from the served bytes at startup, so the page and the policy cannot drift apart).
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(`'sha256-${crypto.createHash("sha256").update(m[2], "utf8").digest("base64")}'`);
  }
  return out;
}
export function cspFor(html) {
  return ["default-src 'self'", `script-src 'self'${inlineScriptHashes(html).map(h => " " + h).join("")}`, "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "media-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");
}
// The only third-party code the page runs: three.js 0.160.0, vendored (sha384 pinned in test/cleanup-page.test.mjs).
const VENDOR = new Set(["three.module.js", "RoundedBoxGeometry.js", "RoomEnvironment.js"]);
// sha384 of the three vendored files (three.js 0.160.0, verified against the pinned jsDelivr files). A page that uses
// /vendor/ is only served if every file still matches.
export const VENDOR_SHA384 = {
  "three.module.js": "sha384-61S/Nu32S3E5+n+KpCOTb2eRYps6fVKm+9Gz1QBvSePFthb46f063Aa/qe/lykFZ",
  "RoundedBoxGeometry.js": "sha384-S52/WAm3DaIIFna675h5dmavqea/akLlPFtPdnzgWWhnz+/nMqR6PPsSXPOd8Gpw",
  "RoomEnvironment.js": "sha384-ZGqh+dJjt6z9NHsWYYt+TPDFj8y+2If7naI6a6AkkyNZyH51CVS3HTWFh0njp4k6",
};
function verifyVendor(dir) {
  for (const [name, want] of Object.entries(VENDOR_SHA384)) {
    let got = null;
    try {
      const f = path.join(dir, name);
      if (fs.lstatSync(f).isFile()) got = "sha384-" + crypto.createHash("sha384").update(fs.readFileSync(f)).digest("base64");
    } catch { got = null; }
    if (got !== want) throw new Error(`vendored file ${name} is missing or does not match its pinned sha384; refusing to start`);
  }
}
const VENDOR_RE = /^\/vendor\/([A-Za-z0-9._-]{1,64})$/;

// Timing values come only from this options object (CLI or tests), never from request data.
// Trusted options (from run.mjs): expectedSha256 must match the selection bytes; allowedRoots,
// protectedPaths and livePaths, when given, override the file (which then only supplies paths).
export function createCleanupServer({ selectionFile, pageFile, soundsDir, vendorDir, minGapMs = 2000, ttlMs = 60000, afterDoneMs = 30000, auditFile,
  expectedSha256, allowedRoots, protectedPaths, livePaths, adminContents = false, scanStartMs, ageCheckOffForTests = false, onClose } = {}) {
  // Phase 1b: trusted option only (from run.mjs), never read from selection.json or a request.
  if (typeof adminContents !== "boolean") throw new Error("bad option adminContents");
  // Release gate: trusted option only (from the app / run.mjs), never read from selection.json or a request. Entries changed after it are not deleted.
  // Fail closed: the scan start time is REQUIRED. The only way to run without an age check is the explicitly named test-only
  // option below, which run.mjs never forwards (its serverOpts whitelist does not include it) and nothing in a request, the
  // selection file or the environment can set.
  if (typeof ageCheckOffForTests !== "boolean") throw new Error("bad option ageCheckOffForTests");
  if (vendorDir !== undefined && (typeof vendorDir !== "string" || !vendorDir)) throw new Error("bad option vendorDir");
  if (onClose !== undefined && typeof onClose !== "function") throw new Error("bad option onClose");
  const vendorRoot = vendorDir || path.join(path.dirname(pageFile), "vendor");
  const runId = crypto.randomBytes(8).toString("hex");
  for (const [k, v] of Object.entries({ selectionFile, pageFile, soundsDir })) if (typeof v !== "string" || !v) throw new Error(`bad option ${k}`);
  if (auditFile !== undefined && (typeof auditFile !== "string" || !auditFile)) throw new Error("bad option auditFile");
  minGapMs = ms("minGapMs", minGapMs); ttlMs = ms("ttlMs", ttlMs); afterDoneMs = ms("afterDoneMs", afterDoneMs);

  const rawSelection = fs.readFileSync(selectionFile, "utf8");
  const sel = loadSelection(rawSelection);
  const frozenHash = sel.sha256;
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== "string" || expectedSha256 !== frozenHash)) throw new Error("selection hash mismatch (expectedSha256)");
  const trusted = (name, v, fromFile) => deepFreeze([...rootList(name, v === undefined ? fromFile : v)]);
  rootList("selection allowedRoots", sel.allowedRoots); rootList("selection protectedPaths", sel.protectedPaths); rootList("selection livePaths", sel.livePaths);
  const check = Object.freeze({
    allowedRoots: trusted("allowedRoots", allowedRoots, sel.allowedRoots),
    protectedPaths: trusted("protectedPaths", protectedPaths, sel.protectedPaths),
    livePaths: trusted("livePaths", livePaths, sel.livePaths),
    adminContents: adminContents === true,
  });
  // (checked here, after the selection and root options, so their own refusals keep their messages)
  if (ageCheckOffForTests && scanStartMs !== undefined) throw new Error("bad option: scanStartMs and ageCheckOffForTests are both set");
  if (!ageCheckOffForTests && scanStartMs === undefined) throw new Error("bad option scanStartMs: required");
  const notAfterMs = ageCheckOffForTests ? undefined : scanStart(scanStartMs);
  const audit = auditFile || path.join(path.dirname(selectionFile), "nuke-audit.log");

  const token = crypto.randomBytes(32).toString("hex");
  const tokenDigest = crypto.createHash("sha256").update(token).digest();
  const tokenOk = t => typeof t === "string" && crypto.timingSafeEqual(crypto.createHash("sha256").update(t).digest(), tokenDigest);
  // The page is read once, with this run's token substituted into its import map (so module requests carry it),
  // and its CSP is computed from exactly those bytes.
  let pageHtml = null;
  try { pageHtml = fs.readFileSync(pageFile, "utf8").split("__NUKE_TOKEN__").join(token); } catch { pageHtml = null; }
  if (pageHtml !== null && pageHtml.includes("/vendor/")) verifyVendor(vendorRoot);
  const hdrs = { ...baseHeaders, "Content-Security-Policy": cspFor(pageHtml || "") };

  // R3: every selected path goes through checkPath BEFORE dirSize. Refused paths are shown with
  // size 0, never sized, and never offered for deletion (even if they become valid later).
  const shown = [], offered = new Set();
  sel.paths.forEach((p, i) => {
    let v = checkPath(p, check);
    // R41 defence in depth: in administrator mode only a direct-child file of an administrator folder may be offered.
    if (v.ok && check.adminContents) { let why; try { why = adminProblem(v, undefined, true); } catch { why = "administrator folders unresolved"; } if (why) v = { ok: false, reason: why }; }
    if (v.ok) { offered.add(i); shown.push({ path: v.resolved, isDir: v.isDir, bytes: dirSize(v.resolved) }); }
    else shown.push({ path: p, isDir: false, bytes: 0, refused: true, reason: v.reason });
  });
  // A duplicate entry, or an entry inside another offered folder, is shown with bytes 0 (coveredBy)
  // so no total double-counts. Deletion handles it as "already gone" or deletes it first.
  for (const i of offered) {
    const me = shown[i];
    const cover = [...offered].find(j => {
      if (j === i || !within(me.path, shown[j].path)) return false;
      const same = within(shown[j].path, me.path);
      return same ? j < i : shown[j].isDir; // duplicate: earliest wins; nested: inside a selected folder
    });
    if (cover !== undefined) { me.bytes = 0; me.coveredBy = shown[cover].path; }
  }
  const totalBytes = shown.reduce((n, it) => n + it.bytes, 0);
  deepFreeze(shown);
  // statfs only local drive roots of accepted paths (never a UNC host: that would be a network request).
  const localRoot = r => (WIN ? /^[A-Za-z]:\\$/.test(r) : r === "/");
  const roots = [...new Set(shown.filter((_, i) => offered.has(i)).map(it => path.parse(it.path).root))].filter(localRoot);
  const freeByDrive = () => Object.fromEntries(roots.map(r => {
    try { const s = fs.statfsSync(r); return [r, { total: s.blocks * s.bsize, free: s.bavail * s.bsize, ok: true }]; } catch { return [r, { total: 0, free: 0, ok: false }]; }
  }));
  const drives0 = freeByDrive();

  let expiresAtMono = 0, state = "armed", unlockedAt = 0, port = 0, server, ttlTimer, doneTimer, closed = false, listening = false;
  const events = [], clients = new Set();
  const emit = e => { events.push(e); const line = `data: ${JSON.stringify(e)}\n\n`; for (const c of clients) { try { c.write(line); } catch { /* client gone */ } } };
  const setState = s => { state = s; emit({ type: "state", state: s }); };
  // Append-only, paths and sizes only, never file contents.
  const auditLine = rec => JSON.stringify({ at: new Date().toISOString(), sessionId: sel.sessionId, sha256: frozenHash, runId, ...rec }) + "\n";
  // Strict append: open (append mode), write, fsync, close. Returns false on any failure.
  const auditStrict = rec => {
    let fd;
    try { fd = fs.openSync(audit, "a"); fs.writeSync(fd, auditLine(rec)); fs.fsyncSync(fd); return true; }
    catch { return false; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  };
  const writeAudit = rec => { auditStrict(rec); }; // best effort after the "started" line
  const send = (res, code, obj, extra = {}) => {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(code, { ...hdrs, "Content-Type": "application/json", ...extra }); res.end(JSON.stringify(obj));
  };

  // The selection on disk and in memory must both still match the hash frozen at launch.
  function selectionUnchanged() {
    try {
      const now = fs.readFileSync(selectionFile, "utf8");
      if (now !== rawSelection) return false;
      const parsed = JSON.parse(now);
      return parsed.sha256 === frozenHash && selectionHash(parsed) === frozenHash && selectionHash(sel) === frozenHash;
    } catch { return false; }
  }

  async function runDeletion() {
    const before = freeByDrive();
    const results = new Array(sel.paths.length);
    // Shallowest paths first: a selected folder goes (whole) before anything selected inside it. Otherwise removing the inner
    // item would stamp the folder's own mtime with "now" and the age re-check would then refuse the folder as changed. Results
    // are kept in selection order.
    const depth = p => path.resolve(String(p)).split(/[\\/]+/).length;
    const order = sel.paths.map((_, i) => i).sort((a, b) => depth(sel.paths[a]) - depth(sel.paths[b]) || a - b);
    for (const i of order) {
      const r = offered.has(i)
        ? removeItem(sel.paths[i], check, notAfterMs === undefined ? {} : { notAfterMs })
        : { path: shown[i].path, status: "skipped", reason: `refused at launch: ${shown[i].reason}`, bytes: 0 };
      results[i] = r; emit({ type: "item", ...r });
      await new Promise(r2 => setImmediate(r2));
    }
    const after = freeByDrive();
    const freedBytes = Object.keys(after).reduce((n, d) => n + Math.max(0, after[d].free - before[d].free), 0);
    // measured: every reported drive could be read both before and after; otherwise freedBytes is not a measurement.
    const measured = Object.keys(before).length > 0 && Object.keys(before).every(d => before[d].ok === true && after[d] && after[d].ok === true);
    const sumBytes = results.reduce((n, r) => n + (r.status === "deleted" ? r.bytes : 0), 0);
    writeAudit({ state: "done", results, freedBytes, sumBytes, measured, drivesBefore: before, drivesAfter: after });
    setState("done"); emit({ type: "done", runId, freedBytes, sumBytes, measured, drivesBefore: before, drivesAfter: after, results });
    doneTimer = setTimeout(close, afterDoneMs); doneTimer.unref();
  }

  // R2/R16a: abort deletes nothing and closes the server unconditionally.
  function abort(res, reason) {
    setState("aborted");
    writeAudit({ state: "aborted", reason, selected: sel.paths });
    res.on("close", close); res.on("finish", close);
    send(res, 409, { error: reason }, { Connection: "close" });
    setImmediate(close);
  }
  function onUnlock(res) {
    if (state !== "armed") return send(res, 409, { error: `state is ${state}` });
    unlockedAt = performance.now(); setState("unlocked"); return send(res, 200, { ok: true });
  }
  function onConfirm(res) {
    if (state !== "unlocked") return send(res, 409, { error: `state is ${state}` });
    const wait = unlockedAt + minGapMs - performance.now();
    if (wait > 0) return send(res, 409, { error: "too fast", retryInMs: wait });
    if (!selectionUnchanged()) return abort(res, "selection changed");
    setState("confirmed");
    // R16a: the audit log must be writable BEFORE anything is deleted; otherwise delete nothing.
    if (!auditStrict({ state: "started", sha256: frozenHash, count: sel.paths.length, adminContents: check.adminContents,
      items: shown.map(it => ({ path: it.path, bytes: it.bytes, ...(it.refused ? { refused: true } : {}) })) })) return abort(res, "audit log unavailable");
    setState("deleting");
    send(res, 200, { ok: true });
    runDeletion().catch(e => {
      setState("failed"); writeAudit({ state: "failed", reason: String((e && e.code) || "error") }); close();
    });
  }

  function readBody(req, res, then) {
    const refuse = (code, error) => {
      if (res.headersSent) return;
      res.on("finish", () => req.socket.destroy());
      send(res, code, { error }, { Connection: "close" });
    };
    const declared = req.headers["content-length"];
    if (declared !== undefined && !(/^\d+$/.test(declared) && Number(declared) <= MAX_BODY)) return refuse(413, "body too large");
    let size = 0, over = false; const chunks = [];
    req.setTimeout(BODY_TIMEOUT_MS, () => refuse(408, "timeout"));
    req.on("data", c => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) { over = true; refuse(413, "body too large"); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over || res.headersSent) return;
      try { JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { error: "body must be JSON" }); }
      then(); // body content is ignored: nothing in a request can change the selection or timing
    });
    req.on("error", () => {});
  }

  const ROUTES = { "/": "GET", "/state": "GET", "/events": "GET", "/unlock": "POST", "/confirm": "POST" };
  const SOUND = /^\/sounds\/([a-z0-9-]{1,64})\.mp3$/;

  function handle(req, res) {
    const good = `127.0.0.1:${port}`, goodOrigin = `http://${good}`;
    if (req.headers.host !== good) return send(res, 403, { error: "bad host" });
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== goodOrigin) return send(res, 403, { error: "bad origin" });
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") return send(res, 403, { error: "cross-site" });
    if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "method not allowed" });

    const raw = typeof req.url === "string" ? req.url : "";
    const q = raw.indexOf("?");
    const pathname = q === -1 ? raw : raw.slice(0, q);
    const params = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));

    if (req.method === "POST") {
      if (origin !== goodOrigin) return send(res, 403, { error: "origin required" });
      if (!tokenOk(req.headers["x-nuke-token"])) return send(res, 403, { error: "bad token" });
    } else if (!tokenOk(params.get("t"))) return send(res, 403, { error: "bad token" });

    if (!/^\/[A-Za-z0-9/._-]*$/.test(pathname) || pathname.startsWith("//")) return send(res, 404, { error: "not found" });
    const sound = SOUND.exec(pathname);
    const vend = VENDOR_RE.exec(pathname);
    const want = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : sound || (vend && VENDOR.has(vend[1])) ? "GET" : null;
    if (!want) return send(res, 404, { error: "not found" });
    if (req.method !== want) return send(res, 405, { error: `use ${want}` }, { Allow: want });

    if (req.method === "POST") {
      if (!/^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(req.headers["content-type"] || "")) return send(res, 415, { error: "json only" });
      return readBody(req, res, () => (pathname === "/unlock" ? onUnlock(res) : onConfirm(res)));
    }

    if (pathname === "/") {
      if (pageHtml === null) return send(res, 404, { error: "not found" });
      res.writeHead(200, { ...hdrs, "Content-Type": "text/html; charset=utf-8" }); return res.end(pageHtml);
    }
    if (pathname === "/state") return send(res, 200, { state, sessionId: sel.sessionId, items: shown, totalBytes, drives: drives0, minGapMs, remainingMs: Math.max(0, Math.round(expiresAtMono - performance.now())) });
    if (pathname === "/events") {
      if (clients.size >= MAX_SSE_CLIENTS) return send(res, 429, { error: "too many listeners" });
      res.writeHead(200, { ...hdrs, "Content-Type": "text/event-stream" });
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "state", state })}\n\n`);
      clients.add(res); req.on("close", () => clients.delete(res)); return;
    }
    if (vend) { // fixed whitelist of three vendored files, directly inside vendorDir, regular files only
      try {
        const f = path.join(vendorRoot, vend[1]);
        if (!fs.lstatSync(f).isFile()) throw new Error("not a file");
        const b = fs.readFileSync(f);
        res.writeHead(200, { ...hdrs, "Content-Type": "text/javascript; charset=utf-8" }); return res.end(b);
      } catch { return send(res, 404, { error: "not found" }); }
    }
    // sounds: name is a strict slug, file must be a regular file directly inside soundsDir
    try {
      const f = path.join(soundsDir, `${sound[1]}.mp3`);
      if (!fs.lstatSync(f).isFile()) throw new Error("not a file");
      const b = fs.readFileSync(f);
      res.writeHead(200, { ...hdrs, "Content-Type": "audio/mpeg" }); return res.end(b);
    } catch { return send(res, 404, { error: "not found" }); }
  }

  function close() {
    if (closed) return; closed = true;
    clearTimeout(ttlTimer); clearTimeout(doneTimer);
    for (const c of clients) { try { c.end(); } catch { /* gone */ } }
    clients.clear();
    if (server) { try { server.close(); server.closeAllConnections(); } catch { /* already closed */ } }
    if (onClose) { try { onClose(); } catch { /* never let cleanup of a lock file break shutdown */ } }
  }

  return {
    token, runId, getState: () => state, close,
    listen() {
      if (listening || closed) return Promise.reject(new Error("server is single-use"));
      listening = true;
      server = http.createServer({ requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 1000, maxHeaderSize: 8192, requireHostHeader: false /* our own check answers 403 */ }, (req, res) => {
        try { handle(req, res); } catch { send(res, 500, { error: "internal" }); }
      });
      server.on("clientError", (_e, sock) => { try { sock.destroy(); } catch { /* gone */ } });
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          port = server.address().port;
          expiresAtMono = performance.now() + ttlMs;
          ttlTimer = setTimeout(() => {
            if (state === "armed" || state === "unlocked") {
              setState("expired"); writeAudit({ state: "expired", selected: sel.paths }); close();
            } else if (state === "aborted") close();
          }, ttlMs);
          ttlTimer.unref();
          resolve({ port, url: `http://127.0.0.1:${port}/?t=${token}` });
        });
      });
    },
  };
}
