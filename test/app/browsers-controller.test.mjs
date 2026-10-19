// Browsers cleaner (round 2): controller / IPC / view-model / scan-runner wiring. Fake ui, fake runScan, real engine pieces on temp trees.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createController, ADMIN_BROWSERS_MESSAGE, BUSY_MESSAGE } from "../../app/main/controller.mjs";
import { appDataPaths, ensureAppData } from "../../app/main/appdata.mjs";
import { validateArgs, CHANNELS } from "../../app/main/ipc.mjs";
import { toView, BROWSERS_HELP } from "../../app/main/view-model.mjs";
import { scanArgs, runScan } from "../../app/main/scan-runner.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { RESTORE_MESSAGES } from "../../lib/restore.mjs";
import { CACHE_GROUP, HISTORY_GROUP, CLOSE_BROWSERS_NOTE } from "../../lib/browsers.mjs";

const SID = "S-1-5-21-11-22-33-1001";

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-brctl-"));
  const profile = path.join(root, "Profile");           // stands in for %USERPROFILE%
  const la = path.join(profile, "AppData", "Local");
  const ud = path.join(la, "Google", "Chrome", "User Data", "Default");
  fs.mkdirSync(path.join(ud, "Cache", "Cache_Data"), { recursive: true });
  fs.writeFileSync(path.join(ud, "Cache", "Cache_Data", "data_1"), "0123456789");
  fs.writeFileSync(path.join(ud, "History"), "0123456789");
  const paths = appDataPaths({ LOCALAPPDATA: la });
  ensureAppData(paths);
  return { root, profile, la, ud, paths, cache: path.join(ud, "Cache", "Cache_Data"), history: path.join(ud, "History"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const cacheFinding = (p) => makeFinding({ kind: "dir", path: p, label: "Chrome cache", bytes: 10, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false,
  reason: "Safe to remove", category: CACHE_GROUP });
const historyFinding = (p) => makeFinding({ kind: "file", path: p, label: "Chrome browsing history", bytes: 10, safe: { ok: true }, basis: "name", oldEnough: true, locked: false,
  reason: "Optional: not ticked for you.", category: HISTORY_GROUP });
const browsersResult = (t, items, notes = []) => ({ kind: "browsers", target: null, items, allowedRoots: [t.ud, path.join(t.ud, "Cache")], protectedPaths: [], notes, adminExtraBytes: null, partial: false });

function fakeUi() {
  const ui = { phases: [], shown: 0, closed: 0, confirms: 0,
    pickFile: async () => null, pickFolder: async () => null, sendProgress: () => {}, sendPhase: (p) => ui.phases.push(p),
    showResults: () => { ui.shown++; }, closeResults: () => { ui.closed++; },
    confirmPermanent: async () => { ui.confirms++; return true; }, askContinueWithoutRestore: async () => true,
    openRitual: () => ({ onClosed() {}, close() {} }) };
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
function make(t, { runScan: rs, elevated = false, profileRoot = t.profile, ui = fakeUi(), startRun = fakeStart(), ...rest } = {}) {
  const c = createController({ ui, paths: t.paths, identity: { sid: SID, elevated }, runScan: rs, startRun, profileRoot, protectedPaths: [path.join(t.profile, "Documents")],
    restore: async () => ({ outcome: "made", message: RESTORE_MESSAGES.made, detail: "made" }),
    readAudit: () => [{ state: "done", runId: "0123456789abcdef", freedBytes: 10, measured: true, results: [{ status: "deleted", bytes: 10 }] }], pollMs: 5, ...rest });
  return { c, ui, startRun };
}

test("IPC: nuke:scan:browsers exists, takes no arguments, and the preload/main names line up", () => {
  assert.ok(CHANNELS.includes("nuke:scan:browsers"));
  assert.deepEqual(validateArgs("nuke:scan:browsers", []), { ok: true, value: undefined });
  for (const a of [[undefined], [null], [{}], ["C:\\Users\\me\\AppData\\Local\\Google"], [{ path: "C:\\x" }], [{ locations: [] }], [1], [[]]]) assert.equal(validateArgs("nuke:scan:browsers", a).ok, false, JSON.stringify(a));
});

test("scanArgs('browsers'): only protectedPaths (absolute, bounded) and a test env survive; no locations, no target, no budget", () => {
  assert.deepEqual(scanArgs("browsers", {}), {});
  assert.deepEqual(scanArgs("browsers", undefined), {});
  assert.deepEqual(scanArgs("browsers", { protectedPaths: ["C:\\keep", "rel", 3, "C:\\ok\\sub"], locations: [{ base: "C:\\" }], target: "C:\\Windows", budget: {}, now: 1, sid: SID, elevated: true }),
    { protectedPaths: ["C:\\keep", "C:\\ok\\sub"] });
  assert.deepEqual(scanArgs("browsers", { env: { LOCALAPPDATA: "C:\\x", EVIL: "y" } }), { env: { LOCALAPPDATA: "C:\\x" } });
  assert.deepEqual(scanArgs("smart", { sid: SID, protectedPaths: ["C:\\keep", "rel"] }), { sid: SID, protectedPaths: ["C:\\keep"] });
});

test("controller: the Browsers cleaner scan passes no arguments from the window, shows the normal results screen and view", async () => {
  const t = tree();
  try {
    const cache = cacheFinding(t.cache), hist = historyFinding(t.history);
    const seen = [];
    const rs = async (kind, args) => { seen.push([kind, args]); return browsersResult(t, [cache, hist], [CLOSE_BROWSERS_NOTE]); };
    const { c, ui } = make(t, { runScan: rs });
    const r = await c.scanBrowsers("ignored", { locations: [] });
    assert.deepEqual(r, { ok: true, count: 2 });
    assert.deepEqual(seen, [["browsers", { protectedPaths: [] }]]);
    assert.equal(ui.shown, 1);
    assert.equal(ui.phases.at(-1).phase, "results");
    const v = await c.resultsGet();
    assert.equal(v.scanKind, "browsers");
    assert.equal(v.title, "Browser leftovers");
    assert.equal(v.help, BROWSERS_HELP);
    assert.match(v.help, /cache is safe to remove/i);
    assert.deepEqual(v.rows.map((x) => [x.label, x.category, x.group, x.confidence, x.ticked, x.selectable]),
      [["Chrome cache", "Browser cache", "exclusive", "high", true, true], ["Chrome browsing history", "Browsing history", "exclusive", "medium", false, true]]);
    assert.ok(v.notes.includes("Close your browsers for a complete clean"));
    assert.deepEqual(v.totals, { selectedBytes: 10, count: 1 }, "only the cache is pre-ticked");
    // Scan Again repeats the same kind
    await c.scanAgain();
    assert.deepEqual(seen.map((s) => s[0]), ["browsers", "browsers"]);
    // other kinds keep their own titles and carry no help line
    assert.equal(toView({ kind: "smart", items: [] }).scanKind, "smart");
    assert.equal(toView({ kind: "smart", items: [] }).help, "");
    assert.equal(toView({ kind: "startup", items: [] }).help, "");
  } finally { t.cleanup(); }
});

test("controller: nothing found -> no results window; a scan failure shows the fixed text; busy is refused", async () => {
  const t = tree();
  try {
    let { c, ui } = make(t, { runScan: async () => browsersResult(t, []) });
    assert.deepEqual(await c.scanBrowsers(), { ok: true, count: 0 });
    assert.equal(ui.shown, 0);
    assert.equal(ui.phases.at(-1).detail, "Scan finished. Nothing was found.");
    ({ c, ui } = make(t, { runScan: async () => { throw new Error("C:\\secret\\path"); } }));
    assert.deepEqual(await c.scanBrowsers(), { ok: false });
    assert.equal(ui.phases.at(-1).detail, "The scan could not be completed. Nothing was changed.");
    let release;
    const gate = new Promise((res) => { release = res; });
    ({ c } = make(t, { runScan: async () => { await gate; return browsersResult(t, []); } }));
    const first = c.scanBrowsers();
    await new Promise((res) => setImmediate(res));
    await assert.rejects(c.scanBrowsers(), (e) => e.message === BUSY_MESSAGE);
    release();
    await first;
  } finally { t.cleanup(); }
});

test("controller: administrator mode never walks the user's browser folders (R41): refused with a fixed message, no scan", async () => {
  const t = tree();
  try {
    let scans = 0;
    const { c, ui } = make(t, { elevated: true, runScan: async () => { scans++; return browsersResult(t, []); } });
    assert.deepEqual(await c.scanBrowsers(), { ok: false });
    assert.equal(scans, 0);
    assert.deepEqual(ui.phases.at(-1), { phase: "error", detail: ADMIN_BROWSERS_MESSAGE });
    assert.match(ADMIN_BROWSERS_MESSAGE, /administrator mode/);
  } finally { t.cleanup(); }
});

test("R45 for browser items: they must lie inside the user's profile folder; with no valid profile folder nothing is deletable", async () => {
  const t = tree();
  try {
    const cache = cacheFinding(t.cache);
    const outsideDir = path.join(t.root, "Elsewhere", "Cache");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outside = cacheFinding(outsideDir);
    const rs = async () => browsersResult(t, [cache, outside]);
    for (const [profileRoot, why] of [[null, "no profile"], ["relative\\path", "relative"], [path.join(t.root, "Another"), "a different profile"], [t.cache, "the item itself is the root"]]) {
      const h = make(t, { runScan: rs, profileRoot });
      await h.c.scanBrowsers();
      await assert.rejects(h.c.delete({ ids: [cache.id] }), (e) => e.message === "refused", why);
      assert.equal(h.startRun.calls.length, 0, why);
    }
    const h = make(t, { runScan: rs });
    await h.c.scanBrowsers();
    await assert.rejects(h.c.delete({ ids: [outside.id] }), (e) => e.message === "refused", "outside the profile");
    await assert.rejects(h.c.delete({ ids: [cache.id, outside.id] }), (e) => e.message === "refused");
    assert.equal(h.startRun.calls.length, 0);
    assert.ok(fs.existsSync(outsideDir) && fs.existsSync(t.cache));
  } finally { t.cleanup(); }
});

test("the normal funnel: ticked ids -> frozen selection -> startRun; a history item can be ticked by hand but is never pre-ticked", async () => {
  const t = tree();
  try {
    const cache = cacheFinding(t.cache), hist = historyFinding(t.history);
    const { c, startRun, ui } = make(t, { runScan: async () => browsersResult(t, [cache, hist]) });
    await c.scanBrowsers();
    const rows = (await c.resultsGet()).rows;
    assert.deepEqual(rows.filter((r) => r.ticked).map((r) => r.id), [cache.id]);
    await c.delete({ ids: [cache.id, hist.id] });
    assert.equal(ui.confirms, 1);
    assert.equal(startRun.calls.length, 1);
    assert.deepEqual(startRun.calls[0].sel.paths.slice().sort(), [t.cache, t.history].sort());
    assert.ok(startRun.calls[0].sel.protectedPaths.includes(path.join(t.profile, "Documents")));
    // the id of a personal file that no scan produced is simply unknown
    const cookies = path.join(t.ud, "Cookies");
    fs.writeFileSync(cookies, "secret");
    const h2 = make(t, { runScan: async () => browsersResult(t, [cache]) });
    await h2.c.scanBrowsers();
    const forged = makeFinding({ kind: "file", path: cookies, label: "x", safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false });
    await assert.rejects(h2.c.delete({ ids: [forged.id] }), (e) => e.message === "refused");
    assert.equal(h2.startRun.calls.length, 0);
    assert.ok(fs.existsSync(cookies));
  } finally { t.cleanup(); }
});

test("end to end through the real scan worker: kind 'browsers' runs the browser table on a fixture (files too new, so nothing is offered, and it says so)", async () => {
  const t = tree();
  try {
    const env = { LOCALAPPDATA: t.la, APPDATA: path.join(t.profile, "AppData", "Roaming"), SystemDrive: "C:" };
    fs.mkdirSync(env.APPDATA, { recursive: true });
    const r = await runScan("browsers", { protectedPaths: [], env });
    assert.equal(r.kind, "browsers");
    assert.deepEqual(r.items, [], "everything in the fixture was just created, so the 24-hour rule skips it");
    assert.ok(r.notes.some((n) => /^Chrome cache: \d+ items skipped: in use, newer than 24 hours/.test(n)), r.notes.join("|"));
    assert.ok(r.notes.some((n) => /^Chrome browsing history: 1 items skipped/.test(n)));
    assert.ok(fs.existsSync(t.cache) && fs.existsSync(t.history), "the scan is read-only");
    // the worker cannot be handed another table
    await assert.rejects(runScan("browsers-evil", {}), /unknown scan kind/);
  } finally { t.cleanup(); }
});
