// Controller: the plain-confirm setting travels to startRun (decided here, from the app's own settings file), and the
// Windows tools methods (fixed list, key only, standard mode only).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createController } from "../../app/main/controller.mjs";
import { appDataPaths, ensureAppData } from "../../app/main/appdata.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { RESTORE_MESSAGES } from "../../lib/restore.mjs";
import { WINTOOLS } from "../../lib/wintools.mjs";

const SID = "S-1-5-21-11-22-33-1001";
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-copt-"));
  const la = path.join(root, "Local"), junk = path.join(la, "Temp");
  fs.mkdirSync(junk, { recursive: true });
  const f = n => { const p = path.join(junk, n); fs.writeFileSync(p, n.repeat(10)); return p; };
  const paths = appDataPaths({ LOCALAPPDATA: la });
  ensureAppData(paths);
  return { root, la, junk, f, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const vetted = p => makeFinding({ kind: "file", path: p, label: p, bytes: 10, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false, reason: "r", category: "Temporary files" });
const resultFor = (t, items) => ({ kind: "smart", target: null, items, allowedRoots: [t.junk], protectedPaths: [], notes: [], adminExtraBytes: null, partial: false });
const fakeUi = () => ({
  phases: [], pickFile: async () => null, pickFolder: async () => null, sendProgress() {}, sendPhase() {}, showResults() {}, closeResults() {},
  confirmPermanent: async () => true, askContinueWithoutRestore: async () => true, confirmAction: async () => true,
  openRitual: () => ({ onClosed() {}, close() {} }),
});
const fakeStart = () => {
  const calls = [];
  const fn = async (sel, opts) => {
    calls.push({ sel, opts });
    const server = { runId: "0123456789abcdef", getState: () => "done", close() {} };
    return { url: "http://127.0.0.1:1/?t=" + "f".repeat(64), server, selection: sel, sha256: sel.sha256, runId: server.runId };
  };
  fn.calls = calls; return fn;
};
function make(t, o = {}) {
  return createController({ ui: fakeUi(), paths: t.paths, identity: o.identity || { sid: SID, elevated: false }, runScan: o.runScan,
    restore: async () => ({ outcome: "made", message: RESTORE_MESSAGES.made, detail: "made" }), startRun: o.startRun || fakeStart(),
    protectedPaths: [path.join(t.root, "Documents")], readAudit: () => [], pollMs: 5, ...(o.extra || {}) });
}

test("delete passes plainConfirm:false by default and plainConfirm:true after the setting is turned on (from the settings file only)", async () => {
  const t = tree();
  try {
    for (const [saved, want] of [[null, false], [{ restorePoint: false, plainConfirm: false }, false], [{ restorePoint: false, plainConfirm: true }, true]]) {
      if (saved) await make(t, { runScan: async () => resultFor(t, []) }).settingsSet(saved);
      const a = vetted(t.f("a" + String(want) + String(saved === null)));
      const startRun = fakeStart();
      const c = make(t, { runScan: async () => resultFor(t, [a]), startRun });
      await c.scanSmart();
      const r = await c.delete({ ids: [a.id] });
      assert.equal(r.ok, true);
      assert.equal(startRun.calls.length, 1);
      assert.strictEqual(startRun.calls[0].opts.plainConfirm, want);
      assert.deepEqual(Object.keys(startRun.calls[0].opts).sort(), ["adminContents", "plainConfirm", "runDir", "scanStartMs"]);
    }
  } finally { t.cleanup(); }
});

test("an old settings file with only restorePoint still works and means the 3D room", async () => {
  const t = tree();
  try {
    fs.writeFileSync(t.paths.settingsFile, '{"restorePoint":false}');
    const c = make(t, { runScan: async () => resultFor(t, []) });
    assert.deepEqual(await c.settingsGet(), { restorePoint: false, plainConfirm: false, exclusions: [] });
    const a = vetted(t.f("old"));
    const startRun = fakeStart();
    const c2 = make(t, { runScan: async () => resultFor(t, [a]), startRun });
    await c2.scanSmart(); await c2.delete({ ids: [a.id] });
    assert.strictEqual(startRun.calls[0].opts.plainConfirm, false);
  } finally { t.cleanup(); }
});

test("toolsList: key, label, description only; toolsOpen starts the key through the launcher and reports ok", async () => {
  const t = tree();
  try {
    const started = [];
    const c = make(t, { extra: { startTool: async k => { started.push(k); return { ok: k === "services" }; } } });
    const list = await c.toolsList();
    assert.equal(list.length, Object.keys(WINTOOLS).length);
    assert.ok(!JSON.stringify(list).includes("System32"));
    assert.deepEqual(await c.toolsOpen({ tool: "services" }), { ok: true });
    assert.deepEqual(await c.toolsOpen({ tool: "keyboard" }), { ok: false });
    assert.deepEqual(started, ["services", "keyboard"]);
  } finally { t.cleanup(); }
});

test("toolsOpen fails closed: unknown key or shape, administrator mode, unknown identity; a throwing launcher gives ok:false", async () => {
  const t = tree();
  try {
    let n = 0;
    const startTool = async () => { n++; return { ok: true }; };
    const c = make(t, { extra: { startTool } });
    for (const bad of [undefined, null, {}, { tool: "nope" }, { tool: "toString" }, { tool: "__proto__" }, { tool: 5 }, { tool: "C:\\Windows\\System32\\cmd.exe" }, "services"])
      await assert.rejects(c.toolsOpen(bad), /refused/);
    const admin = make(t, { identity: { sid: SID, elevated: true }, extra: { startTool } });
    await assert.rejects(admin.toolsOpen({ tool: "services" }), /refused/);
    const unknown = make(t, { identity: { sid: SID, elevated: null }, extra: { startTool } });
    await assert.rejects(unknown.toolsOpen({ tool: "services" }), /refused/);
    assert.equal(n, 0, "the launcher was never called");
    const boom = make(t, { extra: { startTool: async () => { throw new Error("C:\\secret path"); } } });
    assert.deepEqual(await boom.toolsOpen({ tool: "services" }), { ok: false });
  } finally { t.cleanup(); }
});
