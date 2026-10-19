// test/scan.test.mjs
import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { scanSession } from "../scan.mjs";

const sb = path.resolve("fixture", "sandbox");
const rel = p => path.relative(sb, p).split(path.sep).join("/");
let map;
before(() => {
  execFileSync(process.execPath, ["fixture/make-fixture.mjs"], { stdio: "ignore" });
  map = scanSession({
    claudeDir: path.join(sb, "claude"), sessionId: "dummy-session-A",
    roots: [path.join(sb, "work"), path.join(sb, "claude")], tmpDir: path.join(sb, "tmp"),
  });
});
const by = g => map.items.filter(i => i.group === g).map(i => rel(i.path)).sort();

test("exclusive items are exactly what only session A touched", () => {
  assert.deepEqual(by("exclusive"), [
    "claude/file-history/dummy-session-A", "claude/memory/note-from-A.md",
    "claude/projects/SBX-project/dummy-session-A", "claude/projects/SBX-project/dummy-session-A.jsonl",
    "claude/session-env/dummy-session-A", "claude/shell-snapshots/snapshot-dummy-session-A.sh",
    "claude/projects/SBX-project/memory/note-proj-A.md", "work/downloads/export-A.zip", "work/projA/assets/audio.bin",
    "work/projA/notes.txt", "work/projA/src/main.js",
  ].sort());
});
test("files session B also used, or only named in a shell command, are shared", () => {
  assert.deepEqual(by("shared"), [
    "work/projA/assets/big-texture.bin", "work/projA/bash-type.txt", "work/projA/run-me.py",
    "work/shared/config.json", "work/shared/dataset.bin",
    "work/ties/escaped.txt", "work/ties/gitbash.txt", "work/ties/mixed.txt", "work/ties/subagent.txt"]);
  const get = r => map.items.find(i => rel(i.path) === r);
  for (const r of ["work/shared/dataset.bin", "work/ties/escaped.txt", "work/ties/gitbash.txt",
    "work/ties/mixed.txt", "work/ties/subagent.txt"]) assert.deepEqual(get(r).sharedWith, ["dummy-session-B"], r);
  // A only Edit-ed config.json (R26: an Edit proves the file existed, not that A created it)
  assert.deepEqual(get("work/shared/config.json").sharedWith, ["dummy-session-B", "(existed before this session)"]);
});
test("a file only named in a Bash command is never exclusive", () => {
  for (const r of ["work/projA/bash-type.txt", "work/projA/run-me.py", "work/projA/assets/big-texture.bin"]) {
    const i = map.items.find(x => rel(x.path) === r);
    assert.equal(i.group, "shared", r);
    assert.deepEqual(i.sharedWith, ["(shell command only)"]);
    assert.equal(i.reason, "named only in a shell command; not proven written by this session");
  }
  assert.ok(!by("exclusive").some(r => /bash-type|run-me|big-texture/.test(r)));
});
test("claude data not keyed to the session is protected, never an item", () => {
  const all = map.items.map(i => rel(i.path));
  assert.ok(!all.some(p => p.includes("claude/agents") || p.includes("OTHER-folder")));
  for (const end of ["agents/x.md", "OTHER-folder/memory/MEMORY.md"]) {
    assert.ok(map.protected.some(p => p.path.split(path.sep).join("/").endsWith(end)), end);
  }
  assert.ok(map.protected.some(p => p.reason === "Claude data not keyed to this session"));
});
test("session ids and memory notes must match exactly", () => {
  const all = map.items.map(i => rel(i.path));
  assert.ok(!all.some(p => p.includes("snapshot-dummy-session-AB") || p.includes("note-AB") || p.includes("note-body-quote")));
  assert.ok(all.includes("claude/projects/SBX-project/memory/note-proj-A.md"));
});
test("an item inside another listed directory is folded into it", () => {
  const dirs = map.items.filter(i => i.kind === "dir");
  for (const it of map.items) for (const d of dirs) {
    if (d !== it) assert.ok(path.relative(d.path, it.path).startsWith(".."), `${it.path} inside ${d.path}`);
  }
  assert.ok(!map.items.some(i => i.path.endsWith("custom-title.json")));
});
test("nothing dangerous is ever an item", () => {
  const all = map.items.map(i => rel(i.path));
  for (const bad of ["claude/settings.json", "claude/memory/MEMORY.md", "claude/projects/SBX-project/dummy-session-B.jsonl",
    "claude/projects/SBX-project/dummy-session-LIVE.jsonl"]) assert.ok(!all.includes(bad), bad);
  assert.ok(!all.some(p => p.includes("protected-victim") || p.includes("projB") || p.includes("link-to-precious")));
  assert.ok(map.items.every(i => i.group !== "protected"));
});
test("hostile candidates are reported as protected with a reason", () => {
  const reasons = map.protected.map(p => p.reason).join("|");
  assert.match(reasons, /parent segment/);
  assert.match(reasons, /drive root/);
  assert.match(reasons, /home folder/);
  assert.match(reasons, /link or alias/);
  assert.ok(map.protected.some(p => p.path.endsWith("settings.json")));
});
test("the untrusted instruction text in the transcript produced no candidate", () => {
  assert.ok(![...map.items, ...map.protected].some(x => /system32/i.test(x.path)));
});
test("sizes and drives are filled in; items sorted largest first", () => {
  assert.ok(map.items.every(i => i.bytes > 0 && i.drive));
  const sizes = map.items.map(i => i.bytes);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
  const d = Object.values(map.drives)[0];
  assert.ok(d.total > d.free && d.free > 0);
});
test("a session with a .live marker is live even without targetIsLive; its session data is live, its project files are not", () => {
  const args = { claudeDir: path.join(sb, "claude"), sessionId: "dummy-session-LIVE",
    roots: [path.join(sb, "work"), path.join(sb, "claude")], tmpDir: path.join(sb, "tmp") };
  for (const m of [scanSession(args), scanSession({ ...args, targetIsLive: true })]) {
    const g = r => (m.items.find(i => rel(i.path) === r) || {}).group;
    assert.equal(g("claude/projects/SBX-project/dummy-session-LIVE.jsonl"), "live");
    assert.equal(g("claude/session-env/dummy-session-LIVE"), "live");
    assert.equal(g("claude/file-history/dummy-session-LIVE"), "live");
    assert.equal(g("claude/shell-snapshots/snapshot-dummy-session-LIVE.sh"), "live");
    assert.equal(g("work/live-proj/out.txt"), "exclusive");
    assert.equal(m.items.find(i => rel(i.path) === "claude/session-env/dummy-session-LIVE").reason, "this session is still running");
  }
});
test("session ids are validated", () => {
  for (const id of ["..", "a/b", "", "a\b", "x".repeat(65), undefined]) {
    assert.throws(() => scanSession({ claudeDir: path.join(sb, "claude"), sessionId: id }), /invalid session id/, String(id));
  }
});
test("unreadable directories fail the scan instead of reading as empty", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "scan-err-"));
  try {
    fs.mkdirSync(path.join(t, "claude")); fs.writeFileSync(path.join(t, "claude", "projects"), "i am a file");
    // ENOTDIR is "nothing there"
    assert.throws(() => scanSession({ claudeDir: path.join(t, "claude"), sessionId: "s1" }), /no transcript found/);
    // any other readdir failure must throw its own error, not "no transcript found"
    const real = fs.readdirSync;
    const boom = Object.assign(new Error("denied"), { code: "EACCES" });
    fs.readdirSync = (d, ...r) => { if (String(d).endsWith("projects")) throw boom; return real(d, ...r); };
    try { assert.throws(() => scanSession({ claudeDir: path.join(t, "claude"), sessionId: "s1" }), /denied/); }
    finally { fs.readdirSync = real; }
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
test("the home folder never becomes an allowed root via a cwd", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "scan-home-"));
  try {
    const f = path.join(t, "claude", "projects", "F"); fs.mkdirSync(f, { recursive: true });
    const tu = cwd => JSON.stringify({ cwd, message: { content: [{ type: "tool_use", name: "Write", input: { file_path: path.join(cwd, "x.txt") } }] } });
    const lines = [os.homedir(), path.dirname(os.homedir()), path.parse(os.homedir()).root, "relative/dir", path.join(t, "ok")].map(tu);
    fs.writeFileSync(path.join(f, "s1.jsonl"), lines.join("\n") + "\n");
    const m = scanSession({ claudeDir: path.join(t, "claude"), sessionId: "s1", tmpDir: path.join(t, "tmp") });
    const low = m.allowedRoots.map(r => r.toLowerCase());
    for (const bad of [os.homedir(), path.dirname(os.homedir()), path.parse(os.homedir()).root]) assert.ok(!low.includes(path.resolve(bad).toLowerCase()), bad);
    assert.ok(!low.some(r => r.endsWith("relative" + path.sep + "dir")));
    assert.ok(low.includes(path.join(t, "ok").toLowerCase()));
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
test("an unreadable memory entry is skipped, not fatal", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "scan-mem-"));
  try {
    const f = path.join(t, "claude", "projects", "F"); fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, "s1.jsonl"), JSON.stringify({ message: { content: [] } }) + "\n");
    fs.mkdirSync(path.join(t, "claude", "memory", "x.md"), { recursive: true });
    const m = scanSession({ claudeDir: path.join(t, "claude"), sessionId: "s1", roots: [path.join(t, "claude")], tmpDir: path.join(t, "tmp") });
    assert.ok(!m.items.some(i => i.path.endsWith("x.md")));
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
test("cleaning the live session lists its transcript as live, never as exclusive", () => {
  const m = scanSession({ claudeDir: path.join(sb, "claude"), sessionId: "dummy-session-LIVE", targetIsLive: true,
    roots: [path.join(sb, "work"), path.join(sb, "claude")], tmpDir: path.join(sb, "tmp") });
  const t = m.items.find(i => i.path.endsWith("dummy-session-LIVE.jsonl"));
  assert.equal(t.group, "live");
});
test("unknown session fails with a clear error", () => {
  assert.throws(() => scanSession({ claudeDir: path.join(sb, "claude"), sessionId: "nope" }), /no transcript found/);
});
test("a transcript over the size limit is refused", () => {
  const big = path.join(sb, "claude", "projects", "SBX-project", "dummy-session-HUGE.jsonl");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 201 * 1024 * 1024);   // sparse file; costs no real disk
  try {
    assert.throws(() => scanSession({ claudeDir: path.join(sb, "claude"), sessionId: "dummy-session-A",
      roots: [path.join(sb, "work"), path.join(sb, "claude")] }), /too large/);
  } finally { fs.rmSync(big, { force: true }); }
});

