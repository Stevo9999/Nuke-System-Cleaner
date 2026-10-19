// test/wintools.test.mjs: the fixed "Windows tools" list and its launcher. A fake spawn is used everywhere: no real tool is started.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WINTOOLS, toolList, openTool, isToolKey, launchArgs } from "../lib/wintools.mjs";

const fakeChild = (ev = "spawn") => {
  const handlers = {};
  const child = { unrefs: 0, once(e, f) { handlers[e] = f; if (e === ev) setImmediate(() => f(ev === "error" ? new Error("x") : undefined)); return child; }, unref() { child.unrefs++; } };
  return child;
};

test("every entry is an absolute C:\\Windows\\System32 program with fixed, frozen arguments", () => {
  assert.ok(Object.isFrozen(WINTOOLS));
  assert.deepEqual(Object.keys(WINTOOLS).sort(), ["computerManagement", "defrag", "diskCleanup", "diskManagement", "eventViewer", "keyboard", "programsAndFeatures",
    "resourceMonitor", "services", "sharedFolders", "systemInfo", "systemRestore", "taskManager", "taskScheduler", "windowsFeatures"]);
  const exes = new Set();
  for (const [key, t] of Object.entries(WINTOOLS)) {
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.args), key);
    assert.match(t.exe, /^C:\\Windows\\System32\\[A-Za-z0-9]+\.exe$/, key);
    for (const a of t.args) assert.match(a, /^C:\\Windows\\System32\\[A-Za-z0-9]+\.(msc|cpl)$/, key);
    assert.ok(t.label.length > 0 && t.description.length > 0 && !/exclusive/i.test(t.description), key);
    exes.add(t.exe.split("\\").pop().toLowerCase());
  }
  // nothing that deletes, formats, edits the registry or needs a command prompt
  for (const bad of ["cmd.exe", "powershell.exe", "chkdsk.exe", "sfc.exe", "netstat.exe", "reg.exe", "regedit.exe", "format.com", "diskpart.exe", "cleanmgr.bat"])
    assert.ok(!exes.has(bad), bad);
  assert.deepEqual([...exes].sort(), ["cleanmgr.exe", "control.exe", "dfrgui.exe", "mmc.exe", "msinfo32.exe", "optionalfeatures.exe", "osk.exe", "resmon.exe", "rstrui.exe", "taskmgr.exe"]);
});

test("every program and snap-in in the list exists on this Windows (the list was checked against a real machine)", { skip: process.platform !== "win32" }, () => {
  for (const [key, t] of Object.entries(WINTOOLS)) {
    assert.ok(fs.existsSync(t.exe), key + " " + t.exe);
    for (const a of t.args) assert.ok(fs.existsSync(a), key + " " + a);
  }
});

test("toolList gives the window only key, label and description (no program path, no arguments)", () => {
  const list = toolList();
  assert.equal(list.length, Object.keys(WINTOOLS).length);
  for (const r of list) {
    assert.deepEqual(Object.keys(r).sort(), ["description", "key", "label"]);
    assert.ok(isToolKey(r.key));
  }
  assert.ok(!JSON.stringify(list).includes("System32"));
});

test("isToolKey: only own keys of the fixed list", () => {
  assert.equal(isToolKey("services"), true);
  for (const k of ["", "toString", "__proto__", "constructor", "hasOwnProperty", "Services", "services ", "C:\\Windows\\System32\\cmd.exe", 1, null, undefined, {}, ["services"]])
    assert.equal(isToolKey(k), false, String(k));
});

test("openTool asks Windows to start exactly the fixed entry through rundll32: shell false, detached, no stdio, unref'd", async () => {
  for (const [key, t] of Object.entries(WINTOOLS)) {
    const calls = []; const child = fakeChild();
    const r = await openTool(key, { spawnFn: (...a) => { calls.push(a); return child; }, exists: () => true });
    assert.deepEqual(r, { ok: true }, key);
    assert.equal(calls.length, 1, key);
    assert.equal(calls[0][0], "C:\\Windows\\System32\\rundll32.exe");
    assert.deepEqual(calls[0][1], ["shell32.dll,ShellExec_RunDLL", t.exe, ...t.args]);
    assert.deepEqual(launchArgs(key), calls[0][1]);
    assert.deepEqual(calls[0][2], { shell: false, detached: true, stdio: "ignore" });
    assert.equal(child.unrefs, 1);
  }
});

test("openTool: unknown keys never reach spawn; a missing program, a throwing spawn and a start error all give ok:false", async () => {
  let n = 0;
  const spawnFn = () => { n++; return fakeChild(); };
  for (const k of ["", "toString", "__proto__", "nope", "C:\\Windows\\System32\\cmd.exe", 5, null, undefined, {}]) assert.deepEqual(await openTool(k, { spawnFn, exists: () => true }), { ok: false });
  assert.equal(n, 0);
  assert.deepEqual(await openTool("services", { spawnFn, exists: () => false }), { ok: false });
  assert.deepEqual(await openTool("services", { spawnFn, exists: p => !/services\.msc$/.test(p) }), { ok: false }, "a missing snap-in is not started either");
  assert.deepEqual(await openTool("services", { spawnFn, exists: p => !/rundll32\.exe$/.test(p) }), { ok: false });
  assert.deepEqual(await openTool("services", { spawnFn, exists: () => { throw new Error("x"); } }), { ok: false });
  assert.equal(n, 0, "a missing program is never started");
  assert.deepEqual(await openTool("services", { spawnFn: () => { throw new Error("EACCES C:\\secret"); }, exists: () => true }), { ok: false });
  assert.deepEqual(await openTool("services", { spawnFn: () => fakeChild("error"), exists: () => true }), { ok: false });
  assert.deepEqual(await openTool("services", { spawnFn: () => null, exists: () => true }), { ok: false });
});
