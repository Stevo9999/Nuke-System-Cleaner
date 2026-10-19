// Spawn inventory: pins EXACTLY which files can start a process, with what program and arguments, and that the README says so.
// A new importer of child_process, a new spawn site, an exec-style call, shell:true, or an exe path that comes from the
// environment in production code makes this test fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WINTOOLS } from "../lib/wintools.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "test", "fixture", "docs", "out", "dist", "release", ".git", ".superpowers", ".claude", "vendor"]);
const CODE_EXT = /\.(mjs|js|cjs|html)$/;

// The skipped folder names apply ONLY at the repository root (first path segment). A nested lib/vendor or app/test is shipped
// by the packager, so it is scanned like everything else.
export function walk(dir, rel = "", out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) { if (!(rel === "" && SKIP_DIRS.has(e.name)) && e.name !== "node_modules") walk(path.join(dir, e.name), r, out); }
    else if (e.isFile() && CODE_EXT.test(e.name)) out.push(r);
  }
  return out;
}
function walkAll(dir, rel, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel + "/" + e.name;
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "sandbox") walkAll(path.join(dir, e.name), r, out); }
    else if (e.isFile() && CODE_EXT.test(e.name)) out.push(r);
  }
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/\s.*$/gm, "");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel) => stripComments(read(rel));

const PRODUCTION = walk(ROOT).sort();
const importers = (files) => files.filter((f) => /child_process/.test(code(f))).sort();

const SPAWN_FILES = ["app/main/elevation.mjs", "lib/restore.mjs", "lib/sysread.mjs", "lib/uninstall-run.mjs", "lib/winapps.mjs", "lib/wintools.mjs", "run.mjs"];
const FIXTURE_IMPORTERS = ["fixture/launch-sandbox.mjs", "fixture/make-app-fixture.mjs", "fixture/make-fixture.mjs"];

