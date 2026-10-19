// Task 19B: release-gate UI fixes (folder wording, 5000 cap, reason/sharedWith, R46 relaunch gate, window sizes, no dead event).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toView } from "../../app/main/view-model.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { windowOptions } from "../../app/main/windows.mjs";
import { EVENTS, CHANNELS } from "../../app/main/ipc.mjs";
import { makeRelaunchElevated, relaunchAllowed } from "../../app/main/elevation.mjs";

const read = (p) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const OK = { ok: true };
const result = (items, kind = "smart") => ({ kind, target: null, items, allowedRoots: [], protectedPaths: [], notes: [], adminExtraBytes: null, partial: false });

// ---- item 3: reason / sharedWith / smart-scan display name
test("view-model rows carry a sanitised reason and sharedWith; ids unchanged", () => {
  const f = makeFinding({ kind: "dir", path: "C:\\p\\a", label: "a", bytes: 5, safe: OK, basis: "traced",
    sharedWith: ["Prog\u202EA", "B\nB", "x".repeat(500)], reason: "why\u0000 " + "y".repeat(1000), category: "leftover" });
  const v = toView(result([f], "investigate"));
  const r = v.rows[0];
  assert.equal(r.id, f.id);
  assert.ok(r.reason.length <= 303);
  assert.doesNotMatch(r.reason, /[\p{Cc}\p{Cf}]/u);
  assert.deepEqual(r.sharedWith.slice(0, 2), ["Prog A", "B B"]);
  for (const s of r.sharedWith) { assert.ok(s.length <= 83); assert.doesNotMatch(s, /[\p{Cc}\p{Cf}]/u); }
  const hostile = toView(result([{ ...f, sharedWith: "nope", reason: 42 }], "investigate")).rows[0];
  assert.deepEqual(hostile.sharedWith, []);
  assert.equal(hostile.reason, "42");
  const none = toView(result([{ ...f, reason: undefined, sharedWith: undefined }], "investigate")).rows[0];
  assert.equal(none.reason, ""); assert.deepEqual(none.sharedWith, []);
});

test("Smart Scan rows with label === path use the location category as the name; other labels and investigate rows keep theirs", () => {
  const p = "C:\\Users\\u\\AppData\\Local\\Temp\\x.tmp";
  const a = makeFinding({ kind: "file", path: p, label: p, bytes: 5, safe: OK, basis: "vetted", oldEnough: true, locked: false, reason: "r", category: "Temporary files" });
  const b = makeFinding({ kind: "file", path: p + "2", label: "Recycle Bin record", bytes: 5, safe: OK, basis: "vetted", oldEnough: true, locked: false, category: "Recycle Bin" });
  const v = toView(result([a, b]));
  assert.equal(v.rows[0].label, "Temporary files");
  assert.equal(v.rows[0].path, p);
  assert.equal(v.rows[1].label, "Recycle Bin record");
  const inv = toView(result([a], "investigate")).rows[0];
  assert.equal(inv.label, p);
});

