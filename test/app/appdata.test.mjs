import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDataPaths, ensureAppData, DEFAULT_SETTINGS, loadSettings, saveSettings, appProtectedPaths, appProtectedRoots, violatesRoots } from "../../app/main/appdata.mjs";
import { checkPath, within } from "../../lib/safepath.mjs";
import { TOOL_PROTECTED } from "../../scan.mjs";

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "nuke-appdata-"));
const rm = d => fs.rmSync(d, { recursive: true, force: true });

test("paths live under LOCALAPPDATA\\Nuke System Cleaner; bad LOCALAPPDATA values throw", () => {
  const la = mk();
  try {
    const p = appDataPaths({ LOCALAPPDATA: la });
    const root = path.join(la, "Nuke System Cleaner");
    assert.deepEqual(p, { root, settingsFile: path.join(root, "settings.json"), runDir: path.join(root, "run"),
      restoreDir: path.join(root, "restore"), electronDir: path.join(root, "electron") });
    for (const bad of ["", "rel", "..\\x", "\\\\host\\s", "\\\\?\\C:\\x", "C:\\", "C:\\a\\..\\b", "a\0b", undefined, 5, "C:\\x:ads"])
      assert.throws(() => appDataPaths({ LOCALAPPDATA: bad }), undefined, String(bad));
    assert.throws(() => appDataPaths({}));
    assert.throws(() => appDataPaths(null));
    assert.throws(() => appDataPaths({ LOCALAPPDATA: path.parse(os.homedir()).root + "Windows" }));
    assert.throws(() => appDataPaths({ LOCALAPPDATA: os.homedir() }));
  } finally { rm(la); }
});

test("ensureAppData creates folders and refuses a linked root", () => {
  const la = mk();
  const victim = mk();
  const la2 = mk();
  try {
    const p = appDataPaths({ LOCALAPPDATA: la });
    ensureAppData(p);
    for (const d of [p.root, p.runDir, p.restoreDir, p.electronDir]) assert.ok(fs.statSync(d).isDirectory());
    ensureAppData(p); // idempotent
    const p2 = appDataPaths({ LOCALAPPDATA: la2 });
    fs.symlinkSync(victim, p2.root, "junction");
    assert.throws(() => ensureAppData(p2));
    assert.deepEqual(fs.readdirSync(victim), []);
  } finally {
    try { fs.unlinkSync(la2 + "\\Nuke System Cleaner"); } catch { try { fs.rmdirSync(la2 + "\\Nuke System Cleaner"); } catch { /* none */ } }
    rm(la); rm(la2); rm(victim);
  }
});

test("restorePoint defaults to true and plainConfirm to false; malformed JSON, 'false' string, extra keys -> default", () => {
  const d = mk();
  try {
    const f = path.join(d, "settings.json");
    assert.deepEqual(DEFAULT_SETTINGS, { restorePoint: true, plainConfirm: false });
    assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
    assert.deepEqual(loadSettings(f), { restorePoint: true, plainConfirm: false });            // missing
    const cases = ["{not json", "", "null", "[]", "42", '"x"', '{"restorePoint":"false"}', '{"restorePoint":0}',
      '{"restorePoint":null}', '{}', "\uFEFF{broken", '{"__proto__":{"restorePoint":false}}', '{"plainConfirm":"true"}', '{"plainConfirm":1}', '{"plainConfirm":null}'];
    for (const c of cases) { fs.writeFileSync(f, c); assert.deepEqual(loadSettings(f), { restorePoint: true, plainConfirm: false }, c); }
    fs.writeFileSync(f, '{"restorePoint":false,"evil":1,"__proto__":{"x":1}}');
    const s = loadSettings(f);
    assert.deepEqual(s, { restorePoint: false, plainConfirm: false });
    assert.deepEqual(Object.keys(s), ["restorePoint", "plainConfirm"]);
    assert.equal({}.x, undefined);
    fs.writeFileSync(f, '{"restorePoint":true}');   // an old settings file (only restorePoint) still loads
    assert.deepEqual(loadSettings(f), { restorePoint: true, plainConfirm: false });
    fs.writeFileSync(f, '{"restorePoint":true,"plainConfirm":true,"evil":1}');
    assert.deepEqual(loadSettings(f), { restorePoint: true, plainConfirm: true });
    fs.writeFileSync(f, '{"plainConfirm":true}');
    assert.deepEqual(loadSettings(f), { restorePoint: true, plainConfirm: true });
    fs.writeFileSync(f, "x".repeat(2 * 1024 * 1024)); // oversized: not trusted
    assert.deepEqual(loadSettings(f), { restorePoint: true, plainConfirm: false });
    fs.rmSync(f); fs.mkdirSync(f);                    // a directory, not a file
    assert.deepEqual(loadSettings(f), { restorePoint: true, plainConfirm: false });
    assert.deepEqual(loadSettings(123), { restorePoint: true, plainConfirm: false });
  } finally { rm(d); }
});

