// test/admin-scan.test.mjs: Phase 1b Smart Scan elevated branch, Ruling R36 (direct-child files only, no folders) at the
// scan and at the delete step, the frozen-run flag and its audit line. Nothing is written in a real system folder:
// stand-ins live under os.tmpdir(); real Windows folders are only probed read-only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { smartScan } from "../lib/smartscan.mjs";
import { LOCATIONS, expandBase } from "../lib/junk-locations.mjs";
import { adminContentDirs, adminGateForTests, checkPath } from "../lib/safepath.mjs";
import { removeItem, DELETE_DEFAULTS } from "../lib/delete.mjs";
import { removeTreeGuarded, TREE_DEFAULTS } from "../lib/delete-internal.mjs";
import { buildSelection, revalidate, startFrozenRun } from "../run.mjs";
import { createCleanupServer, selectionHash } from "../server.mjs";

const WIN = process.platform === "win32";
const skip = !WIN;
const here = path.dirname(fileURLToPath(import.meta.url));
const H = 3600 * 1000;
const NOW = Date.now() + 100 * H;
const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const byId = id => LOCATIONS.find(l => l.id === id);
const ADMIN_IDS = ["windows-temp", "minidump", "wer-system-archive", "wer-system-queue"];
const FOLDER_NOTE = "left alone: folders are not removed in administrator mode";

const age = (p, hours) => { const t = (NOW - hours * H) / 1000; fs.utimesSync(p, t, t); };
const mk = (p, hours = 30, s = "x") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); age(p, hours); return p; };
const junction = (target, at) => fs.symlinkSync(target, at, "junction");
const unJunction = at => { try { fs.unlinkSync(at); } catch { try { fs.rmdirSync(at); } catch { /* gone */ } } };

