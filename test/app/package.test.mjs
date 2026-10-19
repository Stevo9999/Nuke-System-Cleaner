import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageTarget, PACKAGER_IGNORE, run, PACKAGER_HINT } from "../../scripts/package.mjs";
import { appProtectedPaths, appProtectedRoots, violatesRoots } from "../../app/main/appdata.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
const rd = (rel) => fs.readFileSync(new URL("../../" + rel, import.meta.url), "utf8");

test("packageTarget: <LOCALAPPDATA>\\Programs\\Nuke-Uninstaller\\<version>", () => {
  assert.equal(packageTarget({ LOCALAPPDATA: "C:\\Users\\Me\\AppData\\Local" }, "1.2.3"), "C:\\Users\\Me\\AppData\\Local\\Programs\\Nuke-Uninstaller\\1.2.3");
});

test("packageTarget: bad versions and bad LOCALAPPDATA throw", () => {
  const env = { LOCALAPPDATA: "C:\\L" };
  for (const v of ["1.2", "1.2.3.4", "v1.2.3", "1.2.3-beta", "..", "1.2.3\\..", "", " 1.2.3", "1.2.3\n", "01.2.3x", null, undefined, 123, {}])
    assert.throws(() => packageTarget(env, v), TypeError, String(v));
  for (const e of [{}, null, undefined, { LOCALAPPDATA: "" }, { LOCALAPPDATA: "rel\\path" }, { LOCALAPPDATA: "\\\\server\\share" }, { LOCALAPPDATA: "C:\\a\u0000b" }, { LOCALAPPDATA: 5 }])
    assert.throws(() => packageTarget(e, "1.2.3"), TypeError, JSON.stringify(e));
});

test("packageTarget rejects '..' segments in LOCALAPPDATA", () => {
  for (const l of ["C:\\Users\\Me\\..\\Other", "C:\\..", "C:\\a/../b"]) assert.throws(() => packageTarget({ LOCALAPPDATA: l }, "1.2.3"), TypeError, l);
});

test("run: an existing dist\\Nuke-Uninstaller-win32-x64 gives a clear error before packaging and is left alone", async () => {
  const root = tmp(), local = tmp();
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    const stale = path.join(root, "dist", "Nuke-Uninstaller-win32-x64");
    fs.mkdirSync(stale, { recursive: true }); fs.writeFileSync(path.join(stale, "old.txt"), "old");
    await assert.rejects(run({ root, env: { LOCALAPPDATA: local }, loadPackager: async () => async () => assert.fail("must not package") }), /build folder already exists.*never deletes/);
    assert.equal(fs.readFileSync(path.join(stale, "old.txt"), "utf8"), "old");
    assert.equal(fs.existsSync(path.join(local, "Programs")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(local, { recursive: true, force: true }); }
});

test("PACKAGER_IGNORE drops tests, fixtures, docs, out, dist, .git, .superpowers, scripts, the old css page; keeps what the app needs", () => {
  const dropped = (p) => PACKAGER_IGNORE.some((re) => re.test(p));
  for (const p of ["/test", "/test/x.mjs", "/fixture/sandbox/a", "/docs/superpowers/x.md", "/out/nuke.lock", "/dist/x", "/.git", "/.git/config",
    "/.superpowers/sdd/a.md", "/scripts/package.mjs", "/index-v1-css.html"]) assert.ok(dropped(p), p + " must be dropped");
  for (const p of ["/package.json", "/run.mjs", "/scan.mjs", "/server.mjs", "/cleanup.html", "/index.html", "/lib/safepath.mjs", "/app/main/main.mjs",
    "/app/preload/preload.cjs", "/app/renderer/index.html", "/vendor/three.module.js", "/sounds/a.mp3", "/README.md", "/testing.mjs", "/outer/x", "/distance.mjs", "/node_modules/x"])
    assert.ok(!dropped(p), p + " must be kept");
  assert.ok(PACKAGER_IGNORE.every((re) => re instanceof RegExp));
});

test("run: lazy packager, asar false / win32 / x64 / out dist, copies to the target, prints the exe, refuses an existing target and never deletes", async () => {
  const root = tmp(), local = tmp(), logs = [];
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "2.3.4" }));
    const calls = [];
    const built = path.join(root, "dist", "Nuke-Uninstaller-win32-x64");
    const fakePackager = async (opts) => {
      calls.push(opts);
      fs.mkdirSync(path.join(built, "resources", "app"), { recursive: true });
      fs.writeFileSync(path.join(built, "Nuke-Uninstaller.exe"), "exe");
      fs.writeFileSync(path.join(built, "resources", "app", "a.txt"), "a");
      return [built];
    };
    const r = await run({ root, env: { LOCALAPPDATA: local }, loadPackager: async () => fakePackager, log: (s) => logs.push(s) });
    assert.equal(r.target, path.win32.join(local, "Programs", "Nuke-Uninstaller", "2.3.4"));
    assert.equal(calls.length, 1);
    const o = calls[0];
    assert.equal(o.asar, false); assert.equal(o.platform, "win32"); assert.equal(o.arch, "x64"); assert.equal(o.name, "Nuke-Uninstaller");
    assert.equal(o.dir, root); assert.equal(o.out, path.join(root, "dist"));
    assert.deepEqual(o.ignore, [...PACKAGER_IGNORE]);
    assert.equal(fs.readFileSync(path.join(r.target, "resources", "app", "a.txt"), "utf8"), "a");
    assert.equal(r.exe, path.win32.join(r.target, "Nuke-Uninstaller.exe"));
    assert.ok(logs.some((l) => l.includes(r.exe)));
    // second run: refused before the packager is even loaded; existing files untouched
    fs.writeFileSync(path.join(r.target, "keep.txt"), "keep");
    await assert.rejects(run({ root, env: { LOCALAPPDATA: local }, loadPackager: async () => assert.fail("must not load") }), /already exists/);
    assert.equal(fs.readFileSync(path.join(r.target, "keep.txt"), "utf8"), "keep");
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(local, { recursive: true, force: true }); }
});

