// R45 in the controller: choose() refuses investigate items outside profileRoot even if a (forged or stale) result marks them selectable.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createController } from "../../app/main/controller.mjs";
import { appDataPaths, ensureAppData } from "../../app/main/appdata.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { RESTORE_MESSAGES } from "../../lib/restore.mjs";

const SID = "S-1-5-21-11-22-33-1001";

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-r45-"));
  const home = path.join(root, "home");
  const other = path.join(root, "Tools");
  fs.mkdirSync(path.join(home, "Stuff"), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const paths = appDataPaths({ LOCALAPPDATA: path.join(home, "Local") });
  ensureAppData(paths);
  return { root, home, other, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const item = p => makeFinding({ kind: "file", path: p, label: p, bytes: 1, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false, reason: "r", category: "x" });
const ui = () => ({
  sendProgress() {}, sendPhase() {}, showResults() {}, closeResults() {}, confirmPermanent: async () => true,
  askContinueWithoutRestore: async () => true, pickFile: async () => null, pickFolder: async () => null,
  openRitual() { return { onClosed() {}, close() {} }; },
});

test("R45: investigate items outside profileRoot are refused by choose(); inside is accepted; smart scan is unaffected", async () => {
  const t = tree();
  try {
    const inside = path.join(t.home, "Stuff", "a.txt"); fs.writeFileSync(inside, "x");
    const outside = path.join(t.other, "b.txt"); fs.writeFileSync(outside, "x");
    for (const [p, ok] of [[inside, true], [outside, false]]) {
      const it = item(p);
      let started = 0;
      const u = ui();
      u.pickFolder = async () => path.dirname(p);
      const c = createController({
        ui: u, paths: t.paths, identity: { sid: SID, elevated: false }, profileRoot: t.home,
        runScan: async () => ({ kind: "investigate", target: p, items: [it], allowedRoots: [path.dirname(p)], protectedPaths: [], notes: [] }),
        restore: async () => ({ outcome: "made", message: RESTORE_MESSAGES.made, detail: "made" }),
        startRun: async () => { started++; throw new Error("stop"); }, readAudit: () => [], pollMs: 1,
      });
      await c.scanFolder();
      const res = await c.delete({ ids: [it.id] }).then(r => r, e => ({ refused: /refused/.test(e.message) }));
      if (ok) assert.equal(started, 1, "inside the profile: reaches the run start");
      else { assert.equal(started, 0, "outside the profile: never frozen or started"); assert.equal(res.refused, true); }
    }
    // a Smart Scan result outside the profile (e.g. a Recycle Bin on another drive) is not subject to R45
    const it = item(outside);
    let started = 0;
    const c = createController({
      ui: ui(), paths: t.paths, identity: { sid: SID, elevated: false }, profileRoot: t.home,
      runScan: async () => ({ kind: "smart", target: null, items: [it], allowedRoots: [t.other], protectedPaths: [], notes: [] }),
      restore: async () => ({ outcome: "made", message: RESTORE_MESSAGES.made, detail: "made" }),
      startRun: async () => { started++; throw new Error("stop"); }, readAudit: () => [], pollMs: 1,
    });
    await c.scanSmart();
    await c.delete({ ids: [it.id] }).catch(() => {});
    assert.equal(started, 1);
  } finally { t.cleanup(); }
});

test("R45: a relative or malformed profileRoot fails closed for investigate items", async () => {
  const t = tree();
  try {
    const inside = path.join(t.home, "Stuff", "a.txt"); fs.writeFileSync(inside, "x");
    const it = item(inside);
    let started = 0;
    const u = ui();
    u.pickFolder = async () => path.dirname(inside);
    const c = createController({
      ui: u, paths: t.paths, identity: { sid: SID, elevated: false }, profileRoot: "home",
      runScan: async () => ({ kind: "investigate", target: inside, items: [it], allowedRoots: [path.dirname(inside)], protectedPaths: [], notes: [] }),
      restore: async () => ({ outcome: "made", message: RESTORE_MESSAGES.made, detail: "made" }),
      startRun: async () => { started++; throw new Error("stop"); }, readAudit: () => [], pollMs: 1,
    });
    await c.scanFolder();
    await c.delete({ ids: [it.id] }).catch(() => {});
    assert.equal(started, 0);
  } finally { t.cleanup(); }
});
