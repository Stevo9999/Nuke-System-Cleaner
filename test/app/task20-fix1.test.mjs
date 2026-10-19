// Task 20 fix round 1: finished run keeps its page until "Done - back to start" (R51), lost-view handling, in-window questions (R52).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createViewHost } from "../../app/main/embedded-view.mjs";
import { createQuestionBroker } from "../../app/main/question.mjs";
import { validateArgs, registerIpc, CHANNELS, EVENTS } from "../../app/main/ipc.mjs";
import { createController } from "../../app/main/controller.mjs";
import { appDataPaths, ensureAppData } from "../../app/main/appdata.mjs";
import { makeFinding } from "../../lib/confidence.mjs";

const rd = rel => fs.readFileSync(fileURLToPath(new URL("../../" + rel, import.meta.url)), "utf8");
const SID = "S-1-5-21-11-22-33-1001";
const WARNING = "Deleting is permanent: these items do not go to the Recycle Bin. A system restore point protects Windows settings and installed programs, but it does NOT bring back your own files (documents, pictures and so on).";

// ---------- I2: lost views ----------
function fakeWin() {
  const win = new EventEmitter();
  win.children = []; win.minimum = null;
  win.contentView = { addChildView: v => win.children.push(v), removeChildView: v => { win.children = win.children.filter(x => x !== v); } };
  win.getContentBounds = () => ({ width: 1100, height: 760 });
  win.setMinimumSize = (w, h) => { win.minimum = [w, h]; };
  win.isDestroyed = () => false;
  return win;
}
function viewHarness() {
  const win = fakeWin(); const trusted = new Set(); const views = []; let n = 1;
  const createView = () => { const wc = new EventEmitter(); wc.id = n++; wc.loadURL = () => Promise.resolve(); wc.close = () => { throw new Error("already destroyed"); };
    const v = { webContents: wc, visible: true, setBounds() {}, setVisible(x) { v.visible = x; } }; views.push(v); return v; };
  return { win, trusted, views, host: createViewHost({ win, createView, baseMinimum: { width: 720, height: 520 }, trust: id => trusted.add(id), untrust: id => trusted.delete(id) }) };
}

test("render-process-gone and destroyed detach the view like a close (untrust, minimum restored, callbacks once)", () => {
  for (const [kind, evName] of [["results", "render-process-gone"], ["ritual", "render-process-gone"], ["results", "destroyed"], ["ritual", "destroyed"]]) {
    const h = viewHarness();
    const hd = h.host.attach(kind, "u");
    let calls = 0; hd.onClosed(() => calls++);
    const id = h.views[0].webContents.id;
    h.views[0].webContents.emit(evName, {}, { reason: "crashed" });
    assert.equal(calls, 1, kind + evName);
    assert.equal(h.trusted.has(id), false);
    assert.equal(h.host.current(), null);
    assert.equal(h.win.children.length, 0);
    assert.deepEqual(h.win.minimum, [720, 520]);
    h.views[0].webContents.emit("destroyed"); hd.close();
    assert.equal(calls, 1, "idempotent");
  }
});

test("setVisible hides/shows the attached view without detaching it", () => {
  const h = viewHarness();
  assert.equal(h.host.setVisible(false), false, "nothing attached");
  h.host.attach("results", "u");
  assert.equal(h.host.setVisible(false), true);
  assert.equal(h.views[0].visible, false);
  assert.equal(h.host.current(), "results");
  h.host.setVisible(true);
  assert.equal(h.views[0].visible, true);
});

