// run.mjs: command-line glue for /nuke. Scans (read-only), builds the selection file, starts the server.
// This file never deletes anything: deletion happens only inside server.mjs after the user's gesture.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { scanSession, readRunningSessions, pidAlive, TOOL_PROTECTED } from "./scan.mjs";
import { acquireLock, setLockPort, releaseLock } from "./lib/lock.mjs";
import { createCleanupServer, selectionHash } from "./server.mjs";
import { checkPath, within, dirArgProblem } from "./lib/safepath.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const readdir = d => { try { return fs.readdirSync(d); } catch { return []; } };

export class UsageError extends Error {}

// What is hashed: the UTF-8 bytes of JSON.stringify({sessionId, paths, allowedRoots, protectedPaths, livePaths})
// with the keys in exactly that order. server.mjs selectionHash hashes the identical text; we assert they agree.
export function canonicalText(sel) {
  const { sessionId, paths, allowedRoots, protectedPaths, livePaths } = sel;
  return JSON.stringify({ sessionId, paths, allowedRoots, protectedPaths, livePaths });
}
function canonicalHash(sel) {
  const h = crypto.createHash("sha256").update(canonicalText(sel)).digest("hex");
  if (h !== selectionHash(sel)) throw new Error("hash canonicalisation differs from server.mjs");
  return h;
}

// Binds a launch to a scan: sessionId, claudeDir, roots, live flag and every item's group.
export function bindToken(map, live, current = null) {
  const groups = map.items.map(i => `${i.id}:${i.group}`).sort();
  return crypto.createHash("sha256").update(JSON.stringify({ v: 2, current: current ?? null, sessionId: map.sessionId, claudeDir: map.claudeDir,
    allowedRoots: map.allowedRoots, live: live === true, groups })).digest("hex");
}

// Only exclusive items, or shared items the caller listed in allowShared. Live/protected/unknown never pass.
export function buildSelection(map, ids, { allowShared = [] } = {}) {
  if (new Set(map.items.map(i => i.id)).size !== map.items.length) throw new Error("duplicate item ids in the scan; refusing");
  const byId = new Map(map.items.map(i => [i.id, i]));
  const paths = [];
  for (const id of new Set(ids)) {
    const it = byId.get(id);
    if (!it) throw new Error(`unknown item id ${clean(id, 40)}`);
    if (it.group === "live") throw new Error(`item ${id} is the live session and cannot be deleted yet`);
    if (it.group === "shared" && !allowShared.includes(id)) throw new Error(`item ${id} is shared with ${it.sharedWith.map(s => clean(s, 120)).join(", ")}; list it in allowShared to delete it`);
    if (it.group !== "exclusive" && it.group !== "shared") throw new Error(`item ${id} is ${it.group} and cannot be selected`);
    paths.push(it.path);
  }
  if (!paths.length) throw new Error("nothing selected");
  const sel = { sessionId: map.sessionId, allowedRoots: map.allowedRoots, protectedPaths: map.protectedPaths, livePaths: map.livePaths, paths };
  return { ...sel, sha256: canonicalHash(sel) };
}

// Every picked path must still pass checkPath against the selection's own roots (it must exist, too).
// adminContents (Phase 1b, strict boolean) is forwarded to checkPath; it is never part of the selection file.
export function revalidate(sel, { adminContents = false } = {}) {
  if (typeof adminContents !== "boolean") throw new TypeError("adminContents must be a boolean");
  const opts = { allowedRoots: sel.allowedRoots, protectedPaths: sel.protectedPaths, livePaths: sel.livePaths, adminContents };
  for (const p of sel.paths) {
    const v = checkPath(p, opts);
    if (!v.ok) throw new Error(`refused: ${clean(p)} (${clean(v.reason, 120)})`);
  }
}

const NONCE_RE = /^[A-Za-z0-9]{8,64}$/;
// Streams the file in chunks (with overlap) looking for the needle; never loads a whole transcript.
function fileHas(file, needle) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20), keep = needle.length - 1;
    let carry = "", pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) return false;
      pos += n;
      const text = carry + buf.toString("latin1", 0, n);
      if (text.includes(needle)) return true;
      carry = text.slice(-keep);
    }
  } finally { fs.closeSync(fd); }
}