// Stand-ins for C:\Windows and C:\ProgramData with the four administrator folders, plus a user profile and a victim.
function standIn() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "admin-scan-"));
  const W = path.join(t, "Win"), P = path.join(t, "PD"), LA = path.join(t, "Local"), RA = path.join(t, "Roaming");
  const dirs = [path.join(W, "Temp"), path.join(W, "Minidump"), path.join(P, "Microsoft", "Windows", "WER", "ReportArchive"),
    path.join(P, "Microsoft", "Windows", "WER", "ReportQueue")];
  for (const d of [...dirs, LA, RA]) fs.mkdirSync(d, { recursive: true });
  const victim = path.join(t, "victim");
  const precious = mk(path.join(victim, "precious.txt"), 30, "keep");
  const env = { LOCALAPPDATA: LA, APPDATA: RA, SystemRoot: W, ProgramData: P, SystemDrive: "C:" };
  const gate = adminGateForTests({ windowsDir: W, programDataDir: P });
  return { t, W, P, LA, dirs, victim, precious, env, gate, cleanup: () => fs.rmSync(t, { recursive: true, force: true }) };
}
// Real-process SystemRoot/ProgramData point at the stand-ins only while fn runs (so they count as system folders).
async function withEnv(env, fn) {
  const saved = { SystemRoot: process.env.SystemRoot, ProgramData: process.env.ProgramData };
  try { Object.assign(process.env, env); return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const scanAs = (s, elevated, extra = {}) => withEnv({ SystemRoot: s.W, ProgramData: s.P }, () =>
  smartScan({ env: s.env, sid: SID, now: NOW, isLocked: () => false, locations: ADMIN_IDS.map(byId), checkPathFn: s.gate.checkPath, elevated, ...extra }));

test("standard mode: adminCleanable locations are report-only with size; elevated: offered with adminContents true", { skip }, async () => {
  const s = standIn();
  try {
    const [temp, mini, arch, queue] = s.dirs;
    const files = [mk(path.join(temp, "a.tmp"), 30, "12345"), mk(path.join(mini, "Mini1.dmp"), 30, "123"), mk(path.join(arch, "r1.wer"), 30, "1"),
      mk(path.join(queue, "q1.wer"), 30, "12")];
    mk(path.join(mini, "notes.txt"), 30, "1234567");           // minidump keeps its .dmp match
    mk(path.join(temp, "young.tmp"), 2);                       // too new
    // standard: four report-only folders with their sizes (no files offered)
    const std = await scanAs(s, false);
    assert.equal(std.items.length, 4);
    for (const i of std.items) { assert.equal(i.group, "report-only"); assert.equal(i.selectable, false); assert.equal(i.kind, "dir"); }
    assert.deepEqual(std.items.map(i => i.path), s.dirs);
    assert.deepEqual(std.allowedRoots, []);
    assert.equal(std.adminExtraBytes, 5 + 1 + 3 + 1 + 2);
    // elevated: exactly the old direct-child files, as high-confidence file findings; bases join allowedRoots
    const el = await scanAs(s, true);
    assert.deepEqual(el.items.map(i => i.path).sort(), [...files].sort());
    for (const i of el.items) {
      assert.equal(i.kind, "file"); assert.equal(i.group, "exclusive"); assert.equal(i.confidence, "high"); assert.equal(i.selectable, true);
      assert.ok(s.dirs.some(d => path.dirname(i.path) === d), i.path);
    }
    assert.deepEqual([...el.allowedRoots].sort(), [...s.dirs].sort());
    assert.equal(el.adminExtraBytes, null);
    // the flag really reaches the gate: with the same stand-in gate and no flag, these are system-folder paths
    await withEnv({ SystemRoot: s.W, ProgramData: s.P }, () => {
      for (const f of files) {
        assert.equal(s.gate.checkPath(f, { allowedRoots: [path.dirname(f)] }).reason, "system folder");
        assert.equal(s.gate.checkPath(f, { allowedRoots: [path.dirname(f)], adminContents: true }).ok, true);
      }
    });
    // a strict boolean: anything but true is the standard scan
    for (const v of ["true", 1, {}]) assert.ok((await scanAs(s, v)).items.every(i => i.group === "report-only"), String(v));
    for (const f of files) assert.ok(fs.existsSync(f), "the scan never deletes");
  } finally { s.cleanup(); }
});

test("elevated R36: subfolders are never offered or walked, junction and symlink children are never followed", { skip }, async () => {
  const s = standIn();
  const temp = s.dirs[0];
  const j = path.join(temp, "evil"), sl = path.join(temp, "link.tmp");
  try {
    const keep = mk(path.join(temp, "ok.tmp"));
    mk(path.join(temp, "sub", "deep.tmp"));
    mk(path.join(temp, "sub2", "deeper", "x.tmp"));
    junction(s.victim, j);
    let fileLink = false;
    try { fs.symlinkSync(s.precious, sl, "file"); fileLink = true; } catch { /* needs Developer Mode or admin */ }
    const el = await scanAs(s, true);
    assert.deepEqual(el.items.map(i => i.path), [keep]);
    assert.ok(el.items.every(i => i.kind === "file"));
    assert.ok(el.notes.some(n => n.includes("2 folders " + FOLDER_NOTE)), JSON.stringify(el.notes));
    assert.ok(!el.items.some(i => i.path === j || i.path === sl || i.path.startsWith(path.join(temp, "sub"))));
    assert.equal(fs.readFileSync(s.precious, "utf8"), "keep");
    if (fileLink) assert.ok(!el.items.some(i => i.path === sl));
  } finally { unJunction(j); try { fs.unlinkSync(sl); } catch { /* none */ } s.cleanup(); }
});

test("elevated: wu-download and other users' recycle bins stay report-only with their notes", { skip }, async () => {
  const s = standIn();
  try {
    mk(path.join(s.W, "SoftwareDistribution", "Download", "abc", "u.cab"), 30, "1234");
    mk(path.join(s.LA, "RB", "S-1-5-21-9-9-9-500", "$Rabc.txt"), 30, "12");
    const locations = [byId("wu-download"), { ...byId("other-recycle"), base: "%LOCALAPPDATA%\\RB" }];
    for (const elevated of [true, false]) {
      const r = await scanAs(s, elevated, { locations });
      assert.equal(r.items.length, 2);
      for (const i of r.items) { assert.equal(i.group, "report-only"); assert.equal(i.selectable, false); }
      if (elevated) {
        assert.ok(r.notes.some(n => n === "Windows Update downloads: left alone: needs a stopped Windows service"), JSON.stringify(r.notes));
        assert.ok(r.notes.some(n => n === "Other users' Recycle Bins: other users' files are never removed"), JSON.stringify(r.notes));
      }
    }
  } finally { s.cleanup(); }
});

test("R41: elevated, per-user locations are report-only (not walked) with their note; standard mode unchanged", { skip }, async () => {
  const s = standIn();
  try {
    const userTemp = path.join(s.LA, "Temp");
    const uf = mk(path.join(userTemp, "old.tmp"), 30, "abc");
    mk(path.join(userTemp, "olddir", "x.tmp"), 30);
    const af = mk(path.join(s.dirs[0], "a.tmp"));
    const RB = { ...byId("recycle-bin"), base: "%LOCALAPPDATA%\\RB\\%SID%" };
    mk(path.join(s.LA, "RB", SID, "$Rabc.txt"), 30); mk(path.join(s.LA, "RB", SID, "$Iabc.txt"), 30);
    const locations = [byId("user-temp"), RB, byId("thumbcache"), ...ADMIN_IDS.map(byId)];
    const el = await scanAs(s, true, { locations });
    assert.deepEqual(el.items.filter(i => i.selectable).map(i => i.path), [af]);
    const userItems = el.items.filter(i => i.path && (i.path.startsWith(s.LA + path.sep)));
    assert.deepEqual(userItems.map(i => i.path).sort(), [userTemp, path.join(s.LA, "RB", SID)].sort());
    for (const i of userItems) { assert.equal(i.group, "report-only"); assert.equal(i.bytes, null, "not walked"); assert.equal(i.kind, "dir"); }
    for (const label of ["Temporary files", "Recycle Bin", "Thumbnail and icon cache"])
      assert.ok(el.notes.includes(`${label}: left alone in administrator mode: use standard mode for your own files`), label + JSON.stringify(el.notes));
    assert.deepEqual(el.allowedRoots, [s.dirs[0]]);
    // standard mode: the per-user files are offered exactly as before, administrator folders report-only
    const std = await scanAs(s, false, { locations });
    assert.ok(std.items.some(i => i.path === uf && i.selectable));
    assert.ok(!std.items.some(i => i.path === af));
    assert.ok(!std.notes.some(n => n.includes("left alone in administrator mode")));
  } finally { s.cleanup(); }
});

test("elevated scan + real gate: a finding outside adminContentDirs is refused even with the flag", { skip }, async () => {
  // Read-only probe: C:\Windows\win.ini is an old file directly in a system folder that is NOT on the list.
  // isLocked is faked so the file is never even opened; nothing is written anywhere.
  const env = { ...process.env };
  const probe = [{ id: "probe", label: "Probe", scope: "system", base: "%SystemRoot%", match: /^win\.ini$/i, adminCleanable: true, reason: "probe" }];
  const r = await smartScan({ env, sid: SID, isLocked: () => false, locations: probe, elevated: true });
  assert.ok(!r.items.some(i => i.selectable), JSON.stringify(r.items));
  assert.deepEqual(r.allowedRoots, []);
  assert.equal(checkPath("C:\\Windows\\win.ini", { allowedRoots: ["C:\\Windows"], adminContents: true }).reason, "system folder");
  // and the same scan run against the stand-ins with the real gate offers nothing either (env does not match C:\Windows)
  const s = standIn();
  try {
    mk(path.join(s.dirs[0], "a.tmp"));
    const r2 = await withEnv({ SystemRoot: s.W, ProgramData: s.P }, () =>
      smartScan({ env: s.env, sid: SID, now: NOW, isLocked: () => false, locations: ADMIN_IDS.map(byId), elevated: true }));
    assert.ok(!r2.items.some(i => i.selectable));
  } finally { s.cleanup(); }
});

test("table adminCleanable bases equal adminContentDirs() exactly", { skip }, () => {
  const vars = { SystemRoot: process.env.SystemRoot, ProgramData: process.env.ProgramData, SystemDrive: process.env.SystemDrive };
  const bases = LOCATIONS.filter(l => l.adminCleanable).flatMap(l => expandBase(l.base, vars, l.profile));
  assert.deepEqual(bases.map(b => b.toLowerCase()), adminContentDirs().map(d => d.toLowerCase()));
  assert.deepEqual(LOCATIONS.filter(l => l.adminCleanable).map(l => l.id), ADMIN_IDS);
  for (const l of LOCATIONS.filter(l => l.adminCleanable)) assert.equal(l.needsStoppedService, undefined, l.id);
});

// Every source file of the app (tests excluded: they name the strings to look for them).
function sourceFiles() {
  const root = path.join(here, "..");
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if ([".git", "node_modules", "test", "docs", ".claude", ".superpowers", "vendor", "release", "dist"].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|cjs|js|html|ps1|cmd|bat|json)$/i.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}
test("no service is stopped anywhere: no 'Stop-Service', 'sc.exe', 'net stop' in the code base", () => {
  const files = sourceFiles();
  assert.ok(files.some(f => f.endsWith("elevation.mjs")) && files.some(f => f.endsWith("smartscan.mjs")));
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/Stop-Service|\bsc\.exe|net(\.exe)?\s+stop|Set-Service|StopService/i.test(src), f);
  }
});

