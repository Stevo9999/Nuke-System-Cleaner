// test/start-run.test.mjs: startFrozenRun, the library entry (selection, lock and audit live inside runDir)
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSelection, startFrozenRun, UsageError } from "../run.mjs";
import net from "node:net";
import { within } from "../lib/safepath.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfr-"));
const map = {
  sessionId: "S", allowedRoots: [root], protectedPaths: [path.join(root, "prot")], livePaths: [path.join(root, "live")],
  items: [{ id: "aa", path: path.join(root, "a.txt"), kind: "file", bytes: 1, drive: "C:\\", group: "exclusive", reason: "r", sharedWith: [] }],
};
const sel = () => buildSelection(map, ["aa"]);
const made = [root];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "sfr-run-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const fake = seen => o => { Object.assign(seen, o); return { runId: "r1", listen: async () => ({ url: "http://127.0.0.1:4321/?t=x" }), close() {} }; };

test("startFrozenRun writes selection and lock inside runDir and passes all trusted options (no auditFile unless given)", async () => {
  const runDir = tmp(), seen = {}, s = sel();
  const r = await startFrozenRun(s, { runDir, scanStartMs: Date.now(), createServer: fake(seen) });
  assert.equal(seen.expectedSha256, s.sha256); assert.deepEqual(seen.allowedRoots, s.allowedRoots);
  assert.deepEqual(seen.protectedPaths, s.protectedPaths); assert.deepEqual(seen.livePaths, s.livePaths);
  assert.equal(seen.adminContents, false); assert.ok(within(seen.selectionFile, runDir)); assert.equal(seen.auditFile, undefined);
  assert.notDeepEqual(seen.protectedPaths, seen.livePaths);
  assert.equal(fs.readFileSync(path.join(runDir, "selection.json"), "utf8"), JSON.stringify(s));
  assert.ok(fs.existsSync(path.join(runDir, "nuke.lock")));
  assert.equal(r.sha256, s.sha256); assert.equal(r.runId, "r1"); assert.equal(r.url, "http://127.0.0.1:4321/?t=x");
});
test("startFrozenRun: adminContents is a strict boolean (default false); anything else throws before a server starts", async () => {
  for (const [v, want] of [[true, true], [false, false], [undefined, false]]) {
    const seen = {};
    await startFrozenRun(sel(), { runDir: tmp(), scanStartMs: Date.now(), createServer: fake(seen), adminContents: v });
    assert.equal(seen.adminContents, want, String(v));
  }
  for (const v of ["true", 1, {}, null]) {
    const seen = {};
    await assert.rejects(startFrozenRun(sel(), { runDir: tmp(), scanStartMs: Date.now(), createServer: fake(seen), adminContents: v }), /adminContents/, String(v));
    assert.deepEqual(seen, {});
  }
});
test("startFrozenRun: a held lock refuses and leaves the first selection.json untouched", async () => {
  const runDir = tmp(), first = sel();
  const live = net.createServer(); await new Promise(r => live.listen(0, "127.0.0.1", r));   // a real answering port
  const url = "http://127.0.0.1:" + live.address().port + "/?t=x";
  try {
  await startFrozenRun(first, { runDir, scanStartMs: Date.now(), createServer: () => ({ runId: "r", listen: async () => ({ url }), close() {} }), isAlive: () => true });
  const before = fs.readFileSync(path.join(runDir, "selection.json"), "utf8");
  const other = buildSelection({ ...map, sessionId: "T" }, ["aa"]);
  await assert.rejects(startFrozenRun(other, { runDir, scanStartMs: Date.now(), createServer: fake({}), isAlive: () => true }), UsageError);
  assert.equal(fs.readFileSync(path.join(runDir, "selection.json"), "utf8"), before);
  } finally { live.close(); }
});
test("startFrozenRun: serverOpts cannot override trusted options; auditFile outside runDir throws", async () => {
  const runDir = tmp(), seen = {}, s = sel();
  await startFrozenRun(s, { runDir, scanStartMs: Date.now(), createServer: fake(seen), serverOpts: { expectedSha256: "evil", allowedRoots: ["C:\\"], adminContents: true, selectionFile: "C:\\x", minGapMs: 5, auditFile: path.join(runDir, "a.log") } });
  assert.equal(seen.expectedSha256, s.sha256); assert.deepEqual(seen.allowedRoots, s.allowedRoots);
  assert.equal(seen.adminContents, false); assert.ok(within(seen.selectionFile, runDir));
  assert.equal(seen.minGapMs, 5); assert.equal(seen.auditFile, path.join(runDir, "a.log"));
  const d2 = tmp();
  await assert.rejects(startFrozenRun(sel(), { runDir: d2, scanStartMs: Date.now(), createServer: fake({}), serverOpts: { auditFile: path.join(os.tmpdir(), "elsewhere.log") } }), /auditFile/);
  assert.ok(!fs.existsSync(path.join(d2, "selection.json")));
});
test("launchNuke still behaves identically (delegates to startFrozenRun)", () => {
  const src = fs.readFileSync(new URL("../run.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function launchNuke"), src.indexOf("export async function startFrozenRun"));
  assert.match(body, /startFrozenRun\(sel, \{ runDir: outDir/);
  assert.doesNotMatch(body, /acquireLock|writeFileSync|createServer\(/);
});

const lockGone = d => !fs.existsSync(path.join(d, "nuke.lock"));
test("startFrozenRun: a createServer that throws releases the lock; a second run in the same runDir succeeds", async () => {
  const runDir = tmp();
  await assert.rejects(startFrozenRun(sel(), { runDir, scanStartMs: Date.now(), createServer: () => { throw new Error("boom"); } }), /boom/);
  assert.ok(lockGone(runDir));
  await startFrozenRun(sel(), { runDir, scanStartMs: Date.now(), createServer: fake({}) });
});
test("startFrozenRun: a listen() that rejects releases the lock; a second run succeeds", async () => {
  const runDir = tmp();
  await assert.rejects(startFrozenRun(sel(), { runDir, scanStartMs: Date.now(), createServer: () => ({ listen: async () => { throw new Error("nolisten"); }, close() {} }) }), /nolisten/);
  assert.ok(lockGone(runDir));
  await startFrozenRun(sel(), { runDir, scanStartMs: Date.now(), createServer: fake({}) });
});
test("startFrozenRun: a selection whose hash does not cover its contents is refused and the lock released", async () => {
  const runDir = tmp(), seen = {};
  await assert.rejects(startFrozenRun({ ...sel(), sha256: "0".repeat(64) }, { runDir, scanStartMs: Date.now(), createServer: fake(seen) }), /changed while writing/);
  assert.ok(lockGone(runDir)); assert.equal(seen.selectionFile, undefined);
});
test("startFrozenRun: a relative or missing runDir is refused", async () => {
  await assert.rejects(startFrozenRun(sel(), { runDir: "out", scanStartMs: Date.now(), createServer: fake({}) }), /absolute/);
  await assert.rejects(startFrozenRun(sel(), { scanStartMs: Date.now(), createServer: fake({}) }), /absolute/);
});