// The current session is the ONE top-level transcript containing the nonce (the scan command line itself,
// which the model made up fresh, is in that transcript). 0 or 2+ matches: refuse. No fallback of any kind.
export function resolveSession(claudeDir, nonce) {
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) throw new UsageError("a nonce of 8 to 64 letters/digits is required to identify the current session");
  const projects = path.join(claudeDir, "projects");
  const hits = [];
  for (const f of readdir(projects)) {
    for (const n of readdir(path.join(projects, f))) {
      if (!n.endsWith(".jsonl")) continue;
      const file = path.join(projects, f, n);
      let st; try { st = fs.lstatSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      let has = false; try { has = fileHas(file, nonce); } catch { continue; }
      if (has) hits.push(n.slice(0, -6));
    }
  }
  if (hits.length === 0) throw new UsageError("could not identify the current session: no transcript contains the nonce");
  if (hits.length > 1) throw new UsageError("could not identify the current session: more than one transcript contains the nonce");
  if (!ID_RE.test(hits[0])) throw new UsageError("invalid session id");
  return hits[0];
}

// A session whose process is alive may only be targeted if it IS the current (nonce-identified) session.
export function assertTargetAllowed(claudeDir, sessionId, currentId, isAlive = pidAlive) {
  const running = readRunningSessions(path.join(claudeDir, "sessions"), isAlive);
  if (running.some(r => r.sessionId === sessionId) && sessionId !== currentId)
    throw new UsageError(`session ${sessionId} is running right now and is not the current session; refusing`);
}

// ONE sanitizer for every untrusted string that reaches the terminal (paths, ids from transcripts, notes, urls, names):
// control, format (RTL/zero-width) and line/paragraph separator characters are replaced, the text is capped, and the
// result is JSON-quoted, so no such string can start a new line or imitate a machine-readable line.
export function clean(s, max = 300) {
  const t = String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
  return JSON.stringify(t.length > max ? t.slice(0, max) + "..." : t);
}
const safeLabel = s => clean(s, 80);

const fmt = b => { const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return `${i === 0 || b >= 100 ? b.toFixed(0) : b.toFixed(1)} ${u[i]}`; };

export function summary(map) {
  const out = [`Session ${map.sessionId}`,
    `  name (untrusted text): ${map.sessionName ? safeLabel(map.sessionName) : "(none)"}   last active: ${map.lastActive ? safeLabel(map.lastActive) : "(unknown)"}`];
  for (const g of ["exclusive", "shared", "live"]) {
    const list = map.items.filter(i => i.group === g);
    if (!list.length) continue;
    const total = list.reduce((n, i) => n + i.bytes, 0);
    out.push("", `${g.toUpperCase()} (${list.length} items, ${fmt(total)})${g === "exclusive" ? " - pre-selected" : g === "shared" ? " - off by default" : " - never deleted by this tool; remove by hand after the session ends"}`);
    for (const i of list) out.push(`  [${clean(i.id, 40)}] ${fmt(i.bytes).padStart(8)}  ${clean(i.path)}${i.sharedWith.length ? `   (also: ${i.sharedWith.map(s => clean(s, 120)).join(", ")})` : ""}`);
  }
  out.push("", `PROTECTED: ${map.protected.length} refused (never selectable)`);
  for (const p of map.protected.slice(0, 8)) out.push(`  ${clean(p.reason, 120)}: ${clean(p.path)}`);
  if (map.offDisk.length) out.push("", `OFF-DISK (cannot delete here): ${map.offDisk.map(o => `${clean(o.kind, 40)} ${clean(o.note)}`).join("; ")}`);
  for (const [d, s] of Object.entries(map.drives)) out.push("", `Drive ${clean(d, 20)}: ${fmt(s.free)} free of ${fmt(s.total)}`);
  return out.join("\n");
}

// Launch: rescan now (a map file on disk is never trusted), check the binding, pick only the requested ids,
// re-validate, write the selection, then start the server with all four trusted options from this scan.
const SERVER_OPTS = ["minGapMs", "ttlMs", "afterDoneMs", "auditFile"];
export async function launchNuke({ claudeDir, sessionId, roots, targetIsLive = true, tmpDir, ids, allowShared = [], outDir, bind,
  currentId = null, isAlive = pidAlive, createServer = createCleanupServer, serverOpts = {} }) {
  assertTargetAllowed(claudeDir, sessionId, currentId, isAlive);
  const scanStartMs = Date.now(); // trusted: the server refuses to delete anything changed after this moment
  const scanned = scanSession({ claudeDir, sessionId, roots, targetIsLive, isAlive, ...(tmpDir ? { tmpDir } : {}) });
  if (typeof bind !== "string" || bind !== bindToken(scanned, targetIsLive === true, currentId)) throw new UsageError("binding mismatch: the scan changed or does not match this launch; run scan again");
  // belt and braces: every live item is also a live path, carried in the selection and re-checked by the server
  const livePaths = [...new Set([...scanned.livePaths, ...scanned.items.filter(i => i.group === "live").map(i => i.path)])];
  // the tool itself (code, page, vendor, lib, out/, lock, audit log) is never deletable, whatever the scan said
  const protectedPaths = [...new Set([...scanned.protectedPaths, ...TOOL_PROTECTED])];
  const map = { ...scanned, livePaths, protectedPaths };
  const sel = buildSelection(map, ids, { allowShared });
  revalidate(sel);
  return startFrozenRun(sel, { runDir: outDir, isAlive, createServer, serverOpts, scanStartMs });
}

