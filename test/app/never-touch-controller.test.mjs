// The never-touch list is enforced by the controller: an item on it is refused when chosen, even if a scan offered it
// and the renderer sends its id directly.
import test from "node:test";
import assert from "node:assert/strict";
import { createController } from "../../app/main/controller.mjs";
import { makeFinding } from "../../lib/confidence.mjs";

const SID = "S-1-5-21-11-22-33-1001";
const PROFILE = "C:\\Users\\me";
const vetted = p => makeFinding({ kind: "file", path: p, label: p, bytes: 10, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false, reason: "r", category: "Temporary files" });

function ctl(paths, extra = {}) {
  const items = paths.map(vetted);
  const ui = { phases: [], sendPhase: p => ui.phases.push(p), sendProgress() {}, showResults() {}, closeResults() {},
    confirmPermanent: async () => true, confirmAction: async () => true, askContinueWithoutRestore: async () => true };
  const started = [];
  const c = createController({ ui, paths: { settingsFile: "E:\\nope\\settings.json" }, identity: { elevated: false, sid: SID }, profileRoot: PROFILE,
    runScan: async () => ({ kind: "smart", items, notes: [], allowedRoots: ["C:\\"], protectedPaths: [] }),
    startRun: async () => { started.push(1); throw new Error("must not start"); }, ...extra });
  return { c, items, started };
}

test("a scan result on the never-touch list is refused at selection and nothing is started", async () => {
  const bad = ["C:\\Windows\\System32\\drivers\\x.sys", "C:\\Program Files\\App\\a.dll", "C:\\Users\\me\\NTUSER.DAT", "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Protect\\k", "C:\\Users\\me\\.ssh\\id_rsa"];
  const { c, items, started } = ctl(bad);
  await c.scanSmart();
  for (const it of items) await assert.rejects(c.delete({ ids: [it.id] }), /refused|error/i, it.path);
  assert.equal(started.length, 0);
});