test("run: a missing packager gives the install hint; a bad package.json version or a packager returning odd output is refused; nothing is created", async () => {
  const root = tmp(), local = tmp();
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    await assert.rejects(run({ root, env: { LOCALAPPDATA: local }, loadPackager: async () => { throw new Error("Cannot find package"); } }), (e) => e.message === PACKAGER_HINT);
    for (const bad of [[], ["a", "b"], null, [5]])
      await assert.rejects(run({ root, env: { LOCALAPPDATA: local }, loadPackager: async () => async () => bad }), /exactly one output folder/);
    assert.equal(fs.existsSync(path.join(local, "Programs")), false, "nothing created");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "latest" }));
    await assert.rejects(run({ root, env: { LOCALAPPDATA: local }, loadPackager: async () => assert.fail("no") }), TypeError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(local, { recursive: true, force: true }); }
});

test("scripts/package.mjs: lazy import only, no process start, no delete calls, no network", () => {
  const src = rd("scripts/package.mjs").replace(/\/\/.*$/gm, "");
  assert.ok(!/^\s*import[^\n]*@electron\/packager/m.test(src), "no static import of the packager");
  assert.equal((src.match(/import\(\s*"@electron\/packager"\s*\)/g) || []).length, 1);
  assert.ok(!/child_process|\bspawn|\bexec|rmSync|unlinkSync|rmdirSync|\brm\(|\bfetch\(|https?:/.test(src));
});

test("package.json: script 'package' present, no unlocked packager dependency, version matches the lockfile root", () => {
  const pkg = JSON.parse(rd("package.json"));
  assert.equal(pkg.scripts.package, "node scripts/package.mjs");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(rd("package-lock.json"));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  // a dependency added to package.json without a lockfile update breaks `npm ci`
  for (const k of Object.keys(pkg.devDependencies || {})) {
    assert.ok(lock.packages[""].devDependencies && lock.packages[""].devDependencies[k] === pkg.devDependencies[k], k + " must be in the lockfile");
    assert.match(pkg.devDependencies[k], /^\d+\.\d+\.\d+$/, k + " pinned exactly");
  }
});

test("packaged mode protects the exe folder and the data root", () => {
  const exeDir = "C:\\Users\\Me\\AppData\\Local\\Programs\\Nuke-Uninstaller\\0.1.0\\resources\\app";
  const dataRoot = "C:\\Users\\Me\\AppData\\Local\\Nuke-Uninstaller";
  const home = "C:\\Users\\Me";
  const list = appProtectedPaths({ appDir: exeDir, dataRoot, home, env: {} }).map((p) => p.toLowerCase());
  assert.ok(list.includes(exeDir.toLowerCase()));
  assert.ok(list.includes(dataRoot.toLowerCase()));
  for (const n of ["app", "scripts", "lib", "run.mjs"]) assert.ok(list.some((p) => p.endsWith("\\" + n)), n + " is a protected tool path");
  // the install folder's ancestors (Programs, Local) are covered by the roots rule, never candidates themselves
  const roots = appProtectedRoots({ home, env: { LOCALAPPDATA: "C:\\Users\\Me\\AppData\\Local", APPDATA: "C:\\Users\\Me\\AppData\\Roaming" } });
  assert.ok(violatesRoots("C:\\Users\\Me\\AppData\\Local", roots));
});
