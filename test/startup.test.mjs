import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listStartupItems } from "../lib/startup.mjs";

const idOf = (kind, key) => createHash("sha1").update(kind + ":" + key.toLowerCase()).digest("hex").slice(0, 16);
const keyOf = (values) => ({ ok: true, keys: [{ path: "HKEY_X\\Run", values }] });
const v = (data, lossy = false) => ({ type: "REG_SZ", data, lossy });

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "startup-"));
  const appdata = path.join(base, "AppData");
  const pd = path.join(base, "ProgramData");
  const su = path.join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const sp = path.join(pd, "Microsoft", "Windows", "Start Menu", "Programs", "StartUp");
  mkdirSync(su, { recursive: true }); mkdirSync(sp, { recursive: true });
  return { base, env: { APPDATA: appdata, ProgramData: pd }, su, sp };
}

test("listStartupItems: every item is report-only, unselectable, labels from Run values and Startup folders; links skipped", async () => {
  const { base, env, su, sp } = setup();
  try {
    writeFileSync(path.join(su, "Mine.lnk"), "x");
    writeFileSync(path.join(sp, "All.lnk"), "x");
    writeFileSync(path.join(su, "desktop.ini"), "x");
    mkdirSync(path.join(su, "subdir"));
    writeFileSync(path.join(su, "subdir", "deep.lnk"), "x");
    let linked = false;
    try { symlinkSync(path.join(su, "Mine.lnk"), path.join(su, "Link.lnk")); linked = true; } catch { /* no privilege */ }
    const calls = [];
    const regQuery = async (name) => {
      calls.push(name);
      if (name === "runHKCU") return keyOf({ OneDrive: v("\"C:\\x\\OneDrive.exe\" /background") });
      if (name === "runHKLM") return keyOf({ Sec: v("%ProgramFiles%\\s.exe", true) });
      if (name === "runOnceHKCU") return { ok: false, reason: "timed out" };
      return { ok: true, keys: [] };
    };
    const items = await listStartupItems({ regQuery, env });
    assert.deepEqual(calls.sort(), ["runHKCU", "runHKLM", "runOnceHKCU", "runOnceHKLM", "runWow"]);
    const labels = items.map((i) => i.label).sort();
    assert.deepEqual(labels, ["All.lnk", "Mine.lnk", "OneDrive", "Sec"]);
    assert.ok(!linked || !labels.includes("Link.lnk"));
    for (const i of items) {
      assert.equal(i.kind, "startup");
      assert.equal(i.group, "report-only");
      assert.equal(i.confidence, null);
      assert.equal(i.preTicked, false);
      assert.equal(i.selectable, false);
      assert.equal(i.bytes, null);
      assert.deepEqual(i.sharedWith, []);
      assert.match(i.id, /^[0-9a-f]{16}$/);
      assert.equal(typeof i.reason, "string");
    }
    const od = items.find((i) => i.label === "OneDrive");
    assert.match(od.reason, /OneDrive\.exe/);
    assert.equal(od.path, null);
    assert.equal(od.id, idOf("startup", "HKCU Run:OneDrive"));
    const mine = items.find((i) => i.label === "Mine.lnk");
    assert.equal(mine.path, path.join(su, "Mine.lnk"));
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("listStartupItems: readLnk target goes in reason; readLnk throwing or missing dirs are harmless", async () => {
  const { base, env, su } = setup();
  try {
    writeFileSync(path.join(su, "A.lnk"), "x");
    writeFileSync(path.join(su, "B.lnk"), "x");
    const readLnk = (p) => { if (p.endsWith("B.lnk")) throw new Error("boom"); return { target: "C:\\Apps\\a.exe" }; };
    const items = await listStartupItems({ regQuery: async () => ({ ok: true, keys: [] }), env, readLnk });
    assert.match(items.find((i) => i.label === "A.lnk").reason, /C:\\Apps\\a\.exe/);
    assert.equal(items.find((i) => i.label === "B.lnk").group, "report-only");
    const none = await listStartupItems({ regQuery: async () => ({ ok: true, keys: [] }), env: {} });
    assert.deepEqual(none, []);
    const gone = await listStartupItems({ regQuery: async () => { throw new Error("x"); }, env: { APPDATA: path.join(base, "nope") } });
    assert.deepEqual(gone, []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("listStartupItems: hostile value names stay report-only, long text is capped", async () => {
  const long = "A".repeat(10000);
  const items = await listStartupItems({
    regQuery: async (n) => (n === "runHKCU" ? keyOf({ [long]: v(long), "x\u202Ey\n": v("c") }) : { ok: true, keys: [] }),
    env: {},
  });
  assert.equal(items.length, 2);
  for (const i of items) { assert.ok(i.label.length <= 260); assert.ok(i.reason.length <= 1200); assert.equal(i.selectable, false); }
});
