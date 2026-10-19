import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REG_KEYS, regQuery, parseRegOutput, listScheduledTasks, parseSchtasksCsv, readIdentity, parseWhoami,
} from "../lib/sysread.mjs";

function fakeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "sysread-"));
  mkdirSync(path.join(root, "System32"));
  for (const n of ["reg.exe", "schtasks.exe", "whoami.exe"]) writeFileSync(path.join(root, "System32", n), "");
  return root;
}
// fake spawn: script(child) decides what happens; records calls
function fakeSpawn(script) {
  const calls = [];
  const fn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    calls.push({ exe, args, opts, child });
    setImmediate(() => script(child));
    return child;
  };
  fn.calls = calls;
  return fn;
}
const ok = (out, code = 0, err = "") => (c) => {
  if (out) c.stdout.emit("data", Buffer.isBuffer(out) ? out : Buffer.from(out, "latin1"));
  if (err) c.stderr.emit("data", Buffer.from(err));
  c.emit("close", code);
};

test("regQuery runs System32\\reg.exe by full path with the fixed array args and shell:false", async () => {
  const root = fakeRoot();
  try {
    const sp = fakeSpawn(ok(""));
    const r = await regQuery("uninstallHKLM", { spawnFn: sp, systemRoot: root });
    assert.equal(r.ok, true);
    const c = sp.calls[0];
    assert.equal(c.exe, path.join(root, "System32", "reg.exe"));
    assert.deepEqual(c.args, ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s"]);
    assert.equal(c.opts.shell, false);
    assert.equal(c.opts.windowsHide, true);
    assert.deepEqual(c.opts.stdio, ["ignore", "pipe", "pipe"]);
    const sv = fakeSpawn(ok(""));
    await regQuery("services", { spawnFn: sv, systemRoot: root });
    assert.deepEqual(sv.calls[0].args, ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Services", "/s", "/v", "ImagePath"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("REG_KEYS is frozen with exactly the specified names and paths", () => {
  assert.ok(Object.isFrozen(REG_KEYS));
  assert.deepEqual(Object.keys(REG_KEYS).sort(), ["oneDriveAccounts", "runHKCU", "runHKLM", "runOnceHKCU", "runOnceHKLM", "runWow", "services", "uninstallHKCU", "uninstallHKLM", "uninstallWow", "userShellFolders"]);
  assert.equal(REG_KEYS.uninstallWow.path, "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall");
  assert.equal(REG_KEYS.uninstallHKCU.path, "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall");
  assert.equal(REG_KEYS.runHKCU.path, "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run");
  assert.equal(REG_KEYS.runOnceHKLM.path, "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce");
  assert.equal(REG_KEYS.runWow.path, "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run");
  for (const k of Object.values(REG_KEYS)) assert.ok(Object.isFrozen(k) && Object.isFrozen(k.args));
  assert.deepEqual([...REG_KEYS.runHKCU.args], []);
  assert.deepEqual([...REG_KEYS.services.args], ["/s", "/v", "ImagePath"]);
  assert.equal(REG_KEYS.userShellFolders.path, "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders");
  assert.deepEqual([...REG_KEYS.userShellFolders.args], []);
  assert.equal(REG_KEYS.oneDriveAccounts.path, "HKCU\\SOFTWARE\\Microsoft\\OneDrive\\Accounts");
  assert.deepEqual([...REG_KEYS.oneDriveAccounts.args], ["/s", "/v", "UserFolder"]);
});

test("regQuery refuses any name not in REG_KEYS and never builds a key path from input", () => {
  assert.throws(() => regQuery("HKLM\\SOFTWARE"));
  assert.throws(() => regQuery("__proto__"));
  assert.throws(() => regQuery("toString"));
  assert.throws(() => regQuery("constructor"));
  assert.throws(() => regQuery(undefined));
});

test("parseRegOutput: keys, values, REG_EXPAND_SZ with % is lossy, non-ASCII byte is lossy, 4-space names", () => {
  const txt = [
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\X\\App1",
    "    DisplayName    REG_SZ    My App",
    "    UninstallString    REG_EXPAND_SZ    %ProgramFiles%\\My App\\unins.exe",
    "    Odd    Name    REG_SZ    spaced",
    "    Empty    REG_SZ",
    "    (Default)    REG_SZ    ",
    "    Count    REG_DWORD    0x1",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\X\\App2",
    "    Publisher    REG_SZ    Caf\u00e9",
    "    Mangled    REG_SZ    a?b",
    "",
  ].join("\r\n");
  const keys = parseRegOutput(Buffer.from(txt, "latin1"));
  assert.equal(keys.length, 2);
  assert.equal(keys[0].path, "HKEY_LOCAL_MACHINE\\SOFTWARE\\X\\App1");
  const v = keys[0].values;
  assert.deepEqual({ ...v.DisplayName }, { type: "REG_SZ", data: "My App", lossy: false });
  assert.equal(v.UninstallString.type, "REG_EXPAND_SZ");
  assert.equal(v.UninstallString.lossy, true);
  assert.equal(v["Odd    Name"].data, "spaced");
  assert.equal(v.Empty.data, "");
  assert.equal(v.Count.data, "0x1");
  assert.equal(keys[1].values.Publisher.lossy, true);
  assert.equal(keys[1].values.Mangled.lossy, true);
  // name with ? or high byte is lossy too
  const k2 = parseRegOutput(Buffer.from("HKEY_CURRENT_USER\\R\r\n    Na?me    REG_SZ    ok\r\n    N\u00e9    REG_SZ    ok\r\n", "latin1"));
  assert.equal(k2[0].values["Na?me"].lossy, true);
  assert.equal(k2[0].values["N\u00e9"].lossy, true);
});

test("parseRegOutput: hostile input - prototype names, junk lines, values before any key, empty", () => {
  const k = parseRegOutput(Buffer.from("    orphan    REG_SZ    x\r\nHKEY_CURRENT_USER\\A\r\n    __proto__    REG_SZ    evil\r\ngarbage line\r\n    bad REG_SZ x\r\n", "latin1"));
  assert.equal(k.length, 1);
  assert.equal(Object.keys(k[0].values).length, 1);
  assert.equal(({}).type, undefined);
  assert.equal(Object.getPrototypeOf({}).type, undefined);
  assert.deepEqual(parseRegOutput(Buffer.alloc(0)), []);
  assert.deepEqual(parseRegOutput(Buffer.from("End of search: 0 match(es) found.\r\n")), []);
});

test("missing key -> ok with no keys; other failure -> ok:false", async () => {
  const root = fakeRoot();
  try {
    const sp = fakeSpawn(ok("", 1, "ERROR: The system was unable to find the specified registry key or value."));
    assert.deepEqual(await regQuery("runHKLM", { spawnFn: sp, systemRoot: root }), { ok: true, keys: [] });
    const sp2 = fakeSpawn(ok("", 1, "ERROR: Access is denied."));
    const r = await regQuery("runHKLM", { spawnFn: sp2, systemRoot: root });
    assert.equal(r.ok, false);
    assert.ok(!r.reason.includes("Access is denied"), "stderr never echoed raw");
    const sp3 = fakeSpawn((c) => c.emit("error", new Error("EPERM secret\\path")));
    const r3 = await regQuery("runHKLM", { spawnFn: sp3, systemRoot: root });
    assert.equal(r3.ok, false);
    assert.ok(!r3.reason.includes("secret"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exe missing from systemRoot -> ok:false without spawning", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sysread-empty-"));
  try {
    const sp = fakeSpawn(ok(""));
    const r = await regQuery("runHKCU", { spawnFn: sp, systemRoot: root });
    assert.equal(r.ok, false);
    assert.equal(sp.calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("timeout and oversize output -> ok:false and the child is killed", async () => {
  const root = fakeRoot();
  try {
    const hang = fakeSpawn(() => {});
    const r = await regQuery("runHKCU", { spawnFn: hang, systemRoot: root, timeoutMs: 30 });
    assert.deepEqual(r, { ok: false, reason: "timed out" });
    assert.equal(hang.calls[0].child.killed, true);

    const big = fakeSpawn((c) => { c.stdout.emit("data", Buffer.alloc(2048)); c.stdout.emit("data", Buffer.alloc(2048)); });
    const r2 = await regQuery("runHKCU", { spawnFn: big, systemRoot: root, maxBytes: 3000 });
    assert.deepEqual(r2, { ok: false, reason: "output too large" });
    assert.equal(big.calls[0].child.killed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("default output cap is 64 MB", () => {
  const src = readFileSync(new URL("../lib/sysread.mjs", import.meta.url), "utf8");
  assert.match(src, /64 \* 1024 \* 1024/);
});

test("parseWhoami (R44): elevated true/false only from one integrity label; unknown -> null; sid independent", () => {
  const sid = "S-1-5-21-1111111111-222222222-333333333-1001";
  const user = Buffer.from(`"DESKTOP\\bob","${sid}"\r\n`);
  const grp = (s) => Buffer.from(`"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n"Mandatory Label\\X","Label","${s}","Mandatory group"\r\n`);
  assert.deepEqual(parseWhoami(user, grp("S-1-16-8192")), { sid, elevated: false });
  assert.deepEqual(parseWhoami(user, grp("S-1-16-4096")), { sid, elevated: false }); // low is a known "not elevated"
  assert.deepEqual(parseWhoami(user, grp("S-1-16-12288")), { sid, elevated: true });
  assert.deepEqual(parseWhoami(user, grp("S-1-16-16384")), { sid, elevated: true });
  // an unreadable / non-user SID (e.g. Entra) gives sid:null but keeps the known integrity level
  for (const u of [Buffer.from("garbage"), Buffer.from('"a","S-1-5-21-1-2-3"\r\n'), Buffer.from('"a","S-1-5-18"\r\n'), Buffer.from('"AzureAD\\bob","S-1-12-1-1-2-3-4"\r\n'), null]) {
    assert.deepEqual(parseWhoami(u, grp("S-1-16-12288")), { sid: null, elevated: true });
    assert.deepEqual(parseWhoami(u, grp("S-1-16-8192")), { sid: null, elevated: false });
  }
  // integrity level cannot be determined -> elevated null (never a silent false)
  for (const g of [Buffer.from("junk"), null, Buffer.from(""), Buffer.from('"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n'),
    Buffer.from(`"A","Label","S-1-16-8192","m"\r\n"B","Label","S-1-16-12288","m"\r\n`), // two different labels: ambiguous
    Buffer.from('"A","Label","S-1-16-8192x","m"\r\n')]) {
    assert.deepEqual(parseWhoami(user, g), { sid, elevated: null }, String(g));
  }
  assert.deepEqual(parseWhoami(null, null), { sid: null, elevated: null });
  // a SID-looking *name* in the wrong column must not elevate
  assert.deepEqual(parseWhoami(user, Buffer.from('"S-1-16-12288","Label","S-1-16-8192","x"\r\n')), { sid, elevated: false });
});

test("readIdentity runs whoami.exe twice with fixed args; a failure gives elevated:null (R44), never false", async () => {
  const root = fakeRoot();
  try {
    const sid = "S-1-5-21-1-2-3-4";
    const sp = fakeSpawn((c) => {
      const a = sp.calls.find((x) => x.child === c).args;
      ok(a[0] === "/user" ? `"PC\\u","${sid}"\r\n` : '"L","Label","S-1-16-12288","m"\r\n')(c);
    });
    const r = await readIdentity({ spawnFn: sp, systemRoot: root });
    assert.deepEqual(r, { sid, elevated: true });
    assert.deepEqual(sp.calls.map((c) => c.args), [["/user", "/fo", "csv", "/nh"], ["/groups", "/fo", "csv", "/nh"]]);
    assert.ok(sp.calls.every((c) => c.exe === path.join(root, "System32", "whoami.exe") && c.opts.shell === false));
    const bad = fakeSpawn(ok("", 1));
    assert.deepEqual(await readIdentity({ spawnFn: bad, systemRoot: root }), { sid: null, elevated: null });
    const hang = fakeSpawn(() => {});
    assert.deepEqual(await readIdentity({ spawnFn: hang, systemRoot: root, timeoutMs: 20 }), { sid: null, elevated: null });
    // /user fails but /groups works: the integrity level is still known
    const half = fakeSpawn((c) => {
      const a = half.calls.find((x) => x.child === c).args;
      ok(a[0] === "/user" ? "" : '"L","Label","S-1-16-8192","m"\r\n', a[0] === "/user" ? 1 : 0)(c);
    });
    assert.deepEqual(await readIdentity({ spawnFn: half, systemRoot: root }), { sid: null, elevated: false });
    // /groups fails: unknown
    const half2 = fakeSpawn((c) => {
      const a = half2.calls.find((x) => x.child === c).args;
      ok(a[0] === "/user" ? `"PC\\u","${sid}"\r\n` : "", a[0] === "/user" ? 0 : 1)(c);
    });
    assert.deepEqual(await readIdentity({ spawnFn: half2, systemRoot: root }), { sid, elevated: null });
    // a missing whoami.exe: unknown
    assert.deepEqual(await readIdentity({ spawnFn: sp, systemRoot: path.join(root, "nope") }), { sid: null, elevated: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("system tools use the fixed C:\\Windows root by default, never %SystemRoot% from the environment", { skip: process.platform !== "win32" }, async () => {
  const root = fakeRoot();
  const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
  try {
    process.env.SystemRoot = root; process.env.windir = root;
    const sp = fakeSpawn(ok('"L","Label","S-1-16-8192","m"\r\n'));
    await readIdentity({ spawnFn: sp });
    await regQuery("runHKCU", { spawnFn: fakeSpawn(ok("")) });
    const reg = fakeSpawn(ok(""));
    await regQuery("runHKCU", { spawnFn: reg });
    const st = fakeSpawn(ok(""));
    await listScheduledTasks({ spawnFn: st });
    assert.ok(sp.calls.length === 2 && sp.calls.every((c) => c.exe === "C:\\Windows\\System32\\whoami.exe"), JSON.stringify(sp.calls.map((c) => c.exe)));
    assert.equal(reg.calls[0].exe, "C:\\Windows\\System32\\reg.exe");
    assert.equal(st.calls[0].exe, "C:\\Windows\\System32\\schtasks.exe");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  }
  const src = readFileSync(new URL("../lib/sysread.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /process\.env/);
});

const row = (name, run) => `"PC","${name}","N/A","Ready","Interactive","N/A","0","bob","${run}","N/A"`;
test("parseSchtasksCsv: quoted commas, short rows ignored, garbage -> ok:false", () => {
  const csv = [row("\\Foo, Inc\\Updater", "C:\\a b\\x.exe /s,/q"), '"short","row"', row("\\Caf\u00e9", "%windir%\\y.exe")].join("\r\n") + "\r\n";
  const r = parseSchtasksCsv(Buffer.from(csv, "latin1"));
  assert.equal(r.ok, true);
  assert.equal(r.tasks.length, 2);
  assert.deepEqual(r.tasks[0], { name: "\\Foo, Inc\\Updater", run: "C:\\a b\\x.exe /s,/q", lossy: false });
  assert.equal(r.tasks[1].lossy, true);
  // doubled quotes inside a quoted field
  const q = parseSchtasksCsv(Buffer.from(row("T", 'cmd ""a""'), "latin1"));
  assert.equal(q.ok, true);
  assert.equal(q.tasks[0].run, 'cmd "a"');
  assert.deepEqual(parseSchtasksCsv(Buffer.alloc(0)), { ok: true, tasks: [] });
  for (const bad of ["this is not csv at all", '"unterminated,field', '"a"x,"b"', "<html>nope</html>"]) {
    assert.equal(parseSchtasksCsv(Buffer.from(bad)).ok, false, bad);
  }
  assert.equal(parseSchtasksCsv(null).ok, false);
});

test("listScheduledTasks runs schtasks.exe /query /fo csv /v /nh", async () => {
  const root = fakeRoot();
  try {
    const sp = fakeSpawn(ok(row("\\T", "x.exe") + "\r\n"));
    const r = await listScheduledTasks({ spawnFn: sp, systemRoot: root });
    assert.equal(r.ok, true);
    assert.equal(r.tasks[0].name, "\\T");
    assert.equal(sp.calls[0].exe, path.join(root, "System32", "schtasks.exe"));
    assert.deepEqual(sp.calls[0].args, ["/query", "/fo", "csv", "/v", "/nh"]);
    const bad = await listScheduledTasks({ spawnFn: fakeSpawn(ok("", 1, "ERROR")), systemRoot: root });
    assert.equal(bad.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sysread source: only reg.exe/schtasks.exe/whoami.exe, no exec/shell:true/spawnSync, no 'add'/'delete'/'import'/'copy' reg verbs", () => {
  const src = readFileSync(new URL("../lib/sysread.mjs", import.meta.url), "utf8");
  const exes = new Set((src.match(/[\w-]+\.exe/gi) || []).map((s) => s.toLowerCase()));
  assert.deepEqual([...exes].sort(), ["reg.exe", "schtasks.exe", "whoami.exe"]);
  assert.doesNotMatch(src, /(^|[^.\w])exec\w*\s*\(/m); // child_process exec*, not RegExp#exec
  assert.doesNotMatch(src, /import[^;]*\bexec\w*/);
  assert.doesNotMatch(src, /shell\s*:\s*true/);
  assert.doesNotMatch(src, /spawnSync|execFile|fork\(/);
  assert.doesNotMatch(src, /["'`]\s*(add|delete|import|copy|save|restore|load|unload|export|compare|flags)\s*["'`]/i);
  assert.doesNotMatch(src, /powershell|cmd\.exe/i);
  assert.match(src, /import \{ spawn \} from "node:child_process"/);
});

test("real reg.exe read of runHKCU returns ok (OPTIONAL real-machine smoke test: read-only `reg query` on HKCU Run, shape only)", { skip: process.platform !== "win32" }, async () => {
  const r = await regQuery("runHKCU");
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.keys));
  for (const k of r.keys) {
    assert.equal(typeof k.path, "string");
    for (const v of Object.values(k.values)) {
      assert.equal(typeof v.type, "string");
      assert.equal(typeof v.data, "string");
      assert.equal(typeof v.lossy, "boolean");
    }
  }
});