// ---------- R52: question broker ----------
test("question broker: answer only while pending and only once; second concurrent ask refused; cancel answers false; garbage ignored", async () => {
  const sent = [];
  const b = createQuestionBroker({ send: p => sent.push(p) });
  assert.equal(b.answer(true), false, "nothing pending");
  const p1 = b.ask("permanent", WARNING);
  assert.equal(b.isPending(), true);
  assert.deepEqual(sent, [{ id: 1, kind: "permanent", message: WARNING }]);
  assert.equal(await b.ask("restore", "x"), false, "a second concurrent question is refused at once");
  assert.equal(sent.length, 1);
  assert.equal(b.answer("true"), false); assert.equal(b.answer(1), false); assert.equal(b.answer(undefined), false);
  assert.equal(b.isPending(), true, "garbage did not settle it");
  assert.equal(b.answer(true), true);
  assert.equal(await p1, true);
  assert.equal(b.answer(false), false, "duplicate answer ignored");
  assert.equal(b.isPending(), false);
  const p2 = b.ask("restore", "Restore text"); b.cancel();
  assert.equal(await p2, false);
  assert.equal(b.answer(true), false, "late answer after cancel ignored");
  b.cancel(); // nothing pending: no-op
  assert.equal(await b.ask("evil", "x"), false); assert.equal(await b.ask("permanent", 5), false);
  assert.equal(sent.length, 2);
  const bad = createQuestionBroker({ send: () => { throw new Error("no window"); } });
  assert.equal(await bad.ask("permanent", "x"), false);
  assert.equal(bad.isPending(), false);
});

test("nuke:question:answer and nuke:ritual:close: exact validation, main-window sender only", async () => {
  assert.ok(CHANNELS.includes("nuke:question:answer") && CHANNELS.includes("nuke:ritual:close") && EVENTS.includes("nuke:question"));
  assert.deepEqual(validateArgs("nuke:question:answer", [{ answer: true }]), { ok: true, value: { answer: true } });
  assert.deepEqual(validateArgs("nuke:question:answer", [{ answer: false }]), { ok: true, value: { answer: false } });
  for (const bad of [[], [{}], [{ answer: "yes" }], [{ answer: 1 }], [{ answer: null }], [{ answer: true, x: 1 }], [true], [[true]], [{ answer: true }, 1], [Object.create({ answer: true })], [{ get answer() { return true; } }]])
    assert.equal(validateArgs("nuke:question:answer", bad).ok, false, JSON.stringify(bad));
  assert.deepEqual(validateArgs("nuke:ritual:close", []), { ok: true, value: undefined });
  assert.equal(validateArgs("nuke:ritual:close", [{}]).ok, false);
  const handlers = new Map();
  const seen = [];
  const controller = { questionAnswer: async a => { seen.push(a); return { ok: true }; }, ritualClose: async () => { seen.push("close"); return { ok: true }; } };
  registerIpc({ handle: (c, f) => handlers.set(c, f) }, controller, () => true, e => e.main === true);
  assert.deepEqual(await handlers.get("nuke:question:answer")({ main: true }, { answer: true }), { ok: true });
  await assert.rejects(handlers.get("nuke:question:answer")({ main: false }, { answer: true }), /refused/, "results view cannot answer");
  await assert.rejects(handlers.get("nuke:ritual:close")({ main: false }), /refused/);
  await assert.rejects(handlers.get("nuke:question:answer")({ main: true }, { answer: "true" }), /refused/);
  assert.deepEqual(seen, [{ answer: true }]);
});