// Library entry (also used by the app): freeze an already-built selection into runDir (lock first, then selection.json, exact-bytes
// read-back), then start the server with the trusted options taken from the selection. Never deletes.
export async function startFrozenRun(sel, { runDir, isAlive = pidAlive, createServer = createCleanupServer, serverOpts = {}, adminContents = false, scanStartMs, plainConfirm = false } = {}) {
  if (typeof adminContents !== "boolean") throw new TypeError("adminContents must be a boolean");
  // Trusted option from the app's own settings (never from a page or a request): the plain 2D confirm page instead of the 3D room.
  if (typeof plainConfirm !== "boolean") throw new TypeError("plainConfirm must be a boolean");
  // Fail closed: no scan start time, no run (the server would otherwise have no delete-time age limit).
  if (typeof scanStartMs !== "number" || !Number.isFinite(scanStartMs)) throw new TypeError("scanStartMs must be a finite number");
  if (typeof runDir !== "string" || !path.isAbsolute(runDir)) throw new Error("runDir must be an absolute path");
  const opts = {};
  for (const k of SERVER_OPTS) if (Object.hasOwn(serverOpts, k)) opts[k] = serverOpts[k];
  if (opts.auditFile !== undefined && !(typeof opts.auditFile === "string" && within(path.resolve(opts.auditFile), path.resolve(runDir)))) throw new Error("auditFile must be inside runDir");
  fs.mkdirSync(runDir, { recursive: true });
  // one live server at a time: out/nuke.lock {pid, port, startedAt}; a stale lock (dead pid or silent port) is replaced.
  // The lock is taken BEFORE selection.json is written, so a refused second launch cannot overwrite the first run's selection.
  const lockFile = path.join(runDir, "nuke.lock");
  try { await acquireLock(lockFile, isAlive); } catch (e) { if (e && e.code === "LOCKED") throw new UsageError(e.message); throw e; }
  try {
    const selectionFile = path.join(runDir, "selection.json");
    const bytes = JSON.stringify(sel);
    fs.writeFileSync(selectionFile, bytes);
    // the file on disk must be exactly what we wrote, and its embedded hash must cover its contents
    const back = fs.readFileSync(selectionFile, "utf8");
    if (back !== bytes || canonicalHash(JSON.parse(back)) !== sel.sha256) throw new Error("selection file changed while writing");
    const server = createServer({
      ...opts,
      selectionFile, pageFile: path.join(here, plainConfirm ? "cleanup-plain.html" : "cleanup.html"), soundsDir: path.join(here, "sounds"), vendorDir: path.join(here, "vendor"),
      expectedSha256: sel.sha256, allowedRoots: sel.allowedRoots, protectedPaths: sel.protectedPaths, livePaths: sel.livePaths,
      adminContents,
      scanStartMs,
      onClose: () => releaseLock(lockFile),
    });
    const { url } = await server.listen();
    let port = 0; try { port = Number(new URL(url).port); } catch { port = 0; }
    if (Number.isSafeInteger(port) && port > 0) setLockPort(lockFile, port); else releaseLock(lockFile);
    return { url, server, selection: sel, sha256: sel.sha256, runId: server.runId };
  } catch (e) { releaseLock(lockFile); throw e; }
}