test("saveSettings round-trips and rejects anything but {restorePoint:boolean, plainConfirm:boolean}", () => {
  const d = mk();
  try {
    const f = path.join(d, "settings.json");
    saveSettings(f, { restorePoint: false, plainConfirm: true });
    assert.deepEqual(loadSettings(f), { restorePoint: false, plainConfirm: true });
    saveSettings(f, { plainConfirm: false, restorePoint: true });
    assert.deepEqual(loadSettings(f), { restorePoint: true, plainConfirm: false });
    assert.deepEqual(fs.readdirSync(d), ["settings.json"], "no temp file left behind");
    saveSettings(f, { restorePoint: false, plainConfirm: true });
    for (const bad of [null, undefined, [], "x", 1, {}, { restorePoint: true }, { plainConfirm: true }, { restorePoint: "true", plainConfirm: false },
      { restorePoint: 1, plainConfirm: false }, { restorePoint: null, plainConfirm: false }, { restorePoint: true, plainConfirm: "no" },
      { restorePoint: true, plainConfirm: 0 }, { restorePoint: true, plainConfirm: false, extra: 1 }, { extra: true, plainConfirm: true }, { restorePoint: true, extra: true }, [true]]) {
      assert.throws(() => saveSettings(f, bad), undefined, JSON.stringify(bad));
    }
    assert.deepEqual(loadSettings(f), { restorePoint: false, plainConfirm: true }, "failed saves leave the file intact");
    assert.deepEqual(fs.readdirSync(d), ["settings.json"]);
  } finally { rm(d); }
});

test("subtree list holds app dir, data root, tool files and user folders; exact-roots list holds home, APPDATA, LOCALAPPDATA, Start Menu", () => {
  const home = "C:\\Users\\Tester", appData = "C:\\Users\\Tester\\AppData\\Roaming", la = "C:\\Users\\Tester\\AppData\\Local";
  const appDir = la + "\\Programs\\Nuke System Cleaner\\1.0.0", dataRoot = la + "\\Nuke System Cleaner";
  const l = appProtectedPaths({ appDir, dataRoot, home, env: {} });
  const has = (list, p) => list.some(x => x.toLowerCase() === p.toLowerCase());
  for (const p of [appDir, dataRoot, ...["Desktop", "Documents", "Pictures", "Music", "Videos", "Downloads", "OneDrive"].map(n => home + "\\" + n), ...TOOL_PROTECTED])
    assert.ok(has(l, p), p);
  for (const p of [home, appData, la, appData + "\\Microsoft\\Windows\\Start Menu\\Programs"]) assert.ok(!has(l, p), "subtree list must not hold " + p);
  assert.ok(l.every(p => path.isAbsolute(p)));
  const env = { APPDATA: appData, LOCALAPPDATA: la, ProgramData: "C:\\ProgramData" };
  const r = appProtectedRoots({ home, env });
  for (const p of [home, appData, la, "C:\\ProgramData", appData + "\\Microsoft\\Windows\\Start Menu", appData + "\\Microsoft\\Windows\\Start Menu\\Programs"])
    assert.ok(has(r, p), p);
  // missing/relative env values are skipped, not turned into junk
  const r2 = appProtectedRoots({ home, env: { APPDATA: "rel", LOCALAPPDATA: "" } });
  assert.deepEqual(r2, [home]);
});

