// One-time migration of settings.json from %LOCALAPPDATA%\Nuke-Uninstaller to %LOCALAPPDATA%\Nuke System Cleaner (temp dirs only).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDataPaths, ensureAppData, migrateLegacySettings, loadSettings, loadExclusions } from "../../app/main/appdata.mjs";

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "nuke-migrate-"));
const rm = d => fs.rmSync(d, { recursive: true, force: true });
function setup(la) {
  const paths = appDataPaths({ LOCALAPPDATA: la });
  ensureAppData(paths);
  const old = path.join(la, "Nuke-Uninstaller");
  fs.mkdirSync(old, { recursive: true });
  return { paths, old };
}

test("the data folder is %LOCALAPPDATA%\\Nuke System Cleaner", () => {
  assert.equal(appDataPaths({ LOCALAPPDATA: "C:\\Users\\Me\\AppData\\Local" }).root, path.resolve("C:\\Users\\Me\\AppData\\Local", "Nuke System Cleaner"));
});

test("migrates the sanitised settings once; run/, electron/ and logs are never copied; the old folder stays untouched", () => {
  const la = mk();
  try {
    const { paths, old } = setup(la);
    const good = path.resolve(la, "keep-me");
    fs.writeFileSync(path.join(old, "settings.json"), JSON.stringify({ restorePoint: false, plainConfirm: true, exclusions: [good, "relative\\bad", good.toUpperCase(), 7], extra: "junk" }));
    fs.mkdirSync(path.join(old, "run")); fs.writeFileSync(path.join(old, "run", "x.json"), "{}"); fs.writeFileSync(path.join(old, "audit.log"), "log");
    assert.deepEqual(migrateLegacySettings(paths), { migrated: true });
    assert.deepEqual(loadSettings(paths.settingsFile), { restorePoint: false, plainConfirm: true });
    assert.deepEqual(loadExclusions(paths.settingsFile), [good]);
    assert.ok(!fs.readFileSync(paths.settingsFile, "utf8").includes("junk"));
    assert.deepEqual(fs.readdirSync(paths.runDir), []);
    assert.ok(!fs.existsSync(path.join(paths.root, "audit.log")));
    assert.ok(fs.existsSync(path.join(old, "run", "x.json")) && fs.existsSync(path.join(old, "audit.log")) && fs.existsSync(path.join(old, "settings.json")));
    // second call: the new file exists, nothing happens
    fs.writeFileSync(path.join(old, "settings.json"), JSON.stringify({ restorePoint: true, plainConfirm: false }));
    assert.equal(migrateLegacySettings(paths).migrated, false);
    assert.equal(loadSettings(paths.settingsFile).restorePoint, false);
  } finally { rm(la); }
});

test("does nothing when the new settings exist, the old ones are missing, corrupt, oversized or not a plain object", () => {
  const la = mk();
  try {
    const { paths, old } = setup(la);
    assert.equal(migrateLegacySettings(paths).migrated, false, "no old file");
    for (const body of ["{not json", "[1,2]", "null", JSON.stringify({ exclusions: "oops" }), "x".repeat(70 * 1024)]) {
      fs.writeFileSync(path.join(old, "settings.json"), body);
      assert.equal(migrateLegacySettings(paths).migrated, false, body.slice(0, 12));
      assert.ok(!fs.existsSync(paths.settingsFile));
    }
    fs.writeFileSync(path.join(old, "settings.json"), JSON.stringify({ restorePoint: false, plainConfirm: false }));
    fs.writeFileSync(paths.settingsFile, JSON.stringify({ restorePoint: true, plainConfirm: true }));
    assert.equal(migrateLegacySettings(paths).migrated, false);
    assert.equal(loadSettings(paths.settingsFile).restorePoint, true, "existing new settings are kept");
  } finally { rm(la); }
});

test("never throws on odd input", () => {
  for (const bad of [null, undefined, {}, { root: 1 }, { root: "Z:\\nope\\x", settingsFile: "Z:\\nope\\x\\settings.json" }])
    assert.doesNotThrow(() => migrateLegacySettings(bad));
  const la = mk();
  try {
    const { paths, old } = setup(la);
    fs.mkdirSync(path.join(old, "settings.json")); // a folder where the file should be
    assert.equal(migrateLegacySettings(paths).migrated, false);
  } finally { rm(la); }
});