// ---- minimal fake DOM for results.js
class N {
  constructor() { this.children = []; this.attrs = {}; this.listeners = {}; this._text = ""; this.hidden = false; this.disabled = false; this.checked = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
  get firstChild() { return this.children[0] ?? null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  async fire(t) { for (const f of this.listeners[t] || []) await f({}); }
}
function fakeDoc() {
  const ids = {};
  for (const id of ["title", "notice", "notes", "diff", "rows", "report", "report-list", "admin", "summary", "cancel", "again", "delete", "error"]) ids[id] = new N();
  ids.delete.disabled = true; ids.error.hidden = true;
  return { ids, createElement: () => new N(), getElementById: (id) => ids[id] };
}
const row = (i, over = {}) => ({ id: i.toString(16).padStart(16, "0"), label: "L" + i, path: "", size: "1 B", bytes: 1, group: "exclusive", confidence: "high", ticked: true, selectable: true, badge: "", companionOf: "", reason: "", sharedWith: [], ...over });
const settle = () => new Promise((r) => setTimeout(r, 15));

test("results: more than 5000 ticked items shows the clear message and disables Delete; at 5000 it is allowed", async () => {
  const { mount, MAX_TICKED } = await import("../../app/renderer/results.js");
  assert.equal(MAX_TICKED, 5000);
  for (const [n, disabled] of [[5000, false], [5001, true]]) {
    const doc = fakeDoc();
    const calls = [];
    const rows = Array.from({ length: n }, (_, i) => row(i));
    mount(doc, { getResults: async () => ({ title: "T", rows, removed: [], notes: [], permanentNotice: "N" }), getStatus: async () => ({ elevated: false }),
      deleteSelected: async (ids) => { calls.push(ids.length); }, scanAgain: async () => null, closeResults() {} });
    await settle();
    assert.equal(doc.ids.delete.disabled, disabled, String(n));
    if (disabled) {
      assert.match(doc.ids.summary.textContent, /You can tick at most 5000 items at a time; run the cleanup again for the rest/);
      await doc.ids.delete.fire("click");
      assert.deepEqual(calls, []);
    } else assert.doesNotMatch(doc.ids.summary.textContent, /at most 5000/);
  }
});

test("results rows show 'Also used by' and 'Protected:' lines as text", async () => {
  const { mount } = await import("../../app/renderer/results.js");
  const doc = fakeDoc();
  const rows = [row(1, { sharedWith: ["Alpha", "Beta"], group: "shared", confidence: "medium", ticked: false }),
    row(2, { group: "protected", selectable: false, ticked: false, confidence: "", reason: "inside your Documents" })];
  mount(doc, { getResults: async () => ({ title: "T", rows, removed: [], notes: [], permanentNotice: "N" }), getStatus: async () => ({ elevated: false }),
    deleteSelected: async () => {}, scanAgain: async () => null, closeResults() {} });
  await settle();
  assert.match(doc.ids.rows.children[0].textContent, /Also used by: Alpha, Beta/);
  assert.match(doc.ids.rows.children[1].textContent, /Protected: inside your Documents/);
  assert.doesNotMatch(doc.ids.rows.children[0].textContent, /Protected:/);
});

test("results: 'could free more in administrator mode' hidden when relaunch is not allowed", async () => {
  const { mount } = await import("../../app/renderer/results.js");
  for (const [status, hidden] of [[{ elevated: false, canRelaunchAdmin: true }, false], [{ elevated: false, canRelaunchAdmin: false }, true], [{ elevated: false }, true]]) {
    const doc = fakeDoc();
    mount(doc, { getResults: async () => ({ title: "T", rows: [row(1)], removed: [], notes: [], permanentNotice: "N", adminExtra: "3 MB" }), getStatus: async () => status,
      deleteSelected: async () => {}, scanAgain: async () => null, closeResults() {} });
    await settle();
    assert.equal(doc.ids.admin.hidden, hidden, JSON.stringify(status));
  }
});

// ---- item 5
test("one window (Task 20): only the main window kind exists; the ritual/results pages are views; dead event gone", () => {
  assert.throws(() => windowOptions("ritual", { preload: "p" }));
  assert.throws(() => windowOptions("results", { preload: "p", parent: {} }));
  const m = windowOptions("main", { preload: "p" });
  assert.notEqual(m.resizable, false);
  assert.ok(m.width >= 1000 && m.height >= 700);
  assert.deepEqual([...EVENTS].sort(), ["nuke:phase", "nuke:progress", "nuke:question"]);
  assert.equal(CHANNELS.length, 25);
  for (const f of ["app/preload/preload.cjs", "app/renderer/results.js", "app/main/ipc.mjs"]) assert.doesNotMatch(read(f), /results:changed|onResultsChanged/, f);
});

// ---- item 4 (R46)
const fakeApp = (packaged = true) => {
  const log = [];
  return { log, isPackaged: packaged, getAppPath: () => "C:\\Program Files\\Nuke-Uninstaller\\1.0\\resources\\app", releaseSingleInstanceLock: () => log.push("release"),
    requestSingleInstanceLock: () => { log.push("request"); return true; }, quit: () => log.push("quit") };
};
test("R46: relaunch allowed only for a packaged app exe under C:\\Program Files or (x86)", async () => {
  const good = ["C:\\Program Files\\Nuke-Uninstaller\\1.0\\Nuke-Uninstaller.exe", "c:\\program files (x86)\\N\\n.exe", "C:\\PROGRAM FILES\\N\\n.exe"];
  const bad = ["E:\\Claude\\nuke\\node_modules\\electron\\dist\\electron.exe", "C:\\Users\\me\\AppData\\Local\\Programs\\N\\n.exe", "C:\\Program Files Evil\\n.exe",
    "C:\\Program Files\\..\\Users\\me\\n.exe", "C:\\Program Files", "C:\\Program Files\\", "D:\\Program Files\\n.exe", "\\\\h\\C$\\Program Files\\n.exe",
    "C:\\Program Files\\a\\..\\..\\Users\\n.exe", "C:\\Program Files/N/n.exe", "", null, undefined, 5, "C:\\Program Files\\n\u0000.exe"];
  for (const p of good) assert.equal(relaunchAllowed({ app: fakeApp(true), execPath: p }), true, p);
  for (const p of bad) assert.equal(relaunchAllowed({ app: fakeApp(true), execPath: p }), false, String(p));
  assert.equal(relaunchAllowed({ app: fakeApp(false), execPath: good[0] }), false, "unpackaged");
  assert.equal(relaunchAllowed({ app: null, execPath: good[0] }), false);
  // the wiring refuses before touching the lock or starting anything
  for (const [packaged, exe] of [[false, good[0]], [true, bad[0]], [true, bad[1]]]) {
    const app = fakeApp(packaged); let started = 0;
    const fn = makeRelaunchElevated({ app, execPath: exe, relaunch: async () => { started++; return "started"; } });
    assert.equal(fn.allowed, false);
    assert.equal(await fn(), "failed");
    assert.equal(started, 0); assert.deepEqual(app.log, []);
  }
  const app = fakeApp(true); const args = [];
  const fn = makeRelaunchElevated({ app, execPath: good[0], relaunch: async (o) => { args.push(o); return "started"; } });
  assert.equal(fn.allowed, true);
  assert.equal(await fn(), "started");
  assert.deepEqual(app.log, ["release", "quit"]);
  assert.deepEqual(args[0].args, []);
});

test("README: npm ci first (Electron download), Program Files copy steps marked untested, folder button name, R43 and source-folder wording", () => {
  const t = read("docs/TECHNICAL.md").replace(/\s+/g, " ");
  assert.ok(t.indexOf("npm ci") > -1 && t.indexOf("npm ci") < t.indexOf("npm start"));
  assert.match(t, /about 100 MB/);
  assert.match(t, /C:\\Program Files\\Nuke-Uninstaller\\<version>/);
  assert.match(t, /elevated/i);
  assert.match(t, /untested/i);
  assert.match(t, /Pick a folder to investigate/);
  assert.doesNotMatch(t, /Standard mode is not affected by this/);
  assert.match(t, /Standard mode is \*\*also\*\* affected/);
  assert.match(t, /also needs administrator approval/);
  assert.match(t, /\(R43\), in standard mode too/);
  for (const f of ["docs/TECHNICAL.md", "app/renderer/main.js", "app/renderer/results.js"]) assert.doesNotMatch(read(f), /Pick a folder to scan/);
});

test("hygiene: stray report removed, .claude/ ignored; nuke-command.md says lift the glass cover", () => {
  assert.throws(() => read("task-13-report.md"));
  assert.match(read(".gitignore"), /^\.claude\/$/m);
  assert.match(read("docs/claude-code/nuke-command.md"), /lift the glass cover/);
  assert.match(read("app/renderer/phases.js"), /lift the glass cover/);
});