test("violatesRoots: equal or ancestor of a root is refused, inside a root is fine, garbage fails closed", () => {
  const home = "C:\\Users\\Tester", appData = home + "\\AppData\\Roaming", la = home + "\\AppData\\Local";
  const roots = appProtectedRoots({ home, env: { APPDATA: appData, LOCALAPPDATA: la } });
  assert.equal(violatesRoots(la, roots), true);
  assert.equal(violatesRoots(la.toUpperCase(), roots), true);
  assert.equal(violatesRoots(la.replaceAll("\\", "/") + "/", roots), true);
  assert.equal(violatesRoots(home + "\\AppData", roots), true);   // parent of LOCALAPPDATA
  assert.equal(violatesRoots(home, roots), true);
  assert.equal(violatesRoots("C:\\Users", roots), true);
  assert.equal(violatesRoots("C:\\", roots), true);
  assert.equal(violatesRoots(la + "\\Temp", roots), false);
  assert.equal(violatesRoots(la + "\\Vendor\\cache", roots), false);
  assert.equal(violatesRoots(appData + "\\Microsoft\\Windows\\Start Menu\\Programs\\App", roots), false);
  assert.equal(violatesRoots(home + "\\Documents", roots), false);   // not a root; protectedPaths covers it
  assert.equal(violatesRoots("D:\\other\\x", roots), false);
  assert.equal(violatesRoots(la + "\\Temp\\" + ".." + "\\", roots), true);
  assert.equal(violatesRoots(la + "\\Temp\\" + "..", roots), true);
  assert.equal(violatesRoots(la + "\\Temp.", roots), true);
  assert.equal(violatesRoots(la + "\\Temp ", roots), true);
  for (const bad of ["", "rel\\x", "\\\\host\\s\\x", "a\0b", null, undefined, 5, {}, []]) assert.equal(violatesRoots(bad, roots), true, String(bad));
  assert.equal(violatesRoots(la + "\\Temp", null), true);
  assert.equal(violatesRoots(la + "\\Temp", ["rel"]), true);
  assert.equal(violatesRoots(la + "\\Temp", []), true, "a roots list is mandatory");
  // alias forms of a root and ADS, built by string concatenation
  for (const bad of [la + ".\\", la + " \\", la + ".", la + " ", home + "\\AppData.\\Local", la + "\\Temp:x", la + ":x", la + "\\Temp\\.", la + "\\.\\Temp",
    "\\\\?\\" + la, "\\\\.\\" + la])
    assert.equal(violatesRoots(bad, roots), true, bad);
});

test("appProtectedPaths throws without absolute appDir, dataRoot or home; env-derived OneDrive folders join the subtree list", () => {
  const home = "C:\\Users\\Tester", ok = { appDir: "C:\\A\\app", dataRoot: "C:\\A\\data", home, env: {} };
  assert.doesNotThrow(() => appProtectedPaths(ok));
  for (const k of ["appDir", "dataRoot", "home"])
    for (const bad of (k === "home" ? [null, "", "rel", 5, "a\0b"] : [undefined, null, "", "rel", 5, "a\0b"])) assert.throws(() => appProtectedPaths({ ...ok, [k]: bad }), undefined, k + "=" + String(bad));
  assert.throws(() => appProtectedPaths());
  const env = { OneDrive: "D:\\OD", OneDriveCommercial: "D:\\OD - Corp", OneDriveConsumer: "D:\\OD Personal" };
  const l = appProtectedPaths({ ...ok, env });
  for (const p of Object.values(env)) assert.ok(l.some(x => x.toLowerCase() === p.toLowerCase()), p);
  const l2 = appProtectedPaths({ ...ok, env: { OneDrive: "rel", OneDriveCommercial: "", OneDriveConsumer: 5 } });
  assert.deepEqual(l2, appProtectedPaths({ ...ok, env: {} }));
});

