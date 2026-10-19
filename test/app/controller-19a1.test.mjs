// Task 19A1 controller items: scan-start time travels to startRun, age + lock re-check before startRun,
// isDeleting(), and an audit line when the ritual window is closed before the press.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createController, readAuditLines } from "../../app/main/controller.mjs";
import { appDataPaths, ensureAppData } from "../../app/main/appdata.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { RESTORE_MESSAGES } from "../../lib/restore.mjs";

const SID = "S-1-5-21-11-22-33-1001";
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-c19-"));
  const la = path.join(root, "Local"), junk = path.join(la, "Temp");
  fs.mkdirSync(junk, { recursive: true });
  const f = n => { const p = path.join(junk, n); fs.writeFileSync(p, n.repeat(10)); return p; };
  const paths = appDataPaths({ LOCALAPPDATA: la });
  ensureAppData(paths);
  return { root, la, junk, f, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const vetted = p => makeFinding({ kind: "file", path: p, label: p, bytes: 10, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false, reason: "r", category: "Temporary files" });
const resultFor = (t, items) => ({ kind: "smart", target: null, items, allowedRoots: [t.junk], protectedPaths: [], notes: [], adminExtraBytes: null, partial: false });
function fakeUi(o = {}) {
  const ui = {
    phases: [], pickFile: async () => null, pickFolder: async () => null, sendProgress() {}, sendPhase: p => ui.phases.push(p), showResults() {}, closeResults() {},
    confirmPermanent: async () => true, askContinueWithoutRestore: async () => true,
    openRitual: url => {
      const w = { cb: null, onClosed(cb) { w.cb = cb; }, close() { w.closedByMain = true; } };
      ui.ritual = w; ui.url = url;
      if (o.onRitual) setImmediate(() => o.onRitual(url, w));
      return w;
    },
  };
  return ui;
}
const fakeStart = (serverOf) => {
  const calls = [];
  const fn = async (sel, opts) => {
    calls.push({ sel, opts });
    const server = serverOf ? serverOf() : { runId: "0123456789abcdef", getState: () => "done", close() {} };
    return { url: "http://127.0.0.1:1/?t=" + "f".repeat(64), server, selection: sel, sha256: sel.sha256, runId: server.runId };
  };
  fn.calls = calls; return fn;
};
function make(t, o = {}) {
  return createController({ ui: o.ui || fakeUi(), paths: t.paths, identity: { sid: SID, elevated: false }, runScan: o.runScan,
    restore: async () => ({ outcome: "made", message: RESTORE_MESSAGES.made, detail: "made" }), startRun: o.startRun || fakeStart(),
    protectedPaths: [path.join(t.root, "Documents")], readAudit: () => [], pollMs: 5, ...(o.extra || {}) });
}

test("startRun receives the scan's start time as a finite number taken at scan start", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a"));
    const startRun = fakeStart();
    const before = Date.now();
    const c = make(t, { runScan: async () => resultFor(t, [a]), startRun });
    await c.scanSmart();
    const after = Date.now();
    await c.delete({ ids: [a.id] });
    const v = startRun.calls[0].opts.scanStartMs;
    assert.ok(Number.isFinite(v) && v >= before && v <= after, String(v));
  } finally { t.cleanup(); }
});

test("a file modified after the scan started (or now locked) is refused before startRun: nothing started, a fixed message", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a")), b = vetted(t.f("b"));
    for (const [name, extra, mutate] of [["young", {}, () => { const d = new Date(Date.now() + 60000); fs.utimesSync(a.path, d, d); }],
      ["locked", { isLocked: p => p === b.path }, () => {}]]) {
      const startRun = fakeStart();
      const ui = fakeUi();
      const c = make(t, { runScan: async () => resultFor(t, [a, b]), startRun, ui, extra });
      await c.scanSmart();
      mutate();
      const r = await c.delete({ ids: [a.id, b.id] });
      assert.equal(r.ok, false, name);
      assert.equal(startRun.calls.length, 0, name);
      assert.match(ui.phases.at(-1).detail, /changed or are no longer safe/, name);
      assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path));
    }
  } finally { t.cleanup(); }
});

test("isDeleting() is true only while the server is in the deleting state", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a"));
    let state = "armed";
    const server = { runId: "0123456789abcdef", getState: () => state, close() {} };
    const seen = [];
    let c;
    const step = async (s) => { state = s; seen.push([s, c.isDeleting()]); await new Promise(r => setTimeout(r, 20)); };
    const ui = fakeUi({ onRitual: async () => { await step("unlocked"); await step("deleting"); await step("done"); } });
    c = make(t, { runScan: async () => resultFor(t, [a]), startRun: fakeStart(() => server), ui });
    assert.equal(c.isDeleting(), false);
    await c.scanSmart();
    await c.delete({ ids: [a.id] });
    assert.deepEqual(seen, [["unlocked", false], ["deleting", true], ["done", false]]);
    assert.equal(c.isDeleting(), false);
  } finally { t.cleanup(); }
});

test("ritual window closed before the press: a 'cancelled' audit line (runId, no token, no url) is written", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a"));
    let state = "armed";
    const server = { runId: "0123456789abcdef", getState: () => state, closed: false, close() { server.closed = true; } };
    const ui = fakeUi({ onRitual: (_u, w) => { state = "unlocked"; w.cb(); } });
    const c = make(t, { runScan: async () => resultFor(t, [a]), startRun: fakeStart(() => server), ui });
    await c.scanSmart();
    const r = await c.delete({ ids: [a.id] });
    assert.equal(r.ok, false);
    const lines = readAuditLines(t.paths.runDir, "0123456789abcdef");
    const line = lines.find(l => l.state === "cancelled");
    assert.ok(line, JSON.stringify(lines));
    const text = fs.readFileSync(path.join(t.paths.runDir, "nuke-audit.log"), "utf8");
    assert.ok(!text.includes("f".repeat(64)) && !text.includes("127.0.0.1") && !text.includes("?t="));
    assert.ok(Number.isFinite(Date.parse(line.at)));
  } finally { t.cleanup(); }
});
