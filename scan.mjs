// scan.mjs  (read-only: this file must never call a delete function)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { checkPath, within, dirArgProblem } from "./lib/safepath.mjs";
import { fileURLToPath } from "node:url";
import { extractCandidates, extractCwds, extractOffDisk, firstTimestampMs } from "./lib/transcript.mjs";
import { classify } from "./lib/classify.mjs";
import { dirSize } from "./lib/sizes.mjs";

// The tool itself (its code, page, vendored files, audit log and lock) can never be a deletion target.
// fixture/ is deliberately not listed: the sandbox used by tests lives there.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_PROTECTED = ["run.mjs", "scan.mjs", "server.mjs", "cleanup.html", "cleanup-plain.html", "index.html", "package.json", "README.md",
  "lib", "vendor", "out", "sounds", ".git", "app", "scripts"].map(n => path.join(HERE, n));
const EXISTED_BEFORE = "(existed before this session)";
const UNCONFIRMED = "(write not confirmed)";
const UNPROVEN_REASON = "not proven created by this session (write unconfirmed, or the file is older than the session)";

const MAX_TRANSCRIPT_BYTES = 200 * 1024 * 1024;
const MAX_WALK_DEPTH = 8;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const NOT_KEYED = "Claude data not keyed to this session";
const BASH_ONLY = "(shell command only)";
const BASH_ONLY_REASON = "named only in a shell command; not proven written by this session";
// things the user is actively relying on: never offered for deletion
const CONFIG_NAMES = ["settings.json", "settings.local.json", "keybindings.json", "CLAUDE.md",
  "commands", "skills", "hooks", "plugins", "sessions", "backups", "cache", "state", "ide"];