test("main.mjs: questions are in-window; one view at a time; results view hidden while asking; window close and quit answer false", () => {
  const s = rd("app/main/main.mjs");
  assert.match(s, /if \(!viewHost \|\| !live\(mainWindow\) \|\| viewHost\.current\(\) !== null\) return;/, "showResults refuses when any view is attached");
  assert.match(s, /viewHost\.setVisible\(false\)/);
  assert.match(s, /if \(!yes && viewHost\) viewHost\.setVisible\(true\)/);
  assert.match(s, /questionAnswer: async arg => \(\{ ok: questions\.answer\(arg && arg\.answer\) \}\)/);
  assert.match(s, /mainWindow\.on\("closed", \(\) => \{ questions\.cancel\(\);/);
  assert.match(s, /webContents\.send\("nuke:question", p\)/);
});

// ---------- controller: R51 ----------
const tick = () => new Promise(r => setImmediate(r));
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-f1-"));
  const la = path.join(root, "Local"); const junk = path.join(la, "Temp"); fs.mkdirSync(junk, { recursive: true });
  const paths = appDataPaths({ LOCALAPPDATA: la }); ensureAppData(paths);
  const f = n => { const p = path.join(junk, n); fs.writeFileSync(p, n.repeat(10)); return p; };
  return { root, junk, paths, f, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const vetted = p => makeFinding({ kind: "file", path: p, label: p, bytes: 10, safe: { ok: true }, basis: "vetted", oldEnough: true, locked: false, reason: "r", category: "Temporary files" });
function rig(t, { final = "done", onRitual } = {}) {
  const a = vetted(t.f("a" + final));
  const phases = []; const handle = { closed: 0, cbs: [], onClosed(cb) { this.cbs.push(cb); }, close() { this.closed++; for (const cb of this.cbs) cb(); } };
  const state = { v: "armed" };
  const server = { runId: "0123456789abcdef", getState: () => state.v, closed: false, close() { server.closed = true; } };
  const ui = { sendProgress() {}, sendPhase: p => phases.push(p), showResults() {}, closeResults() {}, pickFile: async () => null, pickFolder: async () => null,
    confirmPermanent: async () => true, askContinueWithoutRestore: async () => true, openRitual: () => { if (onRitual) setImmediate(() => onRitual(state, c)); return handle; } };
  const c = createController({ ui, paths: t.paths, identity: { sid: SID, elevated: false }, pollMs: 5, protectedPaths: [],
    runScan: async () => ({ kind: "smart", target: null, items: [a], allowedRoots: [t.junk], protectedPaths: [], notes: [], adminExtraBytes: null, partial: false }),
    restore: async () => ({ outcome: "made" }),
    startRun: async sel => ({ url: "http://127.0.0.1:1/?t=" + "e".repeat(64), server, selection: sel, sha256: sel.sha256, runId: server.runId }),
    readAudit: () => [{ state: "done", runId: "0123456789abcdef", measured: true, freedBytes: 20, results: [{ status: "deleted", bytes: 10 }] }] });
  return { a, c, phases, handle, state, server };
}

test("R51 done: the finished page stays attached with keepView; Done button path closes it, clears the scan and goes home", async () => {
  const t = tree();
  try {
    const r = rig(t, { onRitual: s => { s.v = "done"; } });
    await r.c.scanSmart();
    const out = await r.c.delete({ ids: [r.a.id] });
    assert.equal(out.ok, true);
    assert.equal(r.handle.closed, 0, "done does NOT close the page");
    const last = r.phases.at(-1);
    assert.equal(last.phase, "done"); assert.equal(last.keepView, true);
    assert.match(last.detail, /deleted/);
    await assert.rejects(r.c.delete({ ids: [r.a.id] }), /Another operation|refused/, "no new delete while the finished page is up");
    await assert.rejects(r.c.ritualCancel(), /refused/, "cancel makes no sense after the run");
    assert.deepEqual(await r.c.ritualClose(), { ok: true });
    assert.equal(r.handle.closed, 1);
    assert.deepEqual(r.phases.at(-1), { phase: "idle" });
    await assert.rejects(r.c.resultsGet(), /refused/, "last scan cleared");
    await assert.rejects(r.c.ritualClose(), /refused/, "second close refused");
  } finally { t.cleanup(); }
});

test("R51: ritualClose is refused before a terminal state (armed/unlocked/deleting) and when nothing is open; aborted/expired/failed auto-close", async () => {
  const t = tree();
  try {
    await assert.rejects(rig(t).c.ritualClose(), /refused/, "nothing open");
    let early;
    const r = rig(t, { onRitual: async (s, c) => { for (const v of ["armed", "unlocked", "deleting"]) { s.v = v; try { await c.ritualClose(); early = "accepted " + v; } catch { /* refused */ } } s.v = "done"; } });
    await r.c.scanSmart();
    await r.c.delete({ ids: [r.a.id] });
    assert.equal(early, undefined);
    assert.equal(r.handle.closed, 0);
    for (const final of ["expired", "aborted", "failed"]) {
      const x = rig(t, { final, onRitual: s => { s.v = final; } });
      await x.c.scanSmart();
      await x.c.delete({ ids: [x.a.id] });
      assert.equal(x.handle.closed, 1, final + " auto-closes");
      assert.notEqual(x.phases.at(-1).keepView, true);
      await assert.rejects(x.c.ritualClose(), /refused/);
    }
  } finally { t.cleanup(); }
});

test("cancel after the press is refused and the view stays attached", async () => {
  const t = tree();
  try {
    let err;
    const r = rig(t, { onRitual: async (s, c) => { s.v = "deleting"; try { await c.ritualCancel(); } catch (e) { err = e; } s.v = "done"; } });
    await r.c.scanSmart();
    await r.c.delete({ ids: [r.a.id] });
    assert.match(err.message, /refused/);
    assert.equal(r.handle.closed, 0, "view untouched");
    assert.equal(r.server.closed, false);
  } finally { t.cleanup(); }
});

test("a crashed ritual view before the press is treated as cancelled (server closed, nothing deleted)", async () => {
  const t = tree();
  try {
    const r = rig(t, { onRitual: s => { s.v = "unlocked"; r.handle.cbs.forEach(cb => cb()); } });
    await r.c.scanSmart();
    const out = await r.c.delete({ ids: [r.a.id] });
    assert.equal(out.cancelled, true);
    assert.equal(r.server.closed, true);
    assert.deepEqual(r.phases.at(-1), { phase: "done", detail: "Cancelled. Nothing was deleted." });
    await assert.rejects(r.c.ritualClose(), /refused/);
  } finally { t.cleanup(); }
});

// ---------- renderer ----------
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this._text = ""; this.hidden = false; this.disabled = false; this.checked = false; this.focused = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  focus() { this.focused = true; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  async fire(t) { for (const f of this.listeners[t] || []) await f({ target: this }); }
  walk(out = []) { out.push(this); for (const c of this.children) c.walk(out); return out; }
}
async function boot(over = {}) {
  const { createApp } = await import("../../app/renderer/main.js");
  const doc = { createElement: t => new El(t), createElementNS: (_n, t) => new El(t) };
  const app = new El("main"); doc.getElementById = id => (id === "app" ? app : null);
  const calls = [], h = {};
  const nuke = { getSettings: async () => ({ restorePoint: true }), setSettings: async s => s, getStatus: async () => ({ elevated: false }), scanSmart: async () => {}, scanInvestigate: async () => {}, scanFolder: async () => {},
    cancelScan: async () => {}, relaunchAdmin: async () => {}, cancelRitual: async () => calls.push("cancel"), closeRitual: async () => calls.push("close"),
    answerQuestion: async v => calls.push(["answer", v]), onPhase: cb => { h.phase = cb; return () => {}; }, onProgress: () => () => {}, onQuestion: cb => { h.question = cb; return () => {}; }, ...over };
  createApp(doc, nuke, () => ({ set() {}, destroy() {} }));
  return { app, h, calls };
}
const btn = (app, label) => app.walk().find(e => e.tagName === "button" && e.textContent === label);
const visible = app => app.walk().filter(e => e.tagName === "section" && !e.hidden);
const tick2 = () => new Promise(r => setImmediate(r));

test("done phase with keepView: the bar shows the outcome and 'Done - back to start' instead of Cancel; clicking calls closeRitual", async () => {
  const r = await boot();
  r.h.phase({ phase: "ritual" });
  assert.equal(btn(r.app, "Cancel - nothing will be deleted").hidden, false);
  assert.equal(btn(r.app, "Done - back to start").hidden, true);
  r.h.phase({ phase: "done", detail: "2 items deleted, 20 B freed", keepView: true });
  assert.equal(r.app.getAttribute("data-mode"), "ritual", "bar layout stays so the page below stays visible");
  assert.equal(btn(r.app, "Cancel - nothing will be deleted").hidden, true);
  const done = btn(r.app, "Done - back to start");
  assert.equal(done.hidden, false);
  assert.ok(visible(r.app)[0].textContent.includes("2 items deleted, 20 B freed"));
  await done.fire("click");
  assert.deepEqual(r.calls, ["close"]);
  r.h.phase({ phase: "idle" });
  assert.equal(r.app.getAttribute("data-mode"), "normal");
  // without keepView a done phase is the normal phase screen (view already gone)
  r.h.phase({ phase: "done", detail: "The app closed the confirmation automatically. Nothing was deleted." });
  assert.equal(r.app.getAttribute("data-mode"), "normal");
  assert.equal(btn(r.app, "Back").hidden, false);
});

test("question: exact permanent text, Continue/Cancel, focus on Cancel, answer sent once, 'no' returns to the previous screen", async () => {
  const r = await boot();
  r.h.phase({ phase: "results", detail: "Scan finished." });
  r.h.question({ id: 1, kind: "permanent", message: WARNING });
  const sec = visible(r.app)[0];
  assert.equal(sec.getAttribute("role"), "alertdialog");
  assert.ok(sec.textContent.startsWith(WARNING), sec.textContent);
  const inSec = l => sec.walk().find(e => e.tagName === "button" && e.textContent === l);
  const yes = inSec("Continue"), no = inSec("Cancel");
  assert.equal(no.focused, true, "default focus on the safe answer");
  assert.equal(yes.focused, false);
  await no.fire("click"); await no.fire("click"); await yes.fire("click");
  assert.deepEqual(r.calls, [["answer", false]], "one answer only");
  assert.ok(visible(r.app)[0].textContent.includes("Scan finished."), "back to the screen before the question");
});

test("question: restore variant uses the verbatim message and Stop; 'yes' leaves the next phase on screen", async () => {
  const r = await boot();
  r.h.phase({ phase: "restore", detail: "No restore point: administrator approval was not given." });
  const msg = "No restore point: administrator approval was not given. Continue without a restore point?";
  r.h.question({ id: 2, kind: "restore", message: msg });
  assert.ok(visible(r.app)[0].textContent.startsWith(msg));
  assert.equal(btn(r.app, "Stop").focused, true);
  assert.ok(btn(r.app, "Continue without a restore point"));
  const yes = btn(r.app, "Continue without a restore point");
  const p = yes.fire("click");
  r.h.phase({ phase: "ritual" }); // the next phase arrives before the invoke reply
  await p; await tick2();
  assert.equal(r.app.getAttribute("data-mode"), "ritual", "not pulled back by the late reply");
  assert.deepEqual(r.calls, [["answer", true]]);
});

test("question: malformed events are ignored and shown text is sanitised text", async () => {
  const r = await boot();
  const before = visible(r.app)[0];
  for (const bad of [null, "x", {}, { kind: "evil", message: "m" }, { kind: "permanent" }, { kind: "permanent", message: 5 }]) r.h.question(bad);
  assert.equal(visible(r.app)[0], before);
  r.h.question({ kind: "restore", message: "a‮b\u0000c" });
  assert.ok(visible(r.app)[0].textContent.startsWith("a b c"));
});

// ---------- page: no timer interval unless armed ----------
test("cleanup page: the countdown interval is not started when the boot state is not armed/unlocked", () => {
  const script = rd("cleanup.html");
  const grab = re => re.exec(script)[0];
  const code = [grab(/const put = .*\n/), grab(/let deadline = 0, timerHandle = null;\n/), grab(/function fmtClock\(ms\) \{.*\}\n/), /function renderTimer\(\) \{[\s\S]*?\n\}\n/.exec(script)[0], /function syncRemaining\(st\) \{[\s\S]*?\n\}\n/.exec(script)[0]].join("\n");
  let intervals = 0;
  const t = { hidden: false, className: "", textContent: "" };
  const ctx = vm.createContext({ $: () => t, performance: { now: () => 0 }, Math, Number, String, setInterval: () => { intervals++; return 1; }, serverState: "done" });
  vm.runInContext(code + "\nthis.syncRemaining = syncRemaining;", ctx);
  ctx.syncRemaining({ remainingMs: 5000 });
  assert.equal(intervals, 0);
  assert.equal(t.hidden, true);
  ctx.serverState = "armed"; ctx.syncRemaining({ remainingMs: 5000 });
  assert.equal(intervals, 1);
});
