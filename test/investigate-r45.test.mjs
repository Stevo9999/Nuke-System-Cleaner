// R45 (items outside the user's profile are report-only in standard mode) and the picked-item rating (medium, unticked
// unless a program entry was traced to it). Temp-dir fixtures with a fake env/home; the registry is injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { investigate } from "../lib/investigate.mjs";

const OUTSIDE_NOTE = "Outside your user folder: delete this by hand (another account on this PC could redirect an automatic delete)";

function world() {
  const root = realpathSync.native(mkdtempSync(tmpdir() + "\\inv45-"));
  const home = root + "\\home";
  const env = { USERPROFILE: home, LOCALAPPDATA: home + "\\AppData\\Local", APPDATA: home + "\\AppData\\Roaming", ProgramData: root + "\\PD", ProgramFiles: root + "\\PF" };
  for (const d of [env.LOCALAPPDATA + "\\Programs", env.APPDATA + "\\Microsoft\\Windows\\Start Menu\\Programs", home + "\\AppData\\LocalLow", env.ProgramData, env.ProgramFiles])
    mkdirSync(d, { recursive: true });
  return { root, home, env, clean: () => rmSync(root, { recursive: true, force: true }) };
}
const file = (p, body = "x") => { mkdirSync(p.slice(0, p.lastIndexOf("\\")), { recursive: true }); writeFileSync(p, body); };
const val = (data) => ({ type: "REG_SZ", data, lossy: false });
const ukey = (name, v) => ({ path: "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + name, values: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)])) });
const reg = (hkcu = []) => async (name) => ({ ok: true, keys: name === "uninstallHKCU" ? hkcu : [] });
const noTasks = async () => ({ ok: true, tasks: [] });
const by = (r, p) => r.items.find((i) => i.path && i.path.toLowerCase() === p.toLowerCase());
const run = (w, target, o = {}) => investigate(target, { env: w.env, home: w.home, regQuery: reg(), listScheduledTasks: noTasks, readLnk: () => ({ ok: false }), ...o });

test("R45: a picked program and its install folder outside the user's profile are report-only; leftovers inside the profile stay selectable", async () => {
  const w = world();
  try {
    const inst = w.root + "\\Tools\\Foo";
    file(inst + "\\foo.exe");
    file(w.env.LOCALAPPDATA + "\\Foo\\cache.bin");
    const r = await run(w, inst + "\\foo.exe", { regQuery: reg([ukey("Foo", { DisplayName: "Foo App", Publisher: "Foo Inc", InstallLocation: inst })]) });
    const exe = by(r, inst + "\\foo.exe");
    assert.ok(exe);
    assert.equal(exe.group, "report-only");
    assert.equal(exe.selectable, false);
    assert.equal(exe.preTicked, false);
    assert.equal(exe.confidence, null);
    assert.equal(exe.reason, OUTSIDE_NOTE);
    const folder = by(r, inst); // outside every allowed root as well: never selectable, whatever the group
    assert.ok(folder);
    assert.equal(folder.selectable, false);
    assert.equal(folder.preTicked, false);
    const left = by(r, w.env.LOCALAPPDATA + "\\Foo");
    assert.equal(left.group, "exclusive");
    assert.equal(left.selectable, true);
    assert.equal(left.confidence, "high");
  } finally { w.clean(); }
});

test("R45: a leftover under ProgramData (outside the profile) and a plain untraced pick outside the profile are report-only", async () => {
  const w = world();
  try {
    const inst = w.env.LOCALAPPDATA + "\\Programs\\Foo";
    file(inst + "\\foo.exe");
    file(w.env.ProgramData + "\\Foo\\machine.cfg");
    const r = await run(w, inst + "\\foo.exe", { regQuery: reg([ukey("Foo", { DisplayName: "Foo App", Publisher: "Foo Inc", InstallLocation: inst })]) });
    const pd = by(r, w.env.ProgramData + "\\Foo");
    assert.ok(pd);
    assert.equal(pd.selectable, false);
    assert.equal(pd.preTicked, false); // ProgramData is a system folder (protected) as well as outside the profile
    assert.equal(by(r, inst).selectable, true, "the per-user install folder is still offered");

    file(w.root + "\\Elsewhere\\Thing\\a.bin");
    const r2 = await run(w, w.root + "\\Elsewhere\\Thing");
    const picked = by(r2, w.root + "\\Elsewhere\\Thing");
    assert.ok(picked);
    assert.equal(picked.selectable, false);
    assert.equal(picked.group, "report-only");
    assert.equal(picked.reason, OUTSIDE_NOTE);
  } finally { w.clean(); }
});

test("R45: the profile comparison is by whole path segments (a sibling folder named like the profile is outside)", async () => {
  const w = world();
  try {
    file(w.root + "\\home-evil\\Thing\\a.bin");
    const r = await run(w, w.root + "\\home-evil\\Thing");
    const picked = by(r, w.root + "\\home-evil\\Thing");
    assert.ok(picked);
    assert.equal(picked.selectable, false);
    assert.equal(picked.reason, OUTSIDE_NOTE);
  } finally { w.clean(); }
});

test("picked item: untraced pick is medium and unticked but selectable; traced from a program entry stays high", async () => {
  const w = world();
  try {
    file(w.home + "\\Stuff\\Thing\\a.bin");
    const r = await run(w, w.home + "\\Stuff\\Thing");
    const f = by(r, w.home + "\\Stuff\\Thing");
    assert.ok(f);
    assert.equal(f.confidence, "medium");
    assert.equal(f.preTicked, false);
    assert.equal(f.selectable, true);
    assert.equal(f.category, "picked");

    // an unreadable program list never makes the pick high either
    const r1 = await run(w, w.home + "\\Stuff\\Thing", { regQuery: async () => ({ ok: false, reason: "x" }) });
    assert.equal(by(r1, w.home + "\\Stuff\\Thing").preTicked, false);

    const inst = w.env.LOCALAPPDATA + "\\Programs\\Foo";
    file(inst + "\\foo.exe");
    const r2 = await run(w, inst + "\\foo.exe", { regQuery: reg([ukey("Foo", { DisplayName: "Foo App", InstallLocation: inst })]) });
    const g = by(r2, inst + "\\foo.exe");
    assert.equal(g.confidence, "high");
    assert.equal(g.preTicked, true);
  } finally { w.clean(); }
});