// The ONLY process spawn in non-test code: hand the one-time URL to the user's default browser, no shell,
// fixed program, URL as a single argument. The agent that runs this command never sees the URL or the token.
// Resolves only once the process has really started; rejects with a message that never contains the URL or its arguments.
// The Windows folder is fixed (never %SystemRoot% from the environment, which a same-user program can steer).
export function openDefaultBrowser(url, spawnFn = spawn, systemRoot = "C:\\Windows") {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/\?t=[0-9a-f]{64}$/.test(url)) throw new Error("refusing to open an unexpected URL");
  if (process.platform !== "win32") throw new UsageError("opening the browser is only implemented for Windows");
  const exe = path.join(systemRoot, "System32", "rundll32.exe");   // full path: nothing on PATH or in the cwd can stand in for it
  if (!fs.existsSync(exe)) throw new Error("cannot open the browser: rundll32.exe was not found in the Windows System32 folder");
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("could not start your default browser"));
    let child;
    try { child = spawnFn(exe, ["url.dll,FileProtocolHandler", url], { shell: false, detached: true, stdio: "ignore", windowsHide: true }); } catch { return fail(); }
    if (!child || typeof child.once !== "function") return fail();
    child.once("error", fail);   // the original error carries spawnargs (the URL), so it is dropped here
    child.once("spawn", () => { try { child.unref(); } catch { /* ignore */ } resolve(); });
  });
}

// Hand a started run to the browser. If that fails the server is closed (this releases the lock; the one-time URL was never shown
// to anyone) and the error is rethrown. `open` is a parameter for tests only: nothing in the environment can change which
// program is started (the Windows folder is the fixed C:\Windows inside openDefaultBrowser).
export async function openRunInBrowser(r, open = openDefaultBrowser) {
  try { await open(r.url); } catch (e) { r.server.close(); throw e; }
}

// The CLI's failure path: print only the (token-free) message and exit 1. `error`/`exit` are parameters for tests.
export async function openBrowserOrExit(r, { open = openDefaultBrowser, error = console.error, exit = process.exit } = {}) {
  try { await openRunInBrowser(r, open); return true; } catch (e) {
    error(e instanceof Error ? e.message : "could not start your default browser");
    exit(1);
    return false;
  }
}

const FLAGS = new Set(["session", "claude-dir", "roots", "live", "out", "ids", "allow-shared", "tmp-dir", "bind", "nonce", "print-url"]);
const USAGE = "usage: node run.mjs scan --nonce <word> --session auto|<id> [--claude-dir D] [--roots a;b] [--live true|false] [--out F]\n" +
  "       node run.mjs launch --nonce <same word> --session <id> --bind <token> --ids i1,i2 [--allow-shared i3] [--claude-dir D] [--roots a;b] [--live true|false] [--out F]\n" +
  "       (--tmp-dir, --roots, --live false and --print-url true are sandbox-only: they need an explicit --claude-dir that is not the real one)";

// Strict flag parser: every flag needs a value, a value never starts with "--", unknown flags are errors.
export function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--") || !FLAGS.has(t.slice(2))) throw new UsageError(`unexpected argument ${t}`);
    const name = t.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    if (Object.hasOwn(f, name)) throw new UsageError(`--${name} given twice`);
    f[name] = v; i++;
  }
  return f;
}
const list = (v, sep, trim = true) => (v || "").split(sep).map(s => (trim ? s.trim() : s)).filter(s => s.length > 0);
const lc = p => (process.platform === "win32" ? p.toLowerCase() : p);
function vetDir(name, raw) {
  const why = dirArgProblem(raw);
  if (why) throw new UsageError(`${name}: ${why}`);
  return path.resolve(raw);
}
// Both the default ~/.claude and the CLAUDE_CONFIG_DIR folder (when set) count as the real Claude folder.
export function realClaudeDirs() {
  const dirs = [path.join(os.homedir(), ".claude")];
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (typeof env === "string" && env.trim() && path.isAbsolute(env)) dirs.push(path.resolve(env));
  return dirs;
}
export function isRealClaudeDir(dir) {
  return realClaudeDirs().some(real => {
    if (lc(path.resolve(dir)) === lc(real)) return true;
    try { return lc(fs.realpathSync.native(dir)) === lc(fs.realpathSync.native(real)); } catch { return false; }
  });
}

