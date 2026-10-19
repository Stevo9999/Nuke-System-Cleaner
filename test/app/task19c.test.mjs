// Task 19C: R45 fail-closed, startup protection wiring, extras hygiene, restore inner-script exit codes. Temp dirs only; fake spawn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createController } from "../../app/main/controller.mjs";
import { appDataPaths, ensureAppData, appProtectedPaths, appProtectedRoots, buildProtection, cleanExtras, MAX_EXTRAS } from "../../app/main/appdata.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { RESTORE_MESSAGES, restoreScripts } from "../../lib/restore.mjs";

const SID = "S-1-5-21-11-22-33-1001";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const rd = f => fs.readFileSync(path.join(ROOT, f), "utf8");

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-19c-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, "Stuff"), { recursive: true });
  const paths = appDataPaths({ LOCALAPPDATA: path.join(home, "Local") });
  ensureAppData(paths);
  return { root, home, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const item = (p, kind = "file") => makeFinding({ kind, path: p, label: p, bytes: 1, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false, reason: "r", category: "x" });
const ui = () => ({
  sendProgress() {}, sendPhase() {}, showResults() {}, closeResults() {}, confirmPermanent: async () => true,
  askContinueWithoutRestore: async () => true, pickFile: async () => null, pickFolder: async () => null,
  openRitual() { return { onClosed() {}, close() {} }; },
});

async function tryDelete(t, it, opts, kind = "investigate") {
  let started = 0;
  const u = ui();
  u.pickFolder = async () => path.dirname(it.path);
  const c = createController({
    ui: u, paths: t.paths, identity: { sid: SID, elevated: false }, ...opts,
    runScan: async () => ({ kind, target: it.path, items: [it], allowedRoots: [path.dirname(it.path)], protectedPaths: [], notes: [] }),
    restore: async () => ({ outcome: "made", message: RESTORE_MESSAGES.made, detail: "made" }),
    startRun: async () => { started++; throw new Error("stop"); }, readAudit: () => [], pollMs: 1,
  });
  if (kind === "smart") await c.scanSmart(); else await c.scanFolder();
  const res = await c.delete({ ids: [it.id] }).then(r => r, e => ({ refused: /refused/.test(e.message) }));
  return { started, res };
}

test("19C R45: no profileRoot at all => investigate items refused (fail closed)", async () => {
  const t = tree();
  try {
    const p = path.join(t.home, "Stuff", "a.txt"); fs.writeFileSync(p, "x");
    const r = await tryDelete(t, item(p), {});
    assert.equal(r.started, 0);
    assert.equal(r.res.refused, true);
    for (const bad of [null, undefined, "", 7, {}]) {
      const r2 = await tryDelete(t, item(p), { profileRoot: bad });
      assert.equal(r2.started, 0, String(bad));
    }
    const ok = await tryDelete(t, item(p), { profileRoot: t.home });
    assert.equal(ok.started, 1, "explicit valid profileRoot still works");
  } finally { t.cleanup(); }
});

test("19C R45: the profile root itself is not selectable; smart scan unaffected by a missing profileRoot", async () => {
  const t = tree();
  try {
    const r = await tryDelete(t, item(t.home, "dir"), { profileRoot: t.home, protectedRoots: [path.join(t.root, "elsewhere")] });
    assert.equal(r.started, 0);
    assert.equal(r.res.refused, true);
    const p = path.join(t.home, "Stuff", "a.txt"); fs.writeFileSync(p, "x");
    const s = await tryDelete(t, item(p), {}, "smart");
    assert.equal(s.started, 1, "smart scan keeps its own rules");
  } finally { t.cleanup(); }
});

test("19C: buildProtection returns profileRoot, protections with known folders, notes; failures never shrink protection", async () => {
  const t = tree();
  try {
    const extra = path.join(t.root, "Redirected", "Docs");
    const reg = async name => name === "userShellFolders"
      ? { ok: true, keys: [{ path: "k", values: { Personal: { type: "REG_EXPAND_SZ", data: extra } } }] }
      : { ok: false };
    const env = { USERPROFILE: t.home, LOCALAPPDATA: path.join(t.home, "Local") };
    const a = await buildProtection({ appDir: path.join(t.root, "app"), dataRoot: t.paths.root, home: t.home, env, readReg: reg });
    assert.equal(a.profileRoot, path.resolve(t.home));
    assert.ok(a.protectedPaths.includes(path.resolve(extra)));
    assert.ok(a.protectedRoots.includes(path.resolve(extra)));
    assert.ok(a.notes.length >= 1, "OneDrive read failure is noted");
    const base = appProtectedPaths({ appDir: path.join(t.root, "app"), dataRoot: t.paths.root, home: t.home, env });
    const b = await buildProtection({ appDir: path.join(t.root, "app"), dataRoot: t.paths.root, home: t.home, env, readReg: async () => { throw new Error("boom"); } });
    for (const p of base) assert.ok(b.protectedPaths.includes(p), "never fewer: " + p);
    for (const p of appProtectedRoots({ home: t.home, env })) assert.ok(b.protectedRoots.includes(p));
    assert.ok(b.notes.length >= 1);
    // invalid profile: relative USERPROFILE and relative home => null (controller then fails closed)
    const c = await buildProtection({ appDir: path.join(t.root, "app"), dataRoot: t.paths.root, home: t.home, env: { USERPROFILE: "rel" }, readReg: null });
    assert.equal(c.profileRoot, path.resolve(t.home));
  } finally { t.cleanup(); }
});

test("19C: main.mjs wires profileRoot, readKnownFolders with sysread's regQuery, and never builds protection twice", () => {
  const s = rd("app/main/main.mjs");
  assert.match(s, /buildProtection/);
  assert.match(s, /regQuery/);
  assert.match(s, /profileRoot/);
  assert.match(s, /createController\(\{[^}]*profileRoot/);
  const a = rd("app/main/appdata.mjs");
  assert.match(a, /readKnownFolders\(\{[^}]*readReg/);
  assert.doesNotMatch(a, /child_process/, "appdata stays free of process starts");
});

test("19C: extras drop drive roots (with a note) and are capped at 64 (with a note)", () => {
  const drive = path.parse(os.tmpdir()).root;
  const good = path.join(drive, "nuke19c-x", "a");
  const r = cleanExtras([drive, good]);
  assert.deepEqual(r.paths, [good]);
  assert.ok(r.notes.some(n => /drive/i.test(n)));
  assert.ok(!appProtectedPaths({ appDir: path.join(drive, "x", "app"), dataRoot: path.join(drive, "x", "d"), home: path.join(drive, "x", "h"), env: {}, extraPaths: [drive] }).includes(drive));
  assert.ok(!appProtectedRoots({ home: path.join(drive, "x", "h"), env: {}, extraPaths: [drive] }).includes(drive));
  assert.equal(MAX_EXTRAS, 64);
  const many = Array.from({ length: 100 }, (_, i) => path.join(drive, "nuke19c-many", "d" + i));
  const c = cleanExtras(many);
  assert.equal(c.paths.length, 64);
  assert.ok(c.notes.some(n => /64/.test(n)));
  const roots = appProtectedRoots({ home: path.join(drive, "x", "h"), env: {}, extraPaths: many });
  assert.ok(roots.filter(p => p.includes("nuke19c-many")).length <= 64);
});

test("19C: restore inner script exit codes with stubbed cmdlets (PowerShell only, temp stubs, no real restore point)", { skip: process.platform !== "win32" }, () => {
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  if (!fs.existsSync(ps)) return;
  const runId = "0123456789abcdef";
  const { inner } = restoreScripts({ runId, psExe: ps });
  const desc = "Nuke System Cleaner " + runId;
  const stub = (check, points) => [
    "$script:made = $false",
    "function Get-ComputerRestorePoint { [CmdletBinding()] param() " + points + " }",
    "function Checkpoint-Computer { [CmdletBinding()] param($Description, $RestorePointType) " + check + " }",
  ].join("\r\n");
  const mine = (d, seq) => "[pscustomobject]@{ Description = '" + d + "'; SequenceNumber = " + seq + " }";
  const pointsIf = d => "if ($script:made) { " + mine(d, 9) + " }";
  const cases = [
    ["made", 20, "$script:made = $true", pointsIf(desc)],
    ["24h limit", 21, "Write-Warning 'A new system restore point cannot be created: one was created within the last 1440 minutes'", pointsIf(desc)],
    ["turned off", 22, "throw 'System Restore is turned off'", ""],
    ["unknown error", 23, "throw 'boom'", ""],
    ["wrong description", 23, "$script:made = $true", pointsIf("Other 1")],
    ["none found", 23, "", ""],
    ["access denied", 24, "throw 'Access is denied'", ""],
  ];
  for (const [name, code, check, points] of cases) {
    const script = stub(check, points) + "\r\n" + inner;
    const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { shell: false, windowsHide: true, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, code, name + " stderr=" + String(r.stderr).slice(0, 200));
  }
});
