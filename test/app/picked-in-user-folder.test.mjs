// A file or folder the user picks by hand INSIDE one of their personal folders (Downloads, Documents, ...) may be removed; the
// personal folders themselves stay protected, and so do the user's own never-touch folders and the Windows program folders.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { investigate } from "../../lib/investigate.mjs";
import { createController } from "../../app/main/controller.mjs";

function world() {
  const root = realpathSync.native(mkdtempSync(tmpdir() + "\\pick-"));
  const home = root + "\\home";
  const env = { USERPROFILE: home, LOCALAPPDATA: home + "\\AppData\\Local", APPDATA: home + "\\AppData\\Roaming", ProgramData: root + "\\PD", ProgramFiles: root + "\\PF" };
  for (const d of [env.LOCALAPPDATA + "\\Programs", env.APPDATA, home + "\\AppData\\LocalLow", env.ProgramData, env.ProgramFiles, home + "\\Downloads", home + "\\Documents", env.ProgramFiles + "\\Dummy slop"]) mkdirSync(d, { recursive: true });
  const f = home + "\\Downloads\\movie.mp4"; writeFileSync(f, "x".repeat(100));
  const old = new Date(Date.now() - 5 * 86400e3); utimesSync(f, old, old);
  return { root, home, env, file: f, downloads: home + "\\Downloads", documents: home + "\\Documents", clean: () => rmSync(root, { recursive: true, force: true }) };
}
const reg = async () => ({ ok: true, keys: [] });
const tasks = async () => ({ ok: true, tasks: [] });
const run = (w, target, protectedPaths) => investigate(target, { env: w.env, home: w.home, regQuery: reg, listScheduledTasks: tasks, readLnk: () => ({ ok: false }), protectedPaths });

test("engine: a file picked inside a protected personal folder is protected only while that folder is in the protected list", async () => {
  const w = world();
  try {
    const blocked = (await run(w, w.file, [w.downloads])).items.find(i => i.path === w.file);
    assert.equal(blocked.selectable, false, "with Downloads protected the pick is refused (the engine's own rule is unchanged)");
    const allowed = (await run(w, w.file, [w.documents])).items.find(i => i.path === w.file);
    assert.equal(allowed.selectable, true, "when the container is not in the list the picked file can be removed");
  } finally { w.clean(); }
});

test("engine: picking the personal folder itself says so; picking inside Program Files explains the Windows program folders", async () => {
  const w = world();
  try {
    const self = (await run(w, w.downloads, [w.downloads])).items.find(i => i.path === w.downloads);
    assert.equal(self.selectable, false);
    assert.match(self.reason || "", /one of your personal folders/);
    const dummy = w.env.ProgramFiles + "\\Dummy slop";
    const pf = (await run(w, dummy, [])).items.find(i => i.path === dummy);
    assert.equal(pf.selectable, false);
    assert.match(pf.reason || "", /Windows program folder/);
    assert.match(pf.reason || "", /Installed programs/);
  } finally { w.clean(); }
});

function ctl(w, target, exclusions = []) {
  const seen = [];
  const ui = { sendPhase() {}, sendProgress() {}, showResults() {}, closeResults() {}, confirmPermanent: async () => true, confirmAction: async () => true,
    pickFile: async () => target, pickFolder: async () => target, askContinueWithoutRestore: async () => false };
  const c = createController({ ui, paths: { settingsFile: w.root + "\\settings.json" }, identity: { elevated: false, sid: "S-1-5-21-11-22-33-1001" }, profileRoot: w.home,
    protectedPaths: [w.downloads, w.documents],
    runScan: async (kind, args) => { seen.push({ kind, args }); return { kind: "investigate", target, items: [], notes: [], allowedRoots: [], protectedPaths: args.protectedPaths }; } });
  return { c, seen };
}

test("controller: only the protected folders that strictly contain the picked item are dropped for that scan", async () => {
  const w = world();
  try {
    const { c, seen } = ctl(w, w.file);
    await c.scanInvestigate();
    const prot = seen[0].args.protectedPaths;
    assert.ok(!prot.includes(w.downloads), "Downloads no longer blocks a file picked inside it");
    assert.ok(prot.includes(w.documents), "other personal folders stay protected");
    const again = ctl(w, w.downloads);
    await again.c.scanInvestigate();
    assert.ok(again.seen[0].args.protectedPaths.includes(w.downloads), "picking the folder itself keeps it protected");
  } finally { w.clean(); }
});