test("a candidate inside a junction is protected and never an item", () => {
  const through = map.protected.find(p => p.path.split(path.sep).join("/").endsWith("link-to-precious/precious.txt"));
  assert.ok(through, "junction candidate must be listed as protected");
  assert.match(through.reason, /link or alias/);
  assert.ok(!map.items.some(i => i.path.split(path.sep).join("/").includes("link-to-precious")));
});
test("scanSession never creates, modifies or deletes anything under the sandbox", () => {
  const snap = () => {
    const out = [];
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isSymbolicLink()) { out.push(`L ${f}`); continue; }
        if (e.isDirectory()) { out.push(`D ${f}`); if (!f.endsWith("link-to-precious")) walk(f); }
        else { const s = fs.statSync(f); out.push(`F ${f} ${s.size} ${s.mtimeMs}`); }
      }
    };
    walk(sb); return out.sort();
  };
  const before = snap();
  scanSession({ claudeDir: path.join(sb, "claude"), sessionId: "dummy-session-A",
    roots: [path.join(sb, "work"), path.join(sb, "claude")], tmpDir: path.join(sb, "tmp") });
  scanSession({ claudeDir: path.join(sb, "claude"), sessionId: "dummy-session-LIVE", targetIsLive: true,
    roots: [path.join(sb, "work"), path.join(sb, "claude")], tmpDir: path.join(sb, "tmp") });
  assert.deepEqual(snap(), before);
});

