// Exclusions (round 2): "Folders this app must never touch". settings.json storage + strict validation, IPC shape, the
// controller's add/remove, and enforcement in MAIN (scan view filter, choose(), and the delete-time re-check).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createController } from "../../app/main/controller.mjs";
import { appDataPaths, ensureAppData, loadSettings, saveSettings, cleanExclusion, addExclusion, readExclusions, loadExclusions, saveExclusions,
  touchesExclusion, exclusionId, MAX_EXCLUSIONS } from "../../app/main/appdata.mjs";
import { validateArgs, MAIN_ONLY, registerIpc, CHANNELS } from "../../app/main/ipc.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { RESTORE_MESSAGES } from "../../lib/restore.mjs";

const SID = "S-1-5-21-11-22-33-1001";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nuke-excl-"));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const ID = "0123456789abcdef";

// ---------------- appdata: validation, load, save ----------------

test("cleanExclusion: only absolute drive-letter folders; no UNC, device paths, '..', control or wildcard characters, drive roots", () => {
  const good = [["C:\\Users\\me\\Stuff", "C:\\Users\\me\\Stuff"], ["C:\\Users\\me\\Stuff\\", "C:\\Users\\me\\Stuff"], ["d:/Games/Saves", "d:\\Games\\Saves"],
    ["C:\\Program Files\\My App", "C:\\Program Files\\My App"], ["E:\\a\\b c\\d.e", "E:\\a\\b c\\d.e"]];
  for (const [raw, want] of good) assert.equal(cleanExclusion(raw), want, raw);
  const bad = ["", "x", "Stuff\\x", ".\\x", "C:x", "C:", "C:\\", "C:/", "d:\\", "\\\\server\\share\\x", "//server/share/x", "\\\\?\\C:\\x", "\\\\.\\C:\\x", "\\x",
    "C:\\a\\..\\b", "C:\\..", "C:\\a\\..", "C:\\a\\.\\..\\b", "C:\\a\nb", "C:\\a\u0000b", "C:\\a\u007fb", "C:\\a\u2028b", "C:\\a\tb", "C:\\a*", "C:\\a?b", "C:\\a|b", "C:\\a<b", "C:\\a>b",
    "C:\\a\"b", "C:\\a:stream", "C:\\a.\\b", "C:\\a \\b", "C:\\a.", "C:\\" + "x".repeat(1100), null, undefined, 5, {}, ["C:\\a"], true];
  for (const raw of bad) assert.equal(cleanExclusion(raw), null, JSON.stringify(raw));
});

test("addExclusion: duplicates are refused case-insensitively, the list is capped at 50, bad input says 'invalid'", () => {
  let list = [];
  let r = addExclusion(list, "C:\\Keep\\Me");
  assert.deepEqual(r, { ok: true, list: ["C:\\Keep\\Me"] });
  list = r.list;
  assert.deepEqual(addExclusion(list, "c:\\keep\\me"), { ok: false, reason: "duplicate" });
  assert.deepEqual(addExclusion(list, "C:/KEEP/ME/"), { ok: false, reason: "duplicate" });
  assert.deepEqual(addExclusion(list, "\\\\srv\\share"), { ok: false, reason: "invalid" });
  assert.deepEqual(addExclusion(list, "C:\\"), { ok: false, reason: "invalid" });
  assert.deepEqual(addExclusion(list, "C:\\a\\..\\b"), { ok: false, reason: "invalid" });
  // a folder inside another excluded folder is a different entry (allowed)
  assert.equal(addExclusion(list, "C:\\Keep\\Me\\Deeper").ok, true);
  let full = [];
  for (let i = 0; i < MAX_EXCLUSIONS; i++) full = addExclusion(full, "C:\\Folder" + i).list;
  assert.equal(full.length, 50);
  assert.deepEqual(addExclusion(full, "C:\\One more"), { ok: false, reason: "full" });
  assert.equal(MAX_EXCLUSIONS, 50);
});

