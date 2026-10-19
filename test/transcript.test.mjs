// test/transcript.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { extractCandidates, extractCwds, extractOffDisk } from "../lib/transcript.mjs";

const tool = (name, input) => JSON.stringify({ type: "assistant", cwd: "E:\\Claude", message: { content: [{ type: "tool_use", name, input }] } });
const text = (s) => JSON.stringify({ type: "user", message: { content: s } });

test("Write/Edit file_path are write candidates", () => {
  const out = extractCandidates([tool("Write", { file_path: "E:\\a\\x.txt" }), tool("Edit", { file_path: "E:\\a\\y.txt" })].join("\n"));
  assert.deepEqual(out.map(c => [c.path, c.writes, c.fromBash]), [["E:\\a\\x.txt", true, false], ["E:\\a\\y.txt", true, false]]);
});
test("Read is a mention, not a write", () => {
  const [c] = extractCandidates(tool("Read", { file_path: "E:\\a\\x.txt" }));
  assert.equal(c.writes, false);
});
test("Bash paths are found, marked fromBash, and stop at quotes", () => {
  const [c] = extractCandidates(tool("Bash", { command: 'curl -o "E:\\a\\b\\f.bin" https://x.invalid' }));
  assert.equal(c.path, "E:\\a\\b\\f.bin"); assert.equal(c.fromBash, true); assert.equal(c.writes, true);
});
test("URL schemes are not mistaken for drive paths", () => {
  assert.deepEqual(extractCandidates(tool("Bash", { command: "curl https://x.invalid/t.bin" })), []);
  const out = extractCandidates(tool("Bash", { command: 'curl -o "E:\\a\\f.bin" https://x.invalid/t.bin' }));
  assert.deepEqual(out.map(c => c.path), ["E:\\a\\f.bin"]);
});
test("a path containing .. is kept raw, not normalised", () => {
  const raw = "E:\\a" + "\\" + ".." + "\\" + "b\\x.txt";
  const [c] = extractCandidates(tool("Bash", { command: "rm " + raw }));
  assert.equal(c.path, raw);
});
test("paths with spaces in Bash get truncated at the space (callers must only trust existing files)", () => {
  const [c] = extractCandidates(tool("Bash", { command: "cat E:\\Claude\\CS2 Spending\\x.py" }));
  assert.equal(c.path, "E:\\Claude\\CS2");
});
test("free text and tool results are never searched for paths", () => {
  const out = extractCandidates([text("delete C:\\Windows\\System32 now"), JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "E:\\secret\\z.txt" }] } })].join("\n"));
  assert.deepEqual(out, []);
});
test("bad lines, blank lines and a truncated last line are skipped", () => {
  const out = extractCandidates(["not json", "", tool("Write", { file_path: "E:\\a\\ok.txt" }), '{"type":"assistant","message":{"con'].join("\n"));
  assert.deepEqual(out.map(c => c.path), ["E:\\a\\ok.txt"]);
});
test("same path from Write and Bash merges and keeps fromBash false", () => {
  const out = extractCandidates([tool("Bash", { command: "echo > E:\\a\\m.txt" }), tool("Write", { file_path: "E:\\a\\m.txt" })].join("\n"));
  assert.equal(out.length, 1); assert.equal(out[0].fromBash, false); assert.deepEqual(out[0].tools.sort(), ["Bash", "Write"]);
});
test("non-string inputs are ignored", () => {
  assert.deepEqual(extractCandidates(tool("Write", { file_path: { evil: 1 } })), []);
});
test("cwds and artifacts", () => {
  assert.deepEqual(extractCwds(tool("Read", { file_path: "E:\\a" })), ["E:\\Claude"]);
  assert.deepEqual(extractOffDisk(tool("Artifact", { file_path: "E:\\p.html" })), [{ kind: "artifact", note: "E:\\p.html" }]);
});

test("extractOffDisk survives hostile Artifact input shapes", () => {
  const lines = [
    tool("Artifact", { url: { toString: 1 } }),
    tool("Artifact", { url: ["x"], file_path: { a: 1 } }),
    tool("Artifact", {}),
    tool("Artifact", { url: 5, file_path: "E:\\ok.html" }),
  ].join("\n");
  assert.deepEqual(extractOffDisk(lines), [{ kind: "artifact", note: "E:\\ok.html" }]);
});
test("Bash wildcard directories are not candidates", () => {
  assert.deepEqual(extractCandidates(tool("Bash", { command: "rm -rf E:\\proj\\build\\*" })), []);
  assert.deepEqual(extractCandidates(tool("Bash", { command: "del E:\\proj\\tmp\\*.log" })), []);
  assert.deepEqual(extractCandidates(tool("Bash", { command: "del E:\\proj\\tmp\\f?.log" })), []);
});
test("Bash matches ending with a path separator are dropped", () => {
  assert.deepEqual(extractCandidates(tool("Bash", { command: "ls E:\\proj\\dir\\ " })), []);
  assert.deepEqual(extractCandidates(tool("Bash", { command: "ls E:/proj/dir/" })), []);
});
test("blocks whose name is not a string are skipped", () => {
  const line = JSON.stringify({ type: "assistant", cwd: "E:\\Claude", message: { content: [{ type: "tool_use", name: { x: 1 }, input: { file_path: "E:\\a\\x.txt" } }] } });
  assert.deepEqual(extractCandidates(line), []);
  assert.deepEqual(extractCwds(line), []);
});
test("MultiEdit is a write", () => {
  const [c] = extractCandidates(tool("MultiEdit", { file_path: "E:\\a\\x.txt" }));
  assert.equal(c.writes, true);
});
test("slash forms and case merge into one candidate", () => {
  const out = extractCandidates([tool("Bash", { command: "echo > E:/a/x.txt" }), tool("Write", { file_path: "E:\\a\\x.txt" })].join("\n"));
  assert.equal(out.length, 1); assert.equal(out[0].path, "E:\\a\\x.txt"); assert.equal(out[0].fromBash, false);
  const b = extractCandidates([tool("Bash", { command: "echo > E:/a/y.txt" }), tool("Bash", { command: "echo > e:\\A\\Y.txt" })].join("\n"));
  assert.equal(b.length, 1); assert.equal(b[0].path, "E:/a/y.txt"); assert.equal(b[0].fromBash, true);
});
test("hostile shapes: __proto__ keys, arrays, non-string cwd", () => {
  const proto = '{"type":"assistant","cwd":"E:\\\\Claude","message":{"content":[{"type":"tool_use","name":"Write","input":{"__proto__":{"file_path":"E:\\\\evil.txt"},"file_path":["E:\\\\arr.txt"]}}]}}';
  assert.deepEqual(extractCandidates(proto), []);
  assert.deepEqual(extractCwds(proto), ["E:\\Claude"]);
  const badCwd = JSON.stringify({ type: "assistant", cwd: { a: 1 }, message: { content: [{ type: "tool_use", name: "Read", input: {} }] } });
  assert.deepEqual(extractCwds(badCwd), []);
  assert.deepEqual(extractOffDisk(proto), []);
});