// Everything that can be checked without touching the disk happens here, before any scan.
export function parseCli(argv) {
  const cmd = argv[0];
  if (cmd !== "scan" && cmd !== "launch") throw new UsageError(cmd ? `unknown command ${cmd}` : "missing command");
  const f = parseFlags(argv.slice(1));
  const explicitDir = f["claude-dir"] !== undefined;
  const claudeDir = explicitDir ? vetDir("--claude-dir", f["claude-dir"]) : realClaudeDirs().at(-1);
  const sandbox = explicitDir && !isRealClaudeDir(claudeDir);
  if (f["tmp-dir"] !== undefined && !sandbox) throw new UsageError("--tmp-dir is test-only: it needs an explicit --claude-dir that is not the real ~/.claude");
  // A sandbox run never falls back to the real %TEMP%\claude scratch folder: it defaults to <sandbox>/tmp next to the claude dir.
  const tmpDir = f["tmp-dir"] !== undefined ? vetDir("--tmp-dir", f["tmp-dir"]) : sandbox ? path.join(path.dirname(claudeDir), "tmp") : undefined;
  const roots = f.roots !== undefined ? list(f.roots, ";", false).map(r => vetDir("--roots", r)) : undefined;
  if (f.roots !== undefined && !roots.length) throw new UsageError("--roots is empty");
  if (f.roots !== undefined && !sandbox) throw new UsageError("--roots is sandbox-only: it needs an explicit --claude-dir that is not the real Claude folder");
  if (f["print-url"] !== undefined && f["print-url"] !== "true") throw new UsageError("--print-url must be true");
  if (f["print-url"] !== undefined && (!sandbox || cmd !== "launch")) throw new UsageError("--print-url is sandbox-only (launch with an explicit --claude-dir that is not the real Claude folder)");
  if (f.live !== undefined && f.live !== "true" && f.live !== "false") throw new UsageError("--live must be exactly true or false");
  const targetIsLive = f.live !== "false";
  if (!targetIsLive && !sandbox) throw new UsageError("--live false is only allowed with an explicit --claude-dir that is not the real ~/.claude");
  const out = f.out !== undefined ? path.resolve(f.out) : path.join(here, "out", "map.json");
  if (f.out !== undefined && !sandbox && !within(out, path.join(here, "out"))) throw new UsageError("--out must be inside this project's out/ folder");
  const session = f.session ?? "auto";
  if (cmd === "launch") {
    if (session === "auto") throw new UsageError("launch needs an explicit --session <id>");
    if (!f.bind) throw new UsageError("launch needs --bind <token> from the scan");
    if (!f.ids) throw new UsageError("launch needs --ids");
  }
  if (session !== "auto" && !ID_RE.test(session)) throw new UsageError("invalid session id");
  if (f.nonce !== undefined && !NONCE_RE.test(f.nonce)) throw new UsageError("--nonce must be 8 to 64 letters or digits");
  if (cmd === "launch" && f.nonce === undefined) throw new UsageError("launch needs --nonce <the same word used for the scan>");
  return { cmd, claudeDir, tmpDir, roots, targetIsLive, out, session, bind: f.bind, nonce: f.nonce, sandbox, printUrl: f["print-url"] === "true",
    ids: list(f.ids, ","), allowShared: list(f["allow-shared"], ",") };
}

async function main() {
  let c;
  try { c = parseCli(process.argv.slice(2)); } catch (e) {
    if (e instanceof UsageError) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
    throw e;
  }
  // --session auto without --nonce is refused here (resolveSession needs a valid nonce): exit 2, nothing scanned
  const current = c.nonce !== undefined || c.session === "auto" ? resolveSession(c.claudeDir, c.nonce) : null;
  const session = c.session === "auto" ? current : c.session;
  // R25: the real flow cleans only the current (nonce-identified) session. Other ids are for the sandbox.
  if (!c.sandbox && session !== current) throw new UsageError("on the real Claude folder only the current session can be cleaned (use --session auto, or this session's own id)");
  if (c.cmd === "scan") {
    assertTargetAllowed(c.claudeDir, session, current);
    const map = scanSession({ claudeDir: c.claudeDir, sessionId: session, roots: c.roots, targetIsLive: c.targetIsLive, ...(c.tmpDir ? { tmpDir: c.tmpDir } : {}) });
    fs.mkdirSync(path.dirname(c.out), { recursive: true });
    fs.writeFileSync(c.out, JSON.stringify(map, null, 2)); // for display/debugging only; launch never reads it
    console.log(summary(map));
    // the one machine-readable line; every untrusted string above was sanitized, so none can imitate it
    console.log("NUKE_META=" + JSON.stringify({ session: map.sessionId, bind: bindToken(map, c.targetIsLive, current) }));
  } else {
    const r = await launchNuke({ claudeDir: c.claudeDir, sessionId: session, roots: c.roots, targetIsLive: c.targetIsLive, tmpDir: c.tmpDir,
      ids: c.ids, allowShared: c.allowShared, outDir: path.dirname(c.out), bind: c.bind, currentId: current });
    if (c.printUrl) console.log("NUKE_URL=" + r.url);   // sandbox only (parseCli): the real flow never prints the token URL
    else {
      if (await openBrowserOrExit(r)) console.log("opened default browser");
    }
    console.log("NUKE_META=" + JSON.stringify({ run: r.runId, sha: r.sha256 }));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => {
  console.error(e.message); process.exit(e instanceof UsageError ? 2 : 1);
});