test("violatesRoots canonicalises: a junction alias of the home's parent is still a violation", () => {
  const base = mk(), linkHost = mk();
  const jn = linkHost + "\\J";
  try {
    const home = base + "\\X", appData = home + "\\AppData\\Roaming", la = home + "\\AppData\\Local";
    fs.mkdirSync(la + "\\Temp", { recursive: true });
    fs.mkdirSync(appData, { recursive: true });
    fs.symlinkSync(base, jn, "junction");
    const roots = appProtectedRoots({ home, env: { APPDATA: appData, LOCALAPPDATA: la } });
    assert.equal(violatesRoots(la, roots), true);
    assert.equal(violatesRoots(jn + "\\X\\AppData\\Local", roots), true);
    assert.equal(violatesRoots(jn + "\\X\\AppData", roots), true);
    assert.equal(violatesRoots(jn + "\\X\\AppData\\Local\\Temp", roots), false);
    assert.equal(violatesRoots(jn + "\\X\\AppData\\Local\\Temp\\", roots), false);
  } finally {
    try { fs.unlinkSync(jn); } catch { try { fs.rmdirSync(jn); } catch { /* none */ } }
    rm(base); rm(linkHost);
  }
});

test("ensureAppData refuses a pre-existing junction in a data subfolder", () => {
  const la = mk(), victim = mk();
  const p = appDataPaths({ LOCALAPPDATA: la });
  try {
    fs.mkdirSync(p.root);
    fs.symlinkSync(victim, p.runDir, "junction");
    assert.throws(() => ensureAppData(p));
    assert.deepEqual(fs.readdirSync(victim), []);
  } finally {
    try { fs.unlinkSync(p.runDir); } catch { try { fs.rmdirSync(p.runDir); } catch { /* none */ } }
    rm(la); rm(victim);
  }
});

test("checkPath refuses LOCALAPPDATA itself and the data root, accepts a temp file under LOCALAPPDATA\\Temp", () => {
  const la = mk();
  try {
    const env = { LOCALAPPDATA: la, APPDATA: path.join(la, "Roaming") };
    const p = appDataPaths(env);
    ensureAppData(p);
    const tmpDir = path.join(la, "Temp");
    fs.mkdirSync(tmpDir);
    const tmpFile = path.join(tmpDir, "junk.tmp");
    fs.writeFileSync(tmpFile, "x");
    const vendor = path.join(la, "Vendor", "cache");
    fs.mkdirSync(vendor, { recursive: true });
    const appDir = path.join(la, "Programs", "Nuke System Cleaner", "1.0.0");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "x"), "x");
    const home = path.join(la, "fakehome");
    fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
    fs.writeFileSync(path.join(home, "Documents", "a.txt"), "x");
    const prot = appProtectedPaths({ appDir, dataRoot: p.root, home, env: {} });
    const allowedRoots = [la];
    const roots = appProtectedRoots({ home, env });
    assert.equal(checkPath(tmpFile, { allowedRoots, protectedPaths: prot }).ok, true);
    assert.equal(checkPath(vendor, { allowedRoots, protectedPaths: prot }).ok, true);
    assert.equal(checkPath(path.join(home, "Documents", "a.txt"), { allowedRoots, protectedPaths: prot }).ok, false);
    assert.equal(checkPath(path.join(appDir, "x"), { allowedRoots, protectedPaths: prot }).ok, false);
    assert.equal(checkPath(p.root, { allowedRoots, protectedPaths: prot }).ok, false);
    assert.equal(checkPath(p.settingsFile, { allowedRoots, protectedPaths: prot }).ok, false);
    // LOCALAPPDATA itself and the data root: exact-folder rule
    assert.equal(violatesRoots(la, roots), true);
    assert.equal(violatesRoots(tmpFile, roots), false);
    assert.equal(violatesRoots(vendor, roots), false);
  } finally { rm(la); }
});