// ---- delete step: defence in depth (R36 layer 3) ----
function plainTree() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "admin-del-"));
  const admin = path.join(t, "AdminTemp");
  const victim = path.join(t, "victim");
  fs.mkdirSync(admin, { recursive: true });
  const precious = mk(path.join(victim, "precious.txt"), 30, "keep");
  return { t, admin, victim, precious, cleanup: () => fs.rmSync(t, { recursive: true, force: true }) };
}
test("delete step: never removes or walks a folder under an administrator folder; files and links are removed as themselves", { skip }, () => {
  const s = plainTree();
  const j = path.join(s.admin, "evil");
  try {
    const sub = path.join(s.admin, "sub");
    const deep = mk(path.join(sub, "deep.tmp"));
    const f = mk(path.join(s.admin, "a.tmp"));
    const hooks = { adminDirs: () => [s.admin] };
    const check = { allowedRoots: [s.admin], adminContents: true };
    const r = removeItem(sub, check, hooks);
    assert.equal(r.status, "skipped"); assert.equal(r.reason, "folders are not removed in administrator mode");
    assert.ok(fs.existsSync(deep));
    assert.equal(removeItem(sub, { allowedRoots: [s.admin] }, hooks).status, "skipped"); // with or without the flag
    assert.throws(() => removeTreeGuarded(sub, check, hooks), e => e.code === "ADMIN_FOLDER");
    // a parent of an administrator folder is not walked into it either (pass 1 refuses before anything is deleted)
    assert.throws(() => removeTreeGuarded(s.t, { allowedRoots: [path.dirname(s.t)] }, { adminDirs: () => [s.admin] }), e => e.code === "ADMIN_FOLDER");
    assert.ok(fs.existsSync(deep) && fs.existsSync(f) && fs.existsSync(s.precious));
    // Fix round 1 (I2): a nested FILE under an administrator folder is refused too (only direct children), flag or not
    for (const c of [check, { allowedRoots: [s.admin] }, { allowedRoots: [sub], adminContents: true }]) {
      const rn = removeItem(deep, c, hooks);
      assert.equal(rn.status, "skipped", JSON.stringify(c)); assert.equal(rn.reason, "only files directly inside an administrator folder are removed");
    }
    // the folder itself (were it ever to pass the gate) is refused as a folder
    assert.equal(removeItem(s.admin, { allowedRoots: [s.t] }, hooks).reason, "folders are not removed in administrator mode");
    assert.ok(fs.existsSync(deep));
    // a direct-child file is removed (case of the listed folder does not matter)
    assert.equal(removeItem(mk(path.join(s.admin, "b.tmp")), check, { adminDirs: () => [s.admin.toUpperCase()] }).status, "deleted");
    assert.equal(removeItem(f, check, hooks).status, "deleted");
    assert.ok(!fs.existsSync(f));
    // a junction child is never followed: refused as a link, its target untouched
    junction(s.victim, j);
    assert.equal(removeItem(j, check, hooks).status, "skipped");
    assert.equal(removeItem(path.join(j, "precious.txt"), check, hooks).status, "skipped");
    assert.equal(fs.readFileSync(s.precious, "utf8"), "keep");
    // normal mode, outside any administrator folder: folders are still removed as before
    const other = path.join(s.t, "other");
    mk(path.join(other, "x", "y.tmp"));
    assert.equal(removeItem(other, { allowedRoots: [s.t] }, hooks).status, "deleted");
    assert.ok(!fs.existsSync(other));
  } finally { unJunction(j); s.cleanup(); }
});
test("delete step defaults: the real adminContentDirs is the guard list unless a test passes its own", { skip }, () => {
  // M2: behavioural. The defaults are the real function itself (not a copy and not a widened list) ...
  assert.equal(DELETE_DEFAULTS.adminDirs, adminContentDirs);
  assert.equal(TREE_DEFAULTS.adminDirs, adminContentDirs);
  assert.ok(Object.isFrozen(DELETE_DEFAULTS) && Object.isFrozen(TREE_DEFAULTS));
  // ... and with the defaults a guarded tmp tree behaves like any normal folder (not under the real list) ...
  const s = plainTree();
  try {
    const nested = mk(path.join(s.admin, "sub", "n.tmp"));
    assert.equal(removeItem(path.join(s.admin, "sub"), { allowedRoots: [s.admin] }).status, "deleted");
    assert.ok(!fs.existsSync(nested));
    // ... while the same tree is guarded as soon as it is on the list (the guard is reached through the hook)
    const n2 = mk(path.join(s.admin, "sub2", "n.tmp"));
    assert.equal(removeItem(n2, { allowedRoots: [s.admin] }, { adminDirs: () => [s.admin] }).status, "skipped");
    assert.equal(removeItem(path.join(s.admin, "sub2"), { allowedRoots: [s.admin] }, { adminDirs: () => [s.admin] }).status, "skipped");
    assert.ok(fs.existsSync(n2));
  } finally { s.cleanup(); }
  // read-only probe on the real folder: nothing exists there under this name, so nothing is touched
  const p = "C:\\Windows\\Temp\\nuke-probe-" + crypto.randomBytes(6).toString("hex");
  assert.equal(removeItem(p, { allowedRoots: ["C:\\Windows\\Temp"], adminContents: true }).reason, "already gone");
});