test("a cwd that is a junction alias of home (or of a parent of home) is dropped from the default roots", () => {
  const T = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "scanhome-")));
  const home = path.join(T, "home"), proj = path.join(home, "proj"); fs.mkdirSync(proj, { recursive: true });
  const alias = path.join(T, "alias"), up = path.join(T, "up");
  fs.symlinkSync(home, alias, "junction"); fs.symlinkSync(T, up, "junction");
  try {
    const claude = path.join(T, "claude"), pdir = path.join(claude, "projects", "P"); fs.mkdirSync(pdir, { recursive: true });
    const line = cwd => JSON.stringify({ cwd, message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(proj, "a.txt") } }] } });
    fs.writeFileSync(path.join(pdir, "sess1.jsonl"), [alias, up, home, proj, path.join(alias, "proj")].map(line).join("\n") + "\n");
    const m = scanSession({ claudeDir: claude, sessionId: "sess1", tmpDir: path.join(T, "tmp"), home });
    const roots = m.allowedRoots.map(r => r.toLowerCase());
    for (const bad of [alias, up, home]) assert.ok(!roots.includes(path.resolve(bad).toLowerCase()), bad);
    assert.ok(roots.includes(proj.toLowerCase()), "a real project folder under home stays a root");
  } finally {
    for (const l of [alias, up]) { try { fs.unlinkSync(l); } catch { try { fs.rmdirSync(l); } catch { /* gone */ } } }
    fs.rmSync(T, { recursive: true, force: true });
  }
});