test("settings.json: old files keep loading; exclusions are read strictly (bad entries dropped, duplicates removed, cut at 50)", () => {
  const d = tmp();
  try {
    const f = path.join(d, "settings.json");
    assert.deepEqual(readExclusions(f), { ok: true, list: [] }, "missing file");
    fs.writeFileSync(f, '{"restorePoint":false}');
    assert.deepEqual(readExclusions(f), { ok: true, list: [] }, "old file with only restorePoint");
    assert.deepEqual(loadSettings(f), { restorePoint: false, plainConfirm: false });
    fs.writeFileSync(f, '{"restorePoint":true,"plainConfirm":false}');
    assert.deepEqual(readExclusions(f), { ok: true, list: [] }, "old file with both switches");
    fs.writeFileSync(f, JSON.stringify({ restorePoint: false, plainConfirm: true, exclusions: ["C:\\A\\One", "c:\\a\\one", "\\\\srv\\x", "rel\\x", "C:\\", 7, null, "C:\\B\\Two\\", "C:\\a\\..\\x"] }));
    assert.deepEqual(readExclusions(f), { ok: true, list: ["C:\\A\\One", "C:\\B\\Two"] });
    assert.deepEqual(loadSettings(f), { restorePoint: false, plainConfirm: true }, "loadSettings keeps its two keys");
    fs.writeFileSync(f, JSON.stringify({ exclusions: Array.from({ length: 80 }, (_, i) => "C:\\F" + i) }));
    const cut = loadExclusions(f);
    assert.equal(cut.length, 50);
    assert.equal(cut[49], "C:\\F49");
    // an unknown list shape or an unreadable file is NOT ok: callers fail closed
    for (const body of ['{"exclusions":"C:\\\\x"}', '{"exclusions":{"0":"C:\\\\x"}}', '{"exclusions":5}', "not json", "[]", "null", "x".repeat(2 * 1024 * 1024)]) {
      fs.writeFileSync(f, body);
      assert.equal(readExclusions(f).ok, false, body.slice(0, 30));
      assert.deepEqual(readExclusions(f).list, []);
    }
    fs.rmSync(f); fs.mkdirSync(f);
    assert.equal(readExclusions(f).ok, false, "a folder where the file should be");
    assert.equal(readExclusions(123).ok, false);
  } finally { rm(d); }
});