// ---- frozen run: strict flag, revalidate, audit ----
test("startFrozenRun: adminContents must be a strict boolean; revalidate honours the flag", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-sfr-"));
  try {
    const a = mk(path.join(root, "a.txt"));
    const map = { sessionId: "S", allowedRoots: [root], protectedPaths: [], livePaths: [],
      items: [{ id: "aa", path: a, kind: "file", bytes: 1, group: "exclusive", reason: "r", sharedWith: [] }] };
    const sel = buildSelection(map, ["aa"]);
    const fake = seen => o => { Object.assign(seen, o); return { runId: "r1", listen: async () => ({ url: "http://127.0.0.1:4321/?t=x" }), close() {} }; };
    for (const v of ["true", 1, 0, null, {}, [true], new Boolean(true)]) {
      const seen = {};
      await assert.rejects(startFrozenRun(sel, { runDir: path.join(root, "run" + crypto.randomBytes(3).toString("hex")), scanStartMs: Date.now(), createServer: fake(seen), adminContents: v }), /adminContents/, String(v));
      assert.equal(seen.adminContents, undefined);
    }
    for (const [v, want] of [[true, true], [false, false], [undefined, false]]) {
      const seen = {};
      const runDir = path.join(root, "ok" + crypto.randomBytes(3).toString("hex"));
      await startFrozenRun(sel, { runDir, scanStartMs: Date.now(), createServer: fake(seen), adminContents: v });
      assert.equal(seen.adminContents, want);
    }
    revalidate(sel); revalidate(sel, { adminContents: true }); revalidate(sel, { adminContents: false });
    assert.throws(() => revalidate(sel, { adminContents: "true" }), /adminContents/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("revalidate with adminContents lifts the system refusal only on the list (read-only probe)", { skip }, () => {
  const p = "C:\\Windows\\Temp\\nuke-probe-" + crypto.randomBytes(6).toString("hex");
  const sel = { allowedRoots: ["C:\\Windows\\Temp"], protectedPaths: [], livePaths: [], paths: [p] };
  assert.throws(() => revalidate(sel), /system folder/);
  assert.throws(() => revalidate(sel, { adminContents: true }), /does not exist/);
});

test("server: the 'started' audit line records adminContents", async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "admin-audit-"));
  try {
    for (const flag of [false, true]) {
      const target = mk(path.join(t, "junk" + flag + ".tmp"));
      const sel = { sessionId: "S", allowedRoots: [t], protectedPaths: [], livePaths: [], paths: [target] };
      sel.sha256 = selectionHash(sel);
      const selectionFile = path.join(t, "selection.json"); fs.writeFileSync(selectionFile, JSON.stringify(sel));
      const pageFile = path.join(t, "page.html"); fs.writeFileSync(pageFile, "<html>page</html>");
      const soundsDir = path.join(t, "sounds"); fs.mkdirSync(soundsDir, { recursive: true });
      const auditFile = path.join(t, "audit-" + flag + ".log");
      const srv = createCleanupServer({ selectionFile, pageFile, soundsDir, auditFile, minGapMs: 0, afterDoneMs: 10, adminContents: flag, ageCheckOffForTests: true });
      try {
        const { port } = await srv.listen();
        const post = p => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, "X-Nuke-Token": srv.token }, body: "{}" });
        assert.equal((await post("/unlock")).status, 200);
        assert.equal((await post("/confirm")).status, 200);
        for (let i = 0; i < 200 && srv.getState() !== "done"; i++) await new Promise(r => setTimeout(r, 10));
      } finally { srv.close(); }
      const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
      const started = lines.find(l => l.state === "started");
      assert.equal(started.adminContents, flag);
    }
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