// A reusable scan of a tree: which files import child_process, call spawn-like APIs, or use an unsafe form.
function findings(rootDir, files) {
  const out = [];
  for (const f of files) {
    const c = stripComments(fs.readFileSync(path.join(rootDir, f), "utf8"));
    if (/child_process/.test(c)) out.push(f + ": imports child_process");
    if (/(?<![.\w])(exec|execSync|execFile|execFileSync|fork|spawnSync)\s*\(/.test(c)) out.push(f + ": exec-style call");
    if (/\.(execSync|execFile|execFileSync|fork|spawnSync|spawn)\s*\(/.test(c) || /\b(cp|child|childProcess|child_process)\.exec\s*\(/.test(c)) out.push(f + ": member spawn call");
    for (const m of c.matchAll(/shell\s*:\s*([^,}\s]*)/g)) if (m[1] !== "false") out.push(f + ": shell is not the literal false");
    for (const m of c.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) if (!/^(["'])[^"'`$+]*\1$/.test(m[1].trim())) out.push(f + ": non-literal dynamic import");
    for (const m of c.matchAll(/\brequire\s*\(\s*([^)]*)\)/g)) if (!/^(["'])[^"'`$+]*\1$/.test(m[1].trim())) out.push(f + ": non-literal require");
    if (/createRequire/.test(c)) out.push(f + ": createRequire");
    if (f.startsWith("app/") && /\bshell\.(openPath|openExternal)\b|\bapp\.relaunch\s*\(|\butilityProcess\b/.test(c)) out.push(f + ": electron process/launch API");
  }
  return out;
}

test("inventory: the root-only skip rule still scans nested lib/vendor, app/test, scripts/dist and the like (temp tree)", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inv-"));
  try {
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true }); fs.writeFileSync(path.join(tmpRoot, rel), text); };
    put("test/ok.mjs", "import 'node:child_process';");            // root test/: skipped
    put("vendor/ok.mjs", "import 'node:child_process';");          // root vendor/: skipped
    put("lib/vendor/x.mjs", "import { spawn } from 'node:child_process';");
    put("app/test/y.mjs", "import cp from 'node:child_process'; cp.execSync('calc');");
    put("app/docs/z.js", "export const a = import('child_' + 'process');");
    put("lib/dist/w.mjs", "spawn(a, b, { shell: opts });");
    put("lib/out/v.mjs", "x = import(name);");
    const seen = walk(tmpRoot).sort();
    assert.deepEqual(seen, ["app/docs/z.js", "app/test/y.mjs", "lib/dist/w.mjs", "lib/out/v.mjs", "lib/vendor/x.mjs"]);
    const f = findings(tmpRoot, seen).join("\n");
    for (const want of ["lib/vendor/x.mjs: imports child_process", "app/test/y.mjs: member spawn call", "app/docs/z.js: non-literal dynamic import",
      "lib/dist/w.mjs: shell is not the literal false", "lib/out/v.mjs: non-literal dynamic import"]) assert.ok(f.includes(want), want + "\n" + f);
    // members, spreads and electron APIs
    put("app/main/e.mjs", "shell.openExternal(u); app.relaunch(); utilityProcess.fork(p);");
    put("lib/s.mjs", "const x = require(name); const y = createRequire(import.meta.url);");
    const g = findings(tmpRoot, ["app/main/e.mjs", "lib/s.mjs"]).join("\n");
    assert.ok(g.includes("electron process/launch API") && g.includes("non-literal require") && g.includes("createRequire"), g);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test("inventory: production has no unsafe forms beyond the pinned importers (members, shell values, dynamic imports, electron launch APIs)", () => {
  const bad = findings(ROOT, PRODUCTION).filter((x) => !(SPAWN_FILES.some((s) => x === s + ": imports child_process")));
  assert.deepEqual(bad, []);
});

test("inventory: the walker really sees the production files", () => {
  for (const f of ["run.mjs", "lib/sysread.mjs", "lib/restore.mjs", "app/main/elevation.mjs", "app/main/main.mjs", "app/renderer/results.js", "scripts/package.mjs", "app/preload/preload.cjs"])
    assert.ok(PRODUCTION.includes(f), f);
  assert.ok(!PRODUCTION.some((f) => f.startsWith("test/") || f.startsWith("vendor/")));
});

test("inventory: files importing child_process are exactly run.mjs, lib/sysread.mjs, lib/restore.mjs, lib/uninstall-run.mjs, lib/winapps.mjs, lib/wintools.mjs, app/main/elevation.mjs (+ fixture helpers)", () => {
  assert.deepEqual(importers(PRODUCTION), SPAWN_FILES);
  assert.deepEqual(importers(walkAll(path.join(ROOT, "fixture"), "fixture")), FIXTURE_IMPORTERS);
  // the vendored page library and the scripts folder start nothing either
  assert.deepEqual(importers(walkAll(path.join(ROOT, "vendor"), "vendor")), []);
  // no other way to reach it
  for (const f of PRODUCTION) {
    const c = code(f);
    assert.ok(!/require\(\s*["'](node:)?child_process["']\s*\)/.test(c), f + " must not require child_process");
    assert.ok(!/process\.binding|process\.dlopen/.test(c), f + " must not use process.binding or dlopen");
  }
});

test("inventory: no exec-style call, no shell:true, no fork/spawnSync, exactly one spawn site per spawning file (all with shell: false)", () => {
  for (const f of PRODUCTION) {
    const c = code(f);
    assert.ok(!/(?<![.\w])(exec|execSync|execFile|execFileSync|fork|spawnSync)\s*\(/.test(c), f + " must not call exec/fork/spawnSync");
    assert.ok(!/shell\s*:\s*(true|["'`])/.test(c), f + " must not use shell:true or a shell string");
    if (!SPAWN_FILES.includes(f)) assert.ok(!/\bspawn(Fn)?\s*\(/.test(c), f + " must not start a process");
  }
  for (const f of SPAWN_FILES) {
    const c = code(f);
    assert.equal((c.match(/\bspawnFn\s*\(/g) || []).length, 1, f + ": exactly one spawn call site");
    assert.equal((c.match(/(?<![.\w])spawn\s*\(/g) || []).length, 0, f + ": spawn is only ever reached through spawnFn");
    assert.equal((c.match(/shell\s*:\s*false/g) || []).length, 1, f + ": that site has shell: false");
    assert.match(c, /\bspawnFn\s*=\s*spawn\b/, f + ": spawnFn defaults to child_process.spawn");
  }
});

test("inventory: every exe is a fixed C:\\Windows\\System32 path: no environment value can reach an exe path", () => {
  for (const f of SPAWN_FILES) {
    const c = code(f);
    if (f === "run.mjs") {
      // run.mjs reads CLAUDE_CONFIG_DIR elsewhere; the browser opener itself and any other process-related env are what is pinned
      const fn = /export function openDefaultBrowser[\s\S]*?\n}\n/.exec(c);
      assert.ok(fn, "openDefaultBrowser found");
      assert.ok(!/process\.env|\benv\b/.test(fn[0]), "the browser opener must not read the environment");
      assert.ok(!/process\.env\.(SystemRoot|windir|PATH|PATHEXT|ComSpec)|NUKE_TEST/i.test(c), "run.mjs must not read SystemRoot/windir/PATH/ComSpec or a test override from the environment");
      continue;
    }
    assert.ok(!/process\.env|\benv\b|\bprocess\s*\[|\bglobalThis\.process\b/.test(c), f + " must not read the environment in any form (dot, bracket or destructured)");
    assert.ok(!/\bSystemRoot\b|\bwindir\b|\bPATH\b|\bpathext\b/i.test(c.replace(/\bsystemRoot\b/g, "").replace(/\bpath\b/g, "")), f + " must not mention SystemRoot, windir or PATH in code");
  }
  // the fixed root and where each default lives
  assert.match(code("lib/sysread.mjs"), /export const FIXED_SYSTEM_ROOT = "C:\\\\Windows";/);
  assert.match(code("lib/sysread.mjs"), /systemRoot = FIXED_SYSTEM_ROOT/);
  assert.match(code("lib/sysread.mjs"), /const exe = path\.join\(systemRoot, "System32", exeName\);/);
  for (const f of ["lib/restore.mjs", "app/main/elevation.mjs"]) {
    assert.match(code(f), /systemRoot = "C:\\\\Windows"/, f);
    assert.match(code(f), /const psExe = systemRoot \+ "\\\\System32\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe";/, f);
  }
  assert.match(code("lib/uninstall-run.mjs"), /systemRoot = "C:\\\\Windows"/);
  assert.match(code("lib/uninstall-run.mjs"), /const psExe = systemRoot \+ "\\\\System32\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe";/);
  assert.match(code("lib/winapps.mjs"), /systemRoot = "C:\\\\Windows"/);
  assert.match(code("lib/winapps.mjs"), /const exe = systemRoot \+ "\\\\System32\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe";/);
  assert.match(code("run.mjs"), /systemRoot = "C:\\\\Windows"/);
  assert.match(code("run.mjs"), /const exe = path\.join\(systemRoot, "System32", "rundll32\.exe"\);/);
  // nobody else passes a root in: only the four files above mention the lowercase option name
  for (const f of PRODUCTION.filter((x) => !SPAWN_FILES.includes(x))) assert.ok(!/\bsystemRoot\b/.test(code(f)), f + " must not pass a systemRoot");
  // and the callers of the spawn functions do not set spawnFn either
  for (const f of PRODUCTION.filter((x) => !SPAWN_FILES.includes(x))) assert.ok(!/\bspawnFn\b/.test(code(f)), f + " must not inject spawnFn");
});

test("inventory: the exact programs and argument lists", () => {
  const sys = code("lib/sysread.mjs");
  assert.deepEqual([...sys.matchAll(/runTool\(\s*"([^"]+)"/g)].map((m) => m[1]).sort(), ["reg.exe", "schtasks.exe", "whoami.exe", "whoami.exe"]);
  assert.ok(sys.includes('runTool("reg.exe", ["query", k.path, ...k.args], opts)'));
  assert.ok(sys.includes('runTool("schtasks.exe", ["/query", "/fo", "csv", "/v", "/nh"], opts)'));
  assert.ok(sys.includes('runTool("whoami.exe", ["/user", "/fo", "csv", "/nh"], opts)'));
  assert.ok(sys.includes('runTool("whoami.exe", ["/groups", "/fo", "csv", "/nh"], opts)'));
  assert.ok(sys.includes("spawnFn(exe, args, { shell: false"));
  assert.ok(code("lib/winapps.mjs").includes('spawnFn(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(script)], { shell: false'));
  assert.ok(code("lib/uninstall-run.mjs").includes('spawnFn(psExe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { shell: false'));
  assert.ok(code("lib/wintools.mjs").includes("spawnFn(LAUNCHER, launchArgs(key), { shell: false, detached: true, stdio: \"ignore\" })"));
  assert.ok(code("lib/wintools.mjs").includes('const LAUNCHER = S + "rundll32.exe";') && code("lib/wintools.mjs").includes('const S = "C:\\\\Windows\\\\System32\\\\";'));
  assert.ok(code("lib/wintools.mjs").includes('["shell32.dll,ShellExec_RunDLL", WINTOOLS[key].exe, ...WINTOOLS[key].args]'));
  assert.ok(code("run.mjs").includes('spawnFn(exe, ["url.dll,FileProtocolHandler", url], { shell: false, detached: true'));
  for (const f of ["lib/restore.mjs", "app/main/elevation.mjs"]) assert.ok(code(f).includes('spawnFn(psExe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { shell: false'), f);
  // the twelve registry keys are all HK* paths in one frozen table
  const keys = [...sys.matchAll(/mk\("(HK[A-Z]+)\\\\/g)].map((m) => m[1]);
  assert.equal(keys.length, 12);
  // the restart check (read-only): exactly this key table entry, no new spawn site
  assert.ok(sys.includes('pendingRenames: mk("HKLM\\\\SYSTEM\\\\CurrentControlSet\\\\Control\\\\Session Manager", ["/v", "PendingFileRenameOperations"]),'));
  assert.ok(README.includes("twelve fixed keys") && README.includes("PendingFileRenameOperations"));
  // the two known-folder reads (read-only, fixed): exactly these paths and arguments, nothing built from input
  assert.ok(sys.includes('userShellFolders: mk("HKCU\\\\SOFTWARE" + CV + "Explorer\\\\User Shell Folders"),'));
  assert.ok(sys.includes('oneDriveAccounts: mk("HKCU\\\\SOFTWARE\\\\Microsoft\\\\OneDrive\\\\Accounts", ["/s", "/v", "UserFolder"]),'));});

// ---- README ----
const README = read("docs/TECHNICAL.md");
const SPAWN_TABLE = [
  ["rundll32.exe", "run.mjs"], ["reg.exe", "lib/sysread.mjs"], ["schtasks.exe", "lib/sysread.mjs"], ["whoami.exe", "lib/sysread.mjs"],
  ["powershell.exe", "lib/restore.mjs"], ["powershell.exe", "app/main/elevation.mjs"], ["powershell.exe", "lib/winapps.mjs"],
  ["powershell.exe", "lib/uninstall-run.mjs"],
  ["rundll32.exe", "lib/wintools.mjs"],
];

test("inventory: README names every spawned exe and its file, with its exact arguments", () => {
  const lines = README.split("\n");
  for (const [exe, file] of SPAWN_TABLE) {
    assert.ok(lines.some((l) => l.startsWith("|") && l.includes("`" + file + "`") && l.includes(exe)), exe + " / " + file);
  }
  for (const frag of ["url.dll,FileProtocolHandler", "query <key>", "/s /v ImagePath", "/query /fo csv /v /nh", "/user /fo csv /nh", "/groups /fo csv /nh",
    "-NoProfile -NonInteractive -EncodedCommand <base64>", "shell: false", "C:\\Windows", "never read from `%SystemRoot%`"])
    assert.ok(README.includes(frag), frag);
  // no program is named in the table that the code does not start
  const named = new Set(lines.filter((l) => l.startsWith("| `")).map((l) => /^\| `([^`]+)`/.exec(l)[1].split("\\").pop()));
  assert.deepEqual([...named].sort(), ["powershell.exe", "reg.exe", "rundll32.exe", "schtasks.exe", "whoami.exe"]);
  // the rundll32 row for lib/wintools.mjs carries the exact launch form, and every program the launcher can be asked to start
  // (and each snap-in) is named in the README
  const row = lines.find((l) => l.startsWith("| `rundll32.exe`") && l.includes("`lib/wintools.mjs`"));
  assert.ok(row && row.includes("shell32.dll,ShellExec_RunDLL"));
  for (const t of Object.values(WINTOOLS)) {
    assert.ok(README.includes("`" + t.exe.split("\\").pop() + "`"), t.exe);
    for (const a of t.args) assert.ok(README.includes(a.split("\\").pop()), a);
  }
});

test("README: run, safety model, spawns, restore point honesty, administrator mode, icacls, residual risks, tests command", () => {
  const t = README.toLowerCase().replace(/\s+/g, " ");
  const need = [
    "npm start", "nuke system cleaner.exe", "%localappdata%\\programs\\nuke system cleaner", "npm run package", "@electron/packager",
    "safety model", "exclusive", "shared", "protected", "report-only", "only high is pre-ticked", "lib/junk-locations.mjs",
    "does **not** protect personal files", "needs administrator approval", "24 hours",
    "administrator mode limits", "c:\\windows\\temp", "c:\\windows\\minidump", "reportarchive", "reportqueue", "no service is stopped",
    "if the app cannot tell whether it is running as administrator, deleting is turned off", "per-user files are report-only while elevated",
    "%localappdata%\\nuke system cleaner\\", "contextisolation", "sandbox", "content security policy",
    "node --test --test-concurrency=1", "icacls", "authenticated users", "c:\\program files",
    "user-writable", "different administrator account", "other than `c:`", "been exercised", "rehearsal",
    "zero vulnerabilities", "registry cleaning is phase 2",
    "administrator mode from a source folder is not safe", "tightening only `d:\\tools\\nuke` is **not enough**", "whole parent chain",
    "`d:\\` then `d:\\tools` then `d:\\tools\\nuke`", "second, elevated", "asar: false", "fuses are **not changed**",
    "not** been verified in a running electron", "designed",
  ];
  for (const w of need) assert.ok(t.includes(w.toLowerCase()), "README must contain: " + w);
  // honesty guards: it must not claim the untested things were tested
  assert.ok(!/\bwas tested on a real\b|\bhas been smoke-tested\b|\bfully tested\b/i.test(README));
});
