// Release gate A (R26) + round 2 (R28): exclusive needs proof of CREATION, not just a successful write.
// Claude Code replaces files atomically, so a new birth time proves nothing: the result record's
// toolUseResult.type ("create" vs "update") and its text are the evidence. Self-contained temp environments.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSession, TOOL_PROTECTED } from "../scan.mjs";
import { extractCandidates, firstTimestampMs } from "../lib/transcript.mjs";

const toolDir = path.dirname(TOOL_PROTECTED[0]);
// result kinds, with the exact shapes seen in real transcripts:
//   create  : text "File created successfully at: P (...)", toolUseResult {type:"create", filePath, content}
//   update  : text "The file P has been updated successfully. (...)", toolUseResult {type:"update", filePath, content}
//   edit    : Edit tool: text "The file P has been updated successfully.", toolUseResult without a "type"
//   error / none / weird (unknown type) / conflict (type says create, text says updated) / otherpath
function lineFor(id, name, p, kind, ts) {
  const out = [JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id, name, input: { file_path: p } }] } })];
  if (kind === "none") return out;
  const res = (content, extra = {}, is_error) => JSON.stringify({ type: "user", timestamp: ts,
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, ...(is_error ? { is_error: true } : {}) }] }, ...extra });
  const created = `File created successfully at: ${p} (file state is current in your context — no need to Read it back)`;
  const updated = `The file ${p} has been updated successfully. (file state is current in your context — no need to Read it back)`;
  const rec = {
    create: res(created, { toolUseResult: { type: "create", filePath: p, content: "x" } }),
    update: res(updated, { toolUseResult: { type: "update", filePath: p, content: "x" } }),
    edit: res(updated, { toolUseResult: { filePath: p, oldString: "a", newString: "b" } }),
    error: res("Permission denied", {}, true),
    weird: res(created, { toolUseResult: { type: "something-new", filePath: p } }),
    conflict: res(updated, { toolUseResult: { type: "create", filePath: p } }),
    otherpath: res(created, { toolUseResult: { type: "create", filePath: p + ".other" } }),
    bare: res("done"),
  }[kind];
  out.push(rec);
  return out;
}
function proofEnv(fn, { startOffsetMs = -60000 } = {}) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "proof-"));
  try {
    const work = path.join(t, "work"); fs.mkdirSync(work, { recursive: true });
    const proj = path.join(t, "claude", "projects", "P"); fs.mkdirSync(proj, { recursive: true });
    const ts = new Date(Date.now() + startOffsetMs).toISOString();
    let n = 0;
    const lines = [JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: "hi" } })];
    const use = (name, p, kind) => lines.push(...lineFor(`toolu_${++n}`, name, p, kind, ts));
    const scan = () => {
      fs.writeFileSync(path.join(proj, "s1.jsonl"), lines.join("\n") + "\n");
      return scanSession({ claudeDir: path.join(t, "claude"), sessionId: "s1", roots: [work, path.dirname(toolDir)], tmpDir: path.join(t, "tmp") });
    };
    return fn({ work, use, scan, t });
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}
const itemOf = (m, p) => m.items.find(i => i.path.toLowerCase() === p.toLowerCase());
const mk = (work, name) => { const f = path.join(work, name); fs.writeFileSync(f, "x"); return f; };
const BEFORE = "(existed before this session)", UNCONF = "(write not confirmed)";