const missing = e => e && (e.code === "ENOENT" || e.code === "ENOTDIR");
// ENOENT/ENOTDIR mean "nothing there"; any other failure must stop the scan (never silently under-read).
function listEnts(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (missing(e)) return []; throw e; }
}
const listNames = d => listEnts(d).map(e => e.name);
function readText(file) {
  if (fs.statSync(file).size > MAX_TRANSCRIPT_BYTES) throw new Error(`transcript too large to scan safely: ${file}`);
  return fs.readFileSync(file, "utf8");
}
// Comparison form: lowercase, every run of slashes/backslashes (incl. JSON-escaped) -> "/", git-bash /e/x -> e:/x.
const normText = s => s.toLowerCase().replace(/[\\/]+/g, "/").replace(/(?<=^|[\s"'(=,\[{;|<>])\/([a-z])\//g, "$1:/");
const idOf = p => crypto.createHash("sha1").update(p.toLowerCase()).digest("hex").slice(0, 16);

function walkJsonl(dir, out, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return;
  for (const e of listEnts(dir)) {
    const f = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkJsonl(f, out, depth + 1);
    else if (e.name.endsWith(".jsonl")) out.push(f);
  }
}

// Front matter = lines between the first two '---' lines; needs an exact `originSessionId: <id>` line.
function memoryClaimedBy(file, sessionId) {
  let head;
  try {
    const fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(8192); head = b.toString("utf8", 0, fs.readSync(fd, b, 0, b.length, 0)); } finally { fs.closeSync(fd); }
  } catch { return false; }
  const lines = head.split(/\r?\n/);
  if (lines[0].trim() !== "---") return false;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return false;
  return lines.slice(1, end).some(l => {
    const m = /^\s*originSessionId:\s*(.*?)\s*$/.exec(l);
    return m && m[1].replace(/^(["'])(.*)\1$/, "$2") === sessionId;
  });
}

// Windows-safe liveness: signal 0 only checks existence; EPERM means the process exists but is not ours.
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === "EPERM"; }
}
const cleanText = s => String(s).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim().slice(0, 80);

// Claude Code writes <claudeDir>/sessions/<pid>.json ({sessionId, pid, cwd, status, ...}). Strict, defensive read:
// anything malformed is ignored. Only sessions whose pid is alive are returned. Name is untrusted display text.
export function readRunningSessions(sessionsDir, isAlive = pidAlive) {
  const out = [];
  for (const n of listNames(sessionsDir)) {
    const m = /^([1-9]\d{0,9})\.json$/.exec(n);
    if (!m) continue;
    let j;
    try {
      const f = path.join(sessionsDir, n);
      const st = fs.lstatSync(f);
      if (!st.isFile() || st.size > 65536) continue;
      j = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch { continue; }
    if (!j || typeof j !== "object" || Array.isArray(j)) continue;
    if (typeof j.sessionId !== "string" || !ID_RE.test(j.sessionId)) continue;
    if (!Number.isSafeInteger(j.pid) || j.pid !== Number(m[1])) continue;
    let alive = false; try { alive = isAlive(j.pid) === true; } catch { alive = false; }
    if (!alive) continue;
    out.push({ sessionId: j.sessionId, pid: j.pid, name: typeof j.name === "string" && cleanText(j.name) ? cleanText(j.name) : null });
  }
  return out;
}

const RANK = { exclusive: 0, shared: 1, live: 2 };

export function scanSession({ claudeDir, sessionId, roots, targetIsLive = false, tmpDir = os.tmpdir(), home = os.homedir(), isAlive = pidAlive }) {
  if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) throw new Error("invalid session id");
  claudeDir = path.resolve(claudeDir);
  const projectsDir = path.join(claudeDir, "projects");
  const sessionsDir = path.join(claudeDir, "sessions");

  // transcripts: <folder>/<id>.jsonl, plus subagent transcripts anywhere under <folder>/<id>/**
  const transcripts = [];
  const folders = [];
  for (const fe of listEnts(projectsDir)) {
    if (!fe.isDirectory()) continue;
    folders.push(fe.name);
    const fdir = path.join(projectsDir, fe.name);
    for (const e of listEnts(fdir)) {
      const f = path.join(fdir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isFile() && e.name.endsWith(".jsonl")) transcripts.push({ folder: fe.name, id: e.name.slice(0, -6), file: f, main: true });
      else if (e.isDirectory() && e.name !== "memory") {
        const subs = []; walkJsonl(f, subs);
        for (const s of subs) transcripts.push({ folder: fe.name, id: e.name, file: s, main: false });
      }
    }
  }
  const own = transcripts.find(t => t.main && t.id === sessionId);
  if (!own) throw new Error(`no transcript found for session ${sessionId}`);
  const ownText = readText(own.file);

  const otherFiles = transcripts.filter(t => t.id !== sessionId);
  const byId = new Map();
  for (const t of otherFiles) {
    const e = byId.get(t.id) || { id: t.id, parts: [] };
    e.parts.push(normText(readText(t.file)));
    byId.set(t.id, e);
  }
  const others = [...byId.values()].map(e => ({ id: e.id, text: e.parts.join("\n") }));

  const scratch = path.join(tmpDir, "claude");
  const derived = roots && roots.length ? roots
    : extractCwds(ownText).filter(c => typeof c === "string" && dirArgProblem(c, { home }) === null);
  const allowedRoots = [...new Set([...derived, claudeDir, scratch].map(r => path.resolve(r)))];
  const protectedPaths = [
    ...CONFIG_NAMES.map(n => path.join(claudeDir, n)),
    path.join(claudeDir, "memory", "MEMORY.md"),
    ...folders.map(f => path.join(projectsDir, f, "memory", "MEMORY.md")),
    ...otherFiles.map(o => o.file),
    ...TOOL_PROTECTED,
  ];
  const startMs = firstTimestampMs(ownText);
  const running = readRunningSessions(sessionsDir, isAlive);
  // "<id>.live" marker files are a TEST-ONLY convention of the fixture sandbox; real Claude Code never writes them.
  // Real liveness comes from sessions/<pid>.json (readRunningSessions above).
  const liveIds = [...new Set([...listNames(sessionsDir).filter(n => n.endsWith(".live")).map(n => n.slice(0, -5)), ...running.map(r => r.sessionId)])];
  const isLive = targetIsLive === true || liveIds.includes(sessionId);
  const livePaths = transcripts.filter(t => t.main && liveIds.includes(t.id) && t.id !== sessionId).map(t => t.file);
  const check = { allowedRoots, protectedPaths, livePaths };

  const claudeBases = [...new Set([claudeDir, (() => { try { return fs.realpathSync.native(claudeDir); } catch { return claudeDir; } })()])];
  const snapRe = new RegExp(`(^|[^A-Za-z0-9])${sessionId}($|[^A-Za-z0-9-])`);
  // null = not under claudeDir; true/false = session-keyed or not
  const keyedState = abs => {
    const base = claudeBases.find(b => within(abs, b));
    if (!base) return null;
    const s = path.relative(base, abs).split(path.sep);
    const [top, a, b] = s;
    if (top === "projects" && s.length >= 3) {
      if (b === sessionId) return true;
      if (b === sessionId + ".jsonl" && s.length === 3) return true;
      if (b === "memory" && s.length === 4) return s[3].endsWith(".md") && s[3] !== "MEMORY.md" && memoryClaimedBy(abs, sessionId);
      return false;
    }
    if ((top === "file-history" || top === "session-env") && s.length >= 2) return a === sessionId;
    if (top === "shell-snapshots" && s.length === 2) return snapRe.test(a);
    if (top === "memory" && s.length === 2) return a.endsWith(".md") && a !== "MEMORY.md" && memoryClaimedBy(abs, sessionId);
    return false;
  };

  const tiedSessions = p => {
    const needle = normText(p);
    return others.filter(o => o.text.includes(needle)).map(o => o.id);
  };

  const items = new Map();
  const refused = new Map();
  const consider = (rawPath, { fromBash = false, isOwnTranscript = false, keyed = false, cand = null } = {}) => {
    const safe = checkPath(rawPath, check);
    if (!safe.ok) {
      if (safe.reason !== "does not exist") refused.set(String(rawPath), safe.reason);
      return;
    }
    const k = keyedState(safe.resolved);
    if (k === false) { refused.set(String(rawPath), NOT_KEYED); return; }
    if (fromBash && safe.isDir) { refused.set(rawPath, "directory named only inside a shell command"); return; }
    const sessionKeyed = keyed || k === true;
    // a folder named by Write/Edit is only acceptable when it is this session's own keyed data
    if (cand && !fromBash && safe.isDir && !sessionKeyed) { refused.set(String(rawPath), "directory named by a write tool"); return; }
    if (items.has(safe.resolved.toLowerCase())) return;
    const sharedWith = isOwnTranscript ? [] : tiedSessions(safe.resolved);
    const bashOnly = fromBash && !keyed;
    if (bashOnly) sharedWith.push(BASH_ONLY);
    // R26: exclusive needs proof of creation: a successful Write whose file was born after the session began.
    let unproven = false;
    if (cand && !fromBash && !sessionKeyed) {
      let born = NaN; try { born = fs.statSync(safe.resolved).birthtimeMs; } catch { /* unknown => unproven */ }
      if (!cand.created && !cand.edited) { sharedWith.push(UNCONFIRMED); unproven = true; }
      else if (!cand.created || startMs === null || !(born >= startMs)) { sharedWith.push(EXISTED_BEFORE); unproven = true; }
    }
    const c = classify({ safe, isLive: isLive && sessionKeyed, sharedWith });
    items.set(safe.resolved.toLowerCase(), {
      id: idOf(safe.resolved), path: safe.resolved, kind: safe.isDir ? "dir" : "file",
      bytes: dirSize(safe.resolved), drive: path.parse(safe.resolved).root, group: c.group,
      reason: c.group === "shared" && bashOnly ? BASH_ONLY_REASON : c.group === "shared" && unproven && sharedWith.every(s => s.startsWith("(")) ? UNPROVEN_REASON : c.reason, sharedWith,
    });
  };

  consider(own.file, { isOwnTranscript: true, keyed: true });
  for (const d of [path.join(projectsDir, own.folder, sessionId), path.join(claudeDir, "file-history", sessionId),
    path.join(claudeDir, "session-env", sessionId), path.join(scratch, own.folder, sessionId)]) consider(d, { keyed: true });
  for (const n of listNames(path.join(claudeDir, "shell-snapshots"))) {
    if (snapRe.test(n)) consider(path.join(claudeDir, "shell-snapshots", n), { keyed: true });
  }
  for (const dir of [path.join(claudeDir, "memory"), ...folders.map(f => path.join(projectsDir, f, "memory"))]) {
    for (const n of listNames(dir)) {
      if (!n.endsWith(".md") || n === "MEMORY.md") continue;
      const f = path.join(dir, n);
      if (memoryClaimedBy(f, sessionId)) consider(f, { keyed: true });
    }
  }
  for (const c of extractCandidates(ownText)) if (c.writes) consider(c.path, { fromBash: c.fromBash, cand: c });

  // An item inside another listed directory is covered by it (no double counting). The directory
  // takes on the stricter group of anything it swallows so a shared/live child is never hidden.
  const all = [...items.values()];
  const dirs = all.filter(i => i.kind === "dir");
  const list = all.filter(it => !dirs.some(d => d !== it && within(it.path, d.path)));
  for (const it of all) {
    for (const d of dirs) {
      if (d === it || !within(it.path, d.path)) continue;
      if (RANK[it.group] > RANK[d.group]) { d.group = it.group; d.reason = `contains ${path.basename(it.path)}: ${it.reason}`; }
      for (const s of it.sharedWith) if (!d.sharedWith.includes(s)) d.sharedWith.push(s);
    }
  }
  if (new Set(all.map(i => i.id)).size !== all.length) throw new Error("item id collision; refusing to scan");
  list.sort((a, b) => b.bytes - a.bytes);
  const drives = {};
  for (const d of new Set(list.map(i => i.drive))) {
    const s = fs.statfsSync(d);
    drives[d] = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  }
  return {
    sessionId, sessionName: (running.find(r => r.sessionId === sessionId) || {}).name ?? null,
    lastActive: (() => { try { return fs.statSync(own.file).mtime.toISOString(); } catch { return null; } })(),
    claudeDir, allowedRoots, protectedPaths, livePaths, items: list,
    protected: [...refused].map(([p, reason]) => ({ path: p, reason })),
    offDisk: extractOffDisk(ownText), drives,
  };
}