test("saveExclusions / saveSettings: each keeps the other's data; empty list writes the old two-key shape; bad lists throw", () => {
  const d = tmp();
  try {
    const f = path.join(d, "settings.json");
    saveSettings(f, { restorePoint: true, plainConfirm: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { restorePoint: true, plainConfirm: false }, "no exclusions key when none");
    saveExclusions(f, ["C:\\Keep\\A", "D:\\Keep\\B"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { restorePoint: true, plainConfirm: false, exclusions: ["C:\\Keep\\A", "D:\\Keep\\B"] });
    // flipping a switch keeps the list
    saveSettings(f, { restorePoint: false, plainConfirm: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { restorePoint: false, plainConfirm: true, exclusions: ["C:\\Keep\\A", "D:\\Keep\\B"] });
    assert.deepEqual(loadSettings(f), { restorePoint: false, plainConfirm: true });
    // saving the list keeps the switches
    saveExclusions(f, ["D:\\Keep\\B"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { restorePoint: false, plainConfirm: true, exclusions: ["D:\\Keep\\B"] });
    saveExclusions(f, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { restorePoint: false, plainConfirm: true });
    // settings:set still takes exactly the two switches (the list can only change through add/remove)
    saveExclusions(f, ["C:\\Keep\\A"]);
    assert.throws(() => saveSettings(f, { restorePoint: true, plainConfirm: true, exclusions: [] }));
    assert.throws(() => saveSettings(f, { restorePoint: true, plainConfirm: true, exclusions: ["C:\\Evil"] }));
    assert.deepEqual(loadExclusions(f), ["C:\\Keep\\A"]);
    for (const bad of [null, "C:\\a", {}, ["C:\\"], ["\\\\s\\x"], ["C:\\a", "c:\\A"], ["C:\\a\\"], ["rel"], [5], Array.from({ length: 51 }, (_, i) => "C:\\F" + i)]) {
      assert.throws(() => saveExclusions(f, bad), undefined, JSON.stringify(bad));
    }
    assert.deepEqual(loadExclusions(f), ["C:\\Keep\\A"], "failed saves leave the file intact");
    assert.deepEqual(fs.readdirSync(d), ["settings.json"], "no temp files left behind");
    // an unreadable file is rewritten clean by a switch change (nothing to keep)
    fs.writeFileSync(f, "garbage");
    saveSettings(f, { restorePoint: true, plainConfirm: false });
    assert.deepEqual(readExclusions(f), { ok: true, list: [] });
  } finally { rm(d); }
});

test("touchesExclusion: the folder, anything inside it and anything containing it count; siblings do not; case-insensitive; fails closed", () => {
  const list = ["C:\\Data\\Keep"];
  for (const p of ["C:\\Data\\Keep", "C:\\Data\\Keep\\a.txt", "C:\\Data\\Keep\\x\\y", "c:\\data\\KEEP\\A", "C:\\Data", "C:\\"]) assert.equal(touchesExclusion(p, list), true, p);
  for (const p of ["C:\\Data\\Keeper", "C:\\Data\\Other\\Keep", "C:\\Data\\Kee", "D:\\Data\\Keep"]) assert.equal(touchesExclusion(p, list), false, p);
  assert.equal(touchesExclusion("C:\\anything", []), false);
  assert.equal(touchesExclusion(null, list), false);
  assert.equal(touchesExclusion("C:\\Data\\Keep\\a", "not a list"), false);
});

test("touchesExclusion deep: a junction that points into an excluded folder is caught through its real path", () => {
  const d = tmp();
  try {
    const keep = path.join(d, "Keep");
    fs.mkdirSync(keep);
    fs.writeFileSync(path.join(keep, "f.txt"), "x");
    const alias = path.join(d, "alias");
    try { fs.symlinkSync(keep, alias, "junction"); } catch { return; } // cannot make a junction here
    assert.equal(touchesExclusion(path.join(alias, "f.txt"), [keep]), false, "lexical form alone does not see it");
    assert.equal(touchesExclusion(path.join(alias, "f.txt"), [keep], { deep: true }), true);
    // and the other way round: the EXCLUDED entry was typed through the junction
    assert.equal(touchesExclusion(path.join(keep, "f.txt"), [alias], { deep: true }), true);
    assert.equal(touchesExclusion(path.join(keep, "f.txt"), [alias]), true, "the list's own canonical form is always used");
  } finally { rm(d); }
});

// ---------------- IPC ----------------

test("IPC: nuke:exclusions:add takes no arguments; nuke:exclusions:remove takes exactly {id}; both are main-window only", async () => {
  assert.ok(CHANNELS.includes("nuke:exclusions:add") && CHANNELS.includes("nuke:exclusions:remove"));
  assert.ok(MAIN_ONLY.includes("nuke:exclusions:add") && MAIN_ONLY.includes("nuke:exclusions:remove"));
  assert.deepEqual(validateArgs("nuke:exclusions:add", []), { ok: true, value: undefined });
  for (const a of [[undefined], [null], [{}], ["C:\\Windows"], [{ path: "C:\\Windows" }], [1], [[]], [{ id: ID }]]) assert.equal(validateArgs("nuke:exclusions:add", a).ok, false, JSON.stringify(a));
  assert.deepEqual(validateArgs("nuke:exclusions:remove", [{ id: ID }]), { ok: true, value: { id: ID } });
  const proto = Object.create({ id: ID });
  const bads = [[], [{}], [{ id: "short" }], [{ id: ID.toUpperCase() }], [{ id: ID + "0" }], [{ id: 5 }], [{ id: null }], [{ id: ID, extra: 1 }], [{ index: 0 }], [{ index: 1, id: ID }],
    [{ id: ID }, {}], [ID], [[ID]], [null], [{ id: [ID] }], [{ id: { toString: () => ID } }], [{ id: "C:\\Windows" }], [proto], [{ get id() { return ID; } }],
    [Object.assign(Object.create(null), { id: ID, z: 1 })]];
  for (const a of bads) assert.equal(validateArgs("nuke:exclusions:remove", a).ok, false, JSON.stringify(a));
  const input = { id: ID };
  assert.notEqual(validateArgs("nuke:exclusions:remove", [input]).value, input);
  // main-window only: a trusted but non-main sender (the results page) is refused, the controller never runs
  const handlers = new Map();
  const calls = [];
  const controller = { exclusionsAdd: async () => { calls.push("add"); return "added"; }, exclusionsRemove: async (a) => { calls.push(["remove", a]); return "removed"; } };
  registerIpc({ handle: (ch, fn) => handlers.set(ch, fn) }, controller, () => true, (e) => e.main === true);
  await assert.rejects(handlers.get("nuke:exclusions:add")({}), (e) => e.message === "refused");
  await assert.rejects(handlers.get("nuke:exclusions:remove")({}, { id: ID }), (e) => e.message === "refused");
  assert.deepEqual(calls, []);
  assert.equal(await handlers.get("nuke:exclusions:add")({ main: true }), "added");
  assert.equal(await handlers.get("nuke:exclusions:remove")({ main: true }, { id: ID }), "removed");
  assert.deepEqual(calls, ["add", ["remove", { id: ID }]]);
  await assert.rejects(handlers.get("nuke:exclusions:remove")({ main: true }, { id: "../../x" }), (e) => e.message === "refused");
  await assert.rejects(handlers.get("nuke:exclusions:add")({ main: true }, "C:\\Windows"), (e) => e.message === "refused");
});

// ---------------- controller ----------------

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-exctl-"));
  const la = path.join(root, "Local");
  const junk = path.join(la, "Temp");
  fs.mkdirSync(junk, { recursive: true });
  const paths = appDataPaths({ LOCALAPPDATA: la });
  ensureAppData(paths);
  const f = (rel) => { const p = path.join(junk, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "0123456789"); return p; };
  return { root, la, junk, f, paths, cleanup: () => rm(root) };
}
const vetted = (p, extra = {}) => makeFinding({ kind: "file", path: p, label: p, bytes: 10, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false,
  reason: "r", category: "Temporary files", ...extra });
const resultFor = (t, items) => ({ kind: "smart", target: null, items, allowedRoots: [t.junk], protectedPaths: [], notes: [], adminExtraBytes: null, partial: false });

function fakeUi(o = {}) {
  const ui = {
    phases: [], confirms: 0, picks: 0,
    pickFile: async () => null,
    pickFolder: async () => { ui.picks++; if (o.pickThrows) throw new Error("dialog"); return typeof o.folder === "function" ? o.folder() : (o.folder ?? null); },
    sendProgress: () => {}, sendPhase: (p) => ui.phases.push(p), showResults: () => {}, closeResults: () => {},
    confirmPermanent: async () => { ui.confirms++; if (o.onConfirm) o.onConfirm(); return true; },
    askContinueWithoutRestore: async () => true,
    openRitual: () => ({ onClosed() {}, close() {} }),
  };
  return ui;
}
function fakeStart() {
  const calls = [];
  const fn = async (sel, opts) => {
    calls.push({ sel, opts });
    let n = 0;
    const server = { runId: "0123456789abcdef", getState: () => (++n > 1 ? "done" : "armed"), close() {} };
    return { url: "http://127.0.0.1:1/?t=" + "f".repeat(64), server, selection: sel, sha256: sel.sha256, runId: server.runId };
  };
  fn.calls = calls;
  return fn;
}
function make(t, { ui = fakeUi(), runScan, startRun = fakeStart(), ...rest } = {}) {
  const c = createController({ ui, paths: t.paths, identity: { sid: SID, elevated: false }, runScan, startRun, protectedPaths: [path.join(t.root, "Documents")],
    restore: async () => ({ outcome: "made", message: RESTORE_MESSAGES.made, detail: "made" }),
    readAudit: () => [{ state: "done", runId: "0123456789abcdef", freedBytes: 1, measured: true, results: [{ status: "deleted", bytes: 10 }] }], pollMs: 5, ...rest });
  return { c, ui, startRun };
}

test("controller: Add folder uses the picker in main, validates, saves, and returns ids with display paths (never required from the window)", async () => {
  const t = tree();
  try {
    const keepA = path.join(t.junk, "keepA"), keepB = path.join(t.junk, "KEEPB");
    fs.mkdirSync(keepA); fs.mkdirSync(keepB);
    let next = keepA;
    const ui = fakeUi({ folder: () => next });
    const { c } = make(t, { ui, runScan: async () => resultFor(t, []) });
    assert.deepEqual((await c.settingsGet()).exclusions, []);
    let r = await c.exclusionsAdd();
    assert.equal(r.ok, true);
    assert.deepEqual(r.rows, [{ id: exclusionId(keepA), path: keepA }]);
    assert.equal(ui.picks, 1);
    assert.deepEqual(loadExclusions(t.paths.settingsFile), [keepA]);
    assert.deepEqual((await c.settingsGet()).exclusions, r.rows);
    // duplicate (other case), invalid (a drive root, UNC, relative), cancel
    next = keepA.toUpperCase();
    r = await c.exclusionsAdd();
    assert.deepEqual([r.ok, r.reason, r.rows.length], [false, "duplicate", 1]);
    for (const bad of [path.parse(keepA).root, "\\\\server\\share\\x", "relative\\folder", "C:\\a\\..\\b"]) {
      next = bad;
      r = await c.exclusionsAdd();
      assert.deepEqual([r.ok, r.reason], [false, "invalid"], bad);
    }
    next = null;
    r = await c.exclusionsAdd();
    assert.deepEqual([r.ok, r.reason, r.cancelled, r.rows.length], [false, "cancelled", true, 1]);
    // a picker that throws counts as cancelled
    const t2 = make(t, { ui: fakeUi({ pickThrows: true }), runScan: async () => resultFor(t, []) });
    assert.equal((await t2.c.exclusionsAdd()).reason, "cancelled");
    next = keepB;
    r = await c.exclusionsAdd();
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 2);
    // the cap
    for (let i = 0; i < 48; i++) { next = path.join(t.junk, "f" + i); assert.equal((await c.exclusionsAdd()).ok, true); }
    next = path.join(t.junk, "one-too-many");
    r = await c.exclusionsAdd();
    assert.deepEqual([r.ok, r.reason, r.rows.length], [false, "full", 50]);
  } finally { t.cleanup(); }
});

test("controller: Remove takes an id; an unknown or stale id changes nothing; the other switches survive; busy is refused", async () => {
  const t = tree();
  try {
    const a = path.join(t.junk, "a"), b = path.join(t.junk, "b");
    saveSettings(t.paths.settingsFile, { restorePoint: false, plainConfirm: true });
    saveExclusions(t.paths.settingsFile, [a, b]);
    const { c } = make(t, { runScan: async () => resultFor(t, []) });
    const before = fs.readFileSync(t.paths.settingsFile, "utf8");
    for (const bad of [undefined, null, {}, { id: 5 }, { id: "zz" }, { index: 0 }, "x", [ID]]) await assert.rejects(c.exclusionsRemove(bad), (e) => e.message === "refused", JSON.stringify(bad));
    let r = await c.exclusionsRemove({ id: ID });
    assert.deepEqual([r.ok, r.reason, r.rows.length], [false, "gone", 2]);
    assert.equal(fs.readFileSync(t.paths.settingsFile, "utf8"), before);
    r = await c.exclusionsRemove({ id: exclusionId(a) });
    assert.deepEqual([r.ok, r.rows], [true, [{ id: exclusionId(b), path: b }]]);
    assert.deepEqual(loadSettings(t.paths.settingsFile), { restorePoint: false, plainConfirm: true });
    r = await c.exclusionsRemove({ id: exclusionId(a) }); // removing twice
    assert.equal(r.reason, "gone");
    // while a scan is running nothing about the list can change
    let release;
    const gate = new Promise((res) => { release = res; });
    const slow = make(t, { runScan: async () => { await gate; return resultFor(t, []); } });
    const scanning = slow.c.scanSmart();
    await new Promise((res) => setImmediate(res));
    await assert.rejects(slow.c.exclusionsRemove({ id: exclusionId(b) }), (e) => e.message === "Another operation is still running. Please wait.");
    await assert.rejects(slow.c.exclusionsAdd(), (e) => e.message === "Another operation is still running. Please wait.");
    release();
    await scanning;
    assert.deepEqual(loadExclusions(t.paths.settingsFile), [b]);
  } finally { t.cleanup(); }
});

test("enforcement: scans receive the excluded folders as protected paths; items at, inside or around them are DROPPED from the view", async () => {
  const t = tree();
  try {
    const keep = path.join(t.junk, "keep");
    const inside = vetted(t.f("keep\\inside.tmp"));
    const keepItself = vetted(keep, { kind: "dir" });
    const parentDir = vetted(path.join(t.junk, "wrap"), { kind: "dir" });
    fs.mkdirSync(path.join(t.junk, "wrap", "sub"), { recursive: true });
    const outside = vetted(t.f("outside.tmp"));
    const wrapKeep = path.join(t.junk, "wrap", "sub", "deep");
    fs.mkdirSync(wrapKeep);
    saveExclusions(t.paths.settingsFile, [keep, wrapKeep]);
    const seen = [];
    const runScan = async (kind, args) => { seen.push([kind, args]); return resultFor(t, [inside, keepItself, parentDir, outside]); };
    const { c } = make(t, { runScan });
    await c.scanSmart();
    assert.deepEqual(seen[0], ["smart", { sid: SID, protectedPaths: [keep, wrapKeep] }]);
    const view = await c.resultsGet();
    assert.deepEqual(view.rows.map((r) => r.id), [outside.id], "only the item away from every excluded folder is shown");
    // Scan Again filters too
    const again = await c.scanAgain();
    assert.deepEqual(again.rows.map((r) => r.id), [outside.id]);
    // investigate scans get them as well (after the app's own protected list)
    await c.scanBrowsers();
    assert.deepEqual(seen.at(-1), ["browsers", { protectedPaths: [keep, wrapKeep] }]);
    const inv = make(t, { runScan, ui: fakeUi({ folder: t.junk }) });
    await inv.c.scanFolder();
    assert.deepEqual(seen.at(-1)[1].protectedPaths, [path.join(t.root, "Documents"), keep, wrapKeep]);
  } finally { t.cleanup(); }
});

test("enforcement: delete refuses an id inside an excluded folder even when it is sent directly (dropped id, or listed before the exclusion)", async () => {
  const t = tree();
  try {
    const keep = path.join(t.junk, "keep");
    const inside = vetted(t.f("keep\\inside.tmp"));
    const outside = vetted(t.f("outside.tmp"));
    const parent = vetted(path.join(t.junk, "wrap"), { kind: "dir" });
    const nested = path.join(t.junk, "wrap", "sub");
    fs.mkdirSync(nested, { recursive: true });
    const runScan = async () => resultFor(t, [inside, outside, parent]);

    // 1) excluded BEFORE the scan: the item never reaches the window, and its id is unknown to delete
    saveExclusions(t.paths.settingsFile, [keep]);
    let h = make(t, { runScan });
    await h.c.scanSmart();
    assert.ok(!(await h.c.resultsGet()).rows.some((r) => r.id === inside.id));
    await assert.rejects(h.c.delete({ ids: [inside.id] }), (e) => e.message === "refused");
    await assert.rejects(h.c.delete({ ids: [inside.id, outside.id] }), (e) => e.message === "refused");
    assert.equal(h.startRun.calls.length, 0);
    assert.ok(fs.existsSync(inside.path));

    // 2) excluded AFTER the scan (the scan result still holds the item): choose() re-reads the list and refuses
    saveExclusions(t.paths.settingsFile, []);
    h = make(t, { runScan });
    await h.c.scanSmart();
    assert.ok((await h.c.resultsGet()).rows.some((r) => r.id === inside.id), "listed while nothing is excluded");
    saveExclusions(t.paths.settingsFile, [keep]);
    await assert.rejects(h.c.delete({ ids: [inside.id] }), (e) => e.message === "refused");
    await assert.rejects(h.c.delete({ ids: [outside.id, inside.id] }), (e) => e.message === "refused", "one excluded id refuses the whole request");
    assert.equal(h.startRun.calls.length, 0);
    assert.equal(h.ui.confirms, 0, "refused before the warning");

    // 3) a parent folder of an excluded folder is refused too (deleting it would delete the excluded folder)
    saveExclusions(t.paths.settingsFile, [nested]);
    await assert.rejects(h.c.delete({ ids: [parent.id] }), (e) => e.message === "refused");
    assert.equal(h.startRun.calls.length, 0);

    // 4) an item away from every excluded folder still goes through, and the excluded folders ride in the frozen selection
    await h.c.delete({ ids: [outside.id] });
    assert.equal(h.startRun.calls.length, 1);
    const sel = h.startRun.calls[0].sel;
    assert.deepEqual(sel.paths, [outside.path]);
    assert.ok(sel.protectedPaths.includes(nested), "the server and revalidate() also see the excluded folder");
    assert.ok(sel.protectedPaths.includes(path.join(t.root, "Documents")));
  } finally { t.cleanup(); }
});

test("enforcement: a folder excluded while the user answers the warnings still stops the delete (re-check right before the run starts)", async () => {
  const t = tree();
  try {
    const keep = path.join(t.junk, "keep");
    const inside = vetted(t.f("keep\\inside.tmp"));
    const outside = vetted(t.f("outside.tmp"));
    const ui = fakeUi({ onConfirm: () => saveExclusions(t.paths.settingsFile, [keep]) });
    const { c, startRun } = make(t, { ui, runScan: async () => resultFor(t, [inside, outside]) });
    await c.scanSmart();
    const r = await c.delete({ ids: [inside.id, outside.id] });
    assert.equal(r.ok, false);
    assert.equal(ui.confirms, 1);
    assert.equal(startRun.calls.length, 0, "no server started");
    assert.equal(ui.phases.at(-1).phase, "error");
    assert.match(ui.phases.at(-1).detail, /changed or are no longer safe/);
    assert.ok(fs.existsSync(inside.path) && fs.existsSync(outside.path));
  } finally { t.cleanup(); }
});

test("enforcement: a junction into an excluded folder does not hide it (canonical form compared at delete time)", async () => {
  const t = tree();
  try {
    const keep = path.join(t.junk, "keep");
    fs.mkdirSync(keep);
    fs.writeFileSync(path.join(keep, "f.tmp"), "x");
    const alias = path.join(t.junk, "alias");
    try { fs.symlinkSync(keep, alias, "junction"); } catch { return; }
    const viaAlias = vetted(path.join(alias, "f.tmp"));
    const { c, startRun } = make(t, { runScan: async () => resultFor(t, [viaAlias]) });
    await c.scanSmart();
    saveExclusions(t.paths.settingsFile, [keep]);
    await assert.rejects(c.delete({ ids: [viaAlias.id] }), (e) => e.message === "refused");
    assert.equal(startRun.calls.length, 0);
    assert.ok(fs.existsSync(path.join(keep, "f.tmp")));
  } finally { t.cleanup(); }
});

test("enforcement fails closed: an unreadable settings file stops scans and deletes (the list is unknown), and a switch change repairs it", async () => {
  const t = tree();
  try {
    const a = vetted(t.f("a.tmp"));
    const runScan = async () => resultFor(t, [a]);
    const { c, ui, startRun } = make(t, { runScan });
    await c.scanSmart();
    assert.equal((await c.resultsGet()).rows.length, 1);
    fs.writeFileSync(t.paths.settingsFile, "{ this is not json");
    await assert.rejects(c.delete({ ids: [a.id] }), (e) => e.message === "refused");
    assert.equal(startRun.calls.length, 0);
    const r = await c.scanSmart();
    assert.equal(r.ok, false);
    assert.equal(ui.phases.at(-1).phase, "error");
    assert.match(ui.phases.at(-1).detail, /could not be completed/);
    // the window can still show the settings, and changing a switch writes a clean file
    assert.deepEqual(await c.settingsGet(), { restorePoint: true, plainConfirm: false, exclusions: [] });
    await c.settingsSet({ restorePoint: true, plainConfirm: false });
    assert.equal((await c.scanSmart()).ok, true);
  } finally { t.cleanup(); }
});

test("settings:set cannot change the list: the switches are saved, the exclusions stay", async () => {
  const t = tree();
  try {
    const keep = path.join(t.junk, "keep");
    saveExclusions(t.paths.settingsFile, [keep]);
    const { c } = make(t, { runScan: async () => resultFor(t, []) });
    const s = await c.settingsSet({ restorePoint: false, plainConfirm: true });
    assert.deepEqual(s, { restorePoint: false, plainConfirm: true, exclusions: [{ id: exclusionId(keep), path: keep }] });
    await assert.rejects(c.settingsSet({ restorePoint: true, plainConfirm: true, exclusions: [] }));
    assert.deepEqual(loadExclusions(t.paths.settingsFile), [keep]);
  } finally { t.cleanup(); }
});

test("control: the very same item IS deletable when its folder is not excluded (so the refusals above are the exclusion's doing)", async () => {
  const t = tree();
  try {
    const inside = vetted(t.f("keep\inside.tmp"));
    const { c, startRun } = make(t, { runScan: async () => resultFor(t, [inside]) });
    await c.scanSmart();
    await c.delete({ ids: [inside.id] });
    assert.equal(startRun.calls.length, 1);
    assert.deepEqual(startRun.calls[0].sel.paths, [inside.path]);
  } finally { t.cleanup(); }
});