test("a Write whose result says create, on a file born after the session start, is exclusive", () => proofEnv(({ work, use, scan }) => {
  const f = mk(work, "new.txt"); use("Write", f, "create");
  const i = itemOf(scan(), f);
  assert.equal(i.group, "exclusive"); assert.deepEqual(i.sharedWith, []);
}));
test("a Write that OVERWROTE an existing file (result type update, new birth time from the atomic replace) is shared", () => proofEnv(({ work, use, scan }) => {
  const f = mk(work, "overwritten.txt");   // born after the session start, exactly like an atomic replace
  use("Write", f, "update");
  const i = itemOf(scan(), f);
  assert.equal(i.group, "shared"); assert.deepEqual(i.sharedWith, [BEFORE]);
}));
test("Edit then Write is shared (the file existed when the Edit ran)", () => proofEnv(({ work, use, scan }) => {
  const a = mk(work, "edit-then-update.txt"), b = mk(work, "edit-then-create.txt");
  use("Edit", a, "edit"); use("Write", a, "update");
  use("Edit", b, "edit"); use("Write", b, "create");      // even a later "create" does not undo what the Edit proved
  const m = scan();
  for (const f of [a, b]) { const i = itemOf(m, f); assert.equal(i.group, "shared", f); assert.deepEqual(i.sharedWith, [BEFORE]); }
}));
test("create then Edit stays exclusive", () => proofEnv(({ work, use, scan }) => {
  const f = mk(work, "create-then-edit.txt");
  use("Write", f, "create"); use("Edit", f, "edit"); use("Edit", f, "edit");
  assert.equal(itemOf(scan(), f).group, "exclusive");
}));
test("unknown or inconsistent result shapes fail closed (shared, never exclusive)", () => proofEnv(({ work, use, scan }) => {
  const kinds = ["weird", "conflict", "otherpath", "bare"];
  const files = kinds.map(k => { const f = mk(work, `${k}.txt`); use("Write", f, k); return f; });
  const m = scan();
  for (const f of files) { const i = itemOf(m, f); assert.equal(i.group, "shared", f); assert.deepEqual(i.sharedWith, [UNCONF], f); }
}));
test("a denied Write, a Write with no result, and a failed Edit are never exclusive", () => proofEnv(({ work, use, scan }) => {
  const a = mk(work, "denied.txt"), b = mk(work, "noresult.txt"), c = mk(work, "failedit.txt");
  use("Write", a, "error"); use("Write", b, "none"); use("Edit", c, "error");
  const m = scan();
  for (const f of [a, b, c]) { const i = itemOf(m, f); assert.equal(i.group, "shared", f); assert.deepEqual(i.sharedWith, [UNCONF]); }
}));
test("a successful Edit of an existing file is shared, not exclusive", () => proofEnv(({ work, use, scan }) => {
  const f = mk(work, "old.txt"); use("Edit", f, "edit");
  const i = itemOf(scan(), f);
  assert.equal(i.group, "shared"); assert.deepEqual(i.sharedWith, [BEFORE]);
}));
test("second guard: a 'create' for a file older than the session start is still shared", () => proofEnv(({ work, use, scan }) => {
  const f = mk(work, "older.txt"); use("Write", f, "create");
  const i = itemOf(scan(), f);
  assert.equal(i.group, "shared"); assert.deepEqual(i.sharedWith, [BEFORE]);
}, { startOffsetMs: 3600000 }));
test("a Write/Edit candidate that is now a directory is refused", () => proofEnv(({ work, use, scan }) => {
  const d = path.join(work, "swapped"); fs.mkdirSync(d); fs.writeFileSync(path.join(d, "inner.txt"), "x");
  use("Write", d, "create");
  const m = scan();
  assert.equal(itemOf(m, d), undefined);
  assert.ok(m.protected.some(p => p.path === d && /directory named by a write tool/.test(p.reason)));
}));
test("the tool's own code, page, lib, vendor and out folder are protected even when a transcript wrote them", () => proofEnv(({ use, scan }) => {
  const targets = ["run.mjs", "server.mjs", "cleanup.html", path.join("lib", "safepath.mjs"), path.join("out", "nuke-audit.log")].map(p => path.join(toolDir, p));
  for (const f of targets) use("Write", f, "create");
  const m = scan();
  for (const f of targets) assert.equal(itemOf(m, f), undefined, f);
  assert.ok(TOOL_PROTECTED.some(p => p.endsWith("out")) && m.protectedPaths.some(p => p.endsWith(path.sep + "lib")));
}));

test("transcript: realistic create and update records (shapes copied from real transcripts) are told apart", () => {
  const P = "E:\\Claude\\ollama-search\\chat.mjs", Q = "E:\\Claude\\nuke\\index.html";
  const real = [
    '{"type":"assistant","timestamp":"2026-10-15T04:48:20.000Z","message":{"content":[{"type":"tool_use","id":"toolu_c","name":"Write","input":{"file_path":"E:\\\\Claude\\\\ollama-search\\\\chat.mjs","content":"x"}}]}}',
    '{"parentUuid":"173c","type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_c","type":"tool_result","content":"File created successfully at: E:\\\\Claude\\\\ollama-search\\\\chat.mjs (file state is current in your context — no need to Read it back)"}]},"timestamp":"2026-10-15T04:48:28.531Z","toolUseResult":{"type":"create","filePath":"E:\\\\Claude\\\\ollama-search\\\\chat.mjs","content":"// Chat"}}',
    '{"type":"assistant","timestamp":"2026-10-14T20:57:50.000Z","message":{"content":[{"type":"tool_use","id":"toolu_u","name":"Write","input":{"file_path":"E:\\\\Claude\\\\nuke\\\\index.html","content":"x"}}]}}',
    '{"parentUuid":"ca40","type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_u","type":"tool_result","content":"The file E:\\\\Claude\\\\nuke\\\\index.html has been updated successfully. (file state is current in your context — no need to Read it back)"}]},"timestamp":"2026-10-14T20:57:58.976Z","toolUseResult":{"type":"update","filePath":"E:\\\\Claude\\\\nuke\\\\index.html","content":"<!doctype html>"}}',
  ].join("\n");
  const out = extractCandidates(real);
  const c = out.find(x => x.path === P), u = out.find(x => x.path === Q);
  assert.deepEqual([c.created, c.edited], [true, false]);
  assert.deepEqual([u.created, u.edited], [false, true]);
});
test("transcript: created/edited need a non-error result for that very call; firstTimestampMs reads the session start", () => {
  const ts = "2026-01-01T00:00:00.000Z";
  const out = extractCandidates([
    ...lineFor("1", "Write", "E:\\a\\ok.txt", "create", ts), ...lineFor("2", "Write", "E:\\a\\bad.txt", "error", ts),
    ...lineFor("3", "Edit", "E:\\a\\ed.txt", "edit", ts), ...lineFor("4", "Write", "E:\\a\\none.txt", "none", ts),
    ...lineFor("5", "Write", "E:\\a\\wrongid.txt", "none", ts), JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "99", content: "File created successfully at: x" }] }, toolUseResult: { type: "create" } }),
  ].join("\n"));
  const f = n => out.find(c => c.path.endsWith(n));
  assert.deepEqual([f("ok.txt").created, f("ok.txt").edited], [true, false]);
  assert.deepEqual([f("bad.txt").created, f("bad.txt").edited], [false, false]);
  assert.deepEqual([f("ed.txt").created, f("ed.txt").edited], [false, true]);
  assert.equal(f("none.txt").created, false); assert.equal(f("wrongid.txt").created, false);
  assert.equal(firstTimestampMs(lineFor("1", "Read", "x", "none", ts)[0]), Date.parse(ts));
  assert.equal(firstTimestampMs("not json\n{}"), null);
});
