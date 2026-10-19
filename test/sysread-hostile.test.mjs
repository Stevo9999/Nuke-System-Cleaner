import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { regQuery, parseRegOutputDetailed } from "../lib/sysread.mjs";

function fakeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "sysread-h-"));
  mkdirSync(path.join(root, "System32"));
  writeFileSync(path.join(root, "System32", "reg.exe"), "");
  return root;
}
function fakeSpawn(out) {
  const calls = [];
  const fn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    calls.push({ exe, args, opts });
    setImmediate(() => { if (out) child.stdout.emit("data", Buffer.from(out, "latin1")); child.emit("close", 0); });
    return child;
  };
  fn.calls = calls;
  return fn;
}
const UN = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const RUNK = "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
const regRun = async (name, text) => {
  const root = fakeRoot();
  try { return await regQuery(name, { spawnFn: fakeSpawn(text), systemRoot: root }); }
  finally { rmSync(root, { recursive: true, force: true }); }
};
const parse = (t) => parseRegOutputDetailed(Buffer.from(t, "latin1"));

test("DoS: a hostile 1 MB line with a lone CR and many REG_ markers parses in well under 1 s and is counted", () => {
  const evil = "    a    REG_SZ    x\r" + "    REG_X".repeat(130000);
  assert.ok(evil.length > 1000000);
  const t0 = process.hrtime.bigint();
  const r = parse(`${RUNK}\r\n${evil}\r\n    Ok    REG_SZ    fine\r\n`);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, "took " + ms + " ms");
  assert.equal(r.oversized, 1);
  assert.equal(r.keys[0].values.Ok.data, "fine");
  const soup = ("    REG_REG_REG_".repeat(4000) + "\r\n").repeat(20);
  const t1 = process.hrtime.bigint();
  parse(RUNK + "\r\n" + soup);
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 1000);
});

test("a lone CR in data keeps the value (lossy) instead of silently dropping it", () => {
  const r = parse(`${RUNK}\r\n    Evil    REG_SZ    C:\\mal.exe\r\r\n`);
  assert.equal(Object.keys(r.keys[0].values).length, 1);
  assert.equal(r.keys[0].values.Evil.lossy, true);
  assert.match(r.keys[0].values.Evil.data, /mal\.exe/);
});

test("unparseable lines are counted and surface as partial:true with a note", async () => {
  const r = await regRun("runHKCU", `${RUNK}\r\n    Good    REG_SZ    a\r\nsome junk line\r\n    bad REG_SZ x\r\n    X    REG_BOGUS    y\r\n\r\nEnd of search: 0 match(es) found.\r\n`);
  assert.equal(r.ok, true);
  assert.equal(r.partial, true);
  assert.ok(r.notes.length > 0);
  assert.equal(parse(`${RUNK}\r\njunk\r\n    bad REG_SZ x\r\n`).unparsed, 2);
  const clean = await regRun("runHKCU", `${RUNK}\r\n    Good    REG_SZ    a\r\n\r\nEnd of search: 1 match(es) found.\r\n`);
  assert.equal(clean.partial, undefined);
});

test("forged key lines from embedded newlines: other hive, prefix-only match, subkey of a non-/s key, duplicates all rejected", async () => {
  const forged = `${UN}\\Real\r\n    DisplayName    REG_SZ    x\r\nHKEY_CURRENT_USER\\Software\\Forged\r\n    InstallLocation    REG_SZ    C:\\Users\\bob\\Documents\r\n`
    + `${UN}Evil\r\n    InstallLocation    REG_SZ    C:\\Users\\bob\r\n${UN}\\Real\r\n    InstallLocation    REG_SZ    C:\\Users\\bob\\Pictures\r\n`;
  const r = await regRun("uninstallHKLM", forged);
  assert.deepEqual(r.keys.map((k) => k.path), [`${UN}\\Real`]);
  assert.equal(r.keys[0].values.InstallLocation, undefined);
  assert.equal(r.partial, true);
  const r2 = await regRun("runHKCU", `${RUNK}\r\n    A    REG_SZ    a\r\n${RUNK}\\Sub\r\n    B    REG_SZ    b\r\n`);
  assert.deepEqual(r2.keys.map((k) => k.path), [RUNK]);
  assert.equal(r2.partial, true);
  assert.equal(r2.keys[0].values.B, undefined);
});

test("lossy name collisions keep both values and mark them lossy", () => {
  const r = parse(`${RUNK}\r\n    Caf?    REG_SZ    one.exe\r\n    Caf?    REG_SZ    two.exe\r\n`);
  const vals = Object.values(r.keys[0].values);
  assert.equal(vals.length, 2);
  assert.deepEqual(vals.map((v) => v.data).sort(), ["one.exe", "two.exe"]);
  assert.ok(vals.every((v) => v.lossy));
});

test("systemRoot must be absolute and not UNC: nothing is spawned otherwise", async () => {
  for (const bad of ["\\\\evil\\share\\Windows", "//evil/share", "Windows", "..\\Windows", "", "C:\\Windows\\" + ".." + "\\Users\\evil",
    "C:\\Win\u0000dows", "C:\\Win\ndows", "C:/Windows", 5, null]) {
    const sp = fakeSpawn("");
    const r = await regQuery("runHKCU", { spawnFn: sp, systemRoot: bad });
    assert.equal(r.ok, false, bad);
    assert.equal(sp.calls.length, 0);
  }
});
