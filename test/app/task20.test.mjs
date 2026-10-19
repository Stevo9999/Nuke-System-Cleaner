// Task 20: one window. Bounds helper, view lifecycle (attach/detach/replace, trusted ids), ritual cancel channel + controller path,
// the ritual bar in the main renderer, neutral page wording, /state remainingMs and the countdown timer.
// Display-less: Electron is not installed here, so the real WebContentsView behaviour is only source-tested (see report).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { computeRitualBounds, windowMinimum, createViewHost, RITUAL_BAR_HEIGHT, RITUAL_MIN, RESULTS_MIN } from "../../app/main/embedded-view.mjs";
import { registerIpc, trustedSender, MAIN_ONLY } from "../../app/main/ipc.mjs";
import { createController } from "../../app/main/controller.mjs";
import { appDataPaths, ensureAppData } from "../../app/main/appdata.mjs";
import { createCleanupServer, selectionHash } from "../../server.mjs";

const rd = rel => fs.readFileSync(fileURLToPath(new URL("../../" + rel, import.meta.url)), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- bounds ----------
test("computeRitualBounds: below the bar, full width, follows resize; garbage input stays finite and never negative", () => {
  assert.deepEqual(computeRitualBounds({ width: 1100, height: 760 }, 56, RITUAL_MIN), { x: 0, y: 56, width: 1100, height: 704 });
  assert.deepEqual(computeRitualBounds({ width: 1400, height: 900 }, 56, RITUAL_MIN), { x: 0, y: 56, width: 1400, height: 844 });
  assert.deepEqual(computeRitualBounds({ width: 1100, height: 760 }, 0, RESULTS_MIN), { x: 0, y: 0, width: 1100, height: 760 });
  // smaller than the minimum (cannot happen once the window minimum is raised): the view keeps its minimum size
  assert.deepEqual(computeRitualBounds({ width: 300, height: 100 }, 56, RITUAL_MIN), { x: 0, y: 56, width: 800, height: 600 });
  for (const bad of [null, undefined, {}, { width: NaN, height: Infinity }, { width: -5, height: "x" }]) {
    const b = computeRitualBounds(bad, 56, { width: 10, height: 10 });
    for (const k of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(b[k]) && b[k] >= 0, k);
  }
  const noMin = computeRitualBounds({ width: 50, height: 20 }, 56);
  assert.equal(noMin.height, 0);
  assert.equal(RITUAL_BAR_HEIGHT, 56);
  assert.match(rd("app/renderer/main.css"), new RegExp("--ritual-bar:\\s*" + RITUAL_BAR_HEIGHT + "px"), "CSS bar height equals the main-process constant");
});

test("windowMinimum: the ritual raises the main window minimum by the bar so 800x600 is kept", () => {
  assert.deepEqual(windowMinimum({ width: 720, height: 520 }, RITUAL_MIN, 56), { width: 800, height: 656 });
  assert.deepEqual(windowMinimum({ width: 900, height: 900 }, RITUAL_MIN, 56), { width: 900, height: 900 });
  assert.deepEqual(windowMinimum({ width: 720, height: 520 }, RESULTS_MIN, 0), { width: 720, height: 520 });
});

// ---------- lifecycle ----------
function fakeWin() {
  const win = new EventEmitter();
  win.children = []; win.minimum = null; win.destroyed = false; win.bounds = { x: 5, y: 5, width: 1100, height: 760 };
  win.contentView = { addChildView: v => win.children.push(v), removeChildView: v => { const i = win.children.indexOf(v); if (i < 0) throw new Error("not a child"); win.children.splice(i, 1); } };
  win.getContentBounds = () => win.bounds;
  win.setMinimumSize = (w, h) => { win.minimum = [w, h]; };
  win.isDestroyed = () => win.destroyed;
  return win;
}
function harness(over = {}) {
  const win = fakeWin();
  const trusted = new Set();
  const views = [];
  let nextId = 10;
  const createView = kind => {
    const wc = new EventEmitter();
    wc.id = nextId++; wc.loaded = []; wc.closed = false; wc.focused = false;
    wc.loadURL = u => { wc.loaded.push(u); return over.loadFails ? Promise.reject(new Error("failed " + u)) : Promise.resolve(); };
    wc.close = () => { wc.closed = true; };
    wc.focus = () => { wc.focused = true; };
    const v = { kind, webContents: wc, bounds: null, setBounds(b) { v.bounds = b; } };
    views.push(v);
    return v;
  };
  const host = createViewHost({ win, createView, baseMinimum: { width: 720, height: 520 }, trust: id => trusted.add(id), untrust: id => trusted.delete(id) });
  return { win, trusted, views, host };
}

test("attach: view is a child of the content view at the right bounds, minimum raised, focused, url loaded once; results id is trusted, ritual id is not", async () => {
  const h = harness();
  const r = h.host.attach("ritual", "http://127.0.0.1:5/?t=" + "a".repeat(64));
  assert.equal(h.host.current(), "ritual");
  assert.equal(h.win.children.length, 1);
  assert.deepEqual(h.views[0].bounds, { x: 0, y: 56, width: 1100, height: 704 });
  assert.deepEqual(h.win.minimum, [800, 656]);
  assert.equal(h.views[0].webContents.focused, true);
  assert.deepEqual(h.views[0].webContents.loaded, ["http://127.0.0.1:5/?t=" + "a".repeat(64)]);
  assert.equal(h.trusted.size, 0, "the ritual page never gets the IPC bridge, so its id is never trusted");
  r.close();
  const x = h.host.attach("results", "app://ui/results.html");
  assert.ok(h.trusted.has(h.views[1].webContents.id), "results view id is trusted while attached");
  assert.deepEqual(h.views[1].bounds, { x: 0, y: 0, width: 1100, height: 760 });
  assert.deepEqual(h.win.minimum, [720, 520]);
  assert.equal(x.kind, "results");
});

test("resize: bounds follow the content area; the listener is removed on close", () => {
  const h = harness();
  const hd = h.host.attach("ritual", "http://127.0.0.1:5/?t=x");
  h.win.bounds = { x: 0, y: 0, width: 1500, height: 1000 };
  h.win.emit("resize");
  assert.deepEqual(h.views[0].bounds, { x: 0, y: 56, width: 1500, height: 944 });
  hd.close();
  assert.equal(h.win.listenerCount("resize"), 0);
  h.win.bounds = { x: 0, y: 0, width: 900, height: 700 };
  h.win.emit("resize");
  assert.deepEqual(h.views[0].bounds, { x: 0, y: 56, width: 1500, height: 944 }, "no update after detach");
});

test("close: view removed and destroyed, trusted id removed (never reused as trusted), minimum restored, callbacks once, idempotent", () => {
  const h = harness();
  const hd = h.host.attach("results", "app://ui/results.html");
  const id = h.views[0].webContents.id;
  let calls = 0;
  hd.onClosed(() => calls++);
  hd.onClosed("not a function");
  hd.close(); hd.close();
  assert.equal(calls, 1);
  assert.equal(h.win.children.length, 0);
  assert.equal(h.views[0].webContents.closed, true);
  assert.equal(h.trusted.has(id), false);
  assert.equal(h.host.current(), null);
  assert.deepEqual(h.win.minimum, [720, 520]);
  h.host.closeAll(); // nothing attached: no-op
});

test("one view at a time: same kind twice throws; another kind replaces silently (old id untrusted, no closed callback)", () => {
  const h = harness();
  const a = h.host.attach("results", "app://ui/results.html");
  let fired = 0;
  a.onClosed(() => fired++);
  assert.throws(() => h.host.attach("results", "app://ui/results.html"), /already/);
  const idA = h.views[0].webContents.id;
  h.host.attach("ritual", "http://127.0.0.1:5/?t=x");
  assert.equal(h.win.children.length, 1);
  assert.equal(h.win.children[0], h.views[1]);
  assert.equal(h.trusted.has(idA), false);
  assert.equal(fired, 0);
  assert.equal(h.host.current(), "ritual");
  assert.deepEqual(h.win.minimum, [800, 656]);
  assert.throws(() => h.host.attach("evil", "x"));
  assert.throws(() => h.host.attach("results", "x") && h.host.attach("results", "x"));
});

test("failed main-frame load closes the view (callbacks fire); sub-frame failures are ignored; loadURL rejection is swallowed", async () => {
  const h = harness({ loadFails: true });
  const hd = h.host.attach("ritual", "http://127.0.0.1:5/?t=" + "b".repeat(64));
  let fired = 0;
  hd.onClosed(() => fired++);
  await sleep(5); // the rejected loadURL promise was caught (otherwise this test process would crash)
  h.views[0].webContents.emit("did-fail-load", {}, -2, "x", "u", false);
  assert.equal(fired, 0);
  h.views[0].webContents.emit("did-fail-load", {}, -2, "x", "u", true);
  assert.equal(fired, 1);
  assert.equal(h.host.current(), null);
});

test("attach on a destroyed window or a failing view creation throws and leaves nothing trusted or attached", () => {
  const h = harness();
  h.win.destroyed = true;
  assert.throws(() => h.host.attach("results", "app://ui/results.html"));
  h.win.destroyed = false;
  const bad = createViewHost({ win: h.win, baseMinimum: { width: 1, height: 1 }, createView: () => { throw new Error("boom"); }, trust: id => h.trusted.add(id) });
  assert.throws(() => bad.attach("results", "u"), /boom/);
  assert.equal(bad.current(), null);
  assert.equal(h.trusted.size, 0);
  // addChildView throwing after trust(): everything is rolled back
  const w2 = fakeWin(); w2.contentView.addChildView = () => { throw new Error("nope"); };
  const t2 = new Set();
  const h2 = createViewHost({ win: w2, baseMinimum: { width: 1, height: 1 }, trust: id => t2.add(id), untrust: id => t2.delete(id),
    createView: () => { const wc = new EventEmitter(); wc.id = 77; wc.loadURL = () => Promise.resolve(); wc.close = () => {}; return { webContents: wc, setBounds() {} }; } });
  assert.throws(() => h2.attach("results", "u"), /nope/);
  assert.equal(t2.size, 0);
  assert.equal(h2.current(), null);
});

test("trusted-sender integration: a detached results view's id no longer passes trustedSender", () => {
  const h = harness();
  h.host.attach("results", "app://ui/results.html");
  const id = h.views[0].webContents.id;
  const ev = () => ({ senderFrame: { url: "app://ui/results.html", parent: null }, sender: { id } });
  assert.equal(trustedSender(ev(), h.trusted), true);
  h.host.closeAll();
  assert.equal(trustedSender(ev(), h.trusted), false);
});

// ---------- IPC: nuke:ritual:cancel is main-window only ----------
test("ritual cancel channel: validated no-arg, trusted sender AND main window only", async () => {
  assert.deepEqual([...MAIN_ONLY], ["nuke:ritual:cancel", "nuke:ritual:close", "nuke:question:answer", "nuke:tools:list", "nuke:tools:open", "nuke:exclusions:add", "nuke:exclusions:remove"]);
  const handlers = new Map();
  const ipc = { handle: (ch, fn) => handlers.set(ch, fn) };
  let called = 0;
  const controller = { ritualCancel: async () => { called++; return { ok: true }; } };
  const ok = () => true;
  registerIpc(ipc, controller, ok, e => e.main === true);
  const h = handlers.get("nuke:ritual:cancel");
  assert.deepEqual(await h({ main: true }), { ok: true });
  await assert.rejects(h({ main: false }), /refused/, "results view sender refused");
  await assert.rejects(h({ main: true }, "x"), /refused/, "arguments refused");
  await assert.rejects(h({ main: true }, {}), /refused/);
  assert.equal(called, 1);
  const h2 = new Map();
  registerIpc({ handle: (c, f) => h2.set(c, f) }, controller, ok); // no isMain: fail closed
  await assert.rejects(h2.get("nuke:ritual:cancel")({}), /refused/);
  const h3 = new Map();
  registerIpc({ handle: (c, f) => h3.set(c, f) }, controller, () => false, () => true);
  await assert.rejects(h3.get("nuke:ritual:cancel")({ main: true }), /refused/, "untrusted sender refused even if main");
  const h4 = new Map();
  registerIpc({ handle: (c, f) => h4.set(c, f) }, controller, ok, () => { throw new Error("x"); });
  await assert.rejects(h4.get("nuke:ritual:cancel")({}), /refused/);
});

// ---------- controller: ritualCancel ----------
function ctlHarness(states) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-t20-"));
  const paths = appDataPaths({ LOCALAPPDATA: path.join(root, "Local") });
  ensureAppData(paths);
  const phases = [];
  let ritualHandle;
  const ui = {
    sendProgress() {}, sendPhase: p => phases.push(p), showResults() {}, closeResults() {}, pickFile: async () => null, pickFolder: async () => null,
    confirmPermanent: async () => true, askContinueWithoutRestore: async () => true,
    openRitual: () => { ritualHandle = { cbs: [], closed: 0, onClosed(cb) { this.cbs.push(cb); }, close() { this.closed++; for (const cb of this.cbs) cb(); } }; return ritualHandle; },
  };
  let closedServer = false;
  const server = { runId: "0123456789abcdef", getState: () => states.state, close() { closedServer = true; } };
  const c = createController({ ui, paths, identity: { sid: "S-1-5-21-1-2-3-1001", elevated: false }, runScan: async () => ({}), pollMs: 5,
    restore: async () => ({ outcome: "made" }), startRun: async () => ({ url: "http://127.0.0.1:1/?t=" + "f".repeat(64), server, runId: server.runId, sha256: "0".repeat(64), selection: {} }),
    protectedPaths: [] });
  return { c, ui, phases, server, handle: () => ritualHandle, root, isClosed: () => closedServer, paths };
}

test("ritualCancel: refused when no confirmation is up", async () => {
  const h = ctlHarness({ state: "armed" });
  try { await assert.rejects(h.c.ritualCancel(), /refused/); } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test("source: controller.ritualCancel closes via the same path as closing the page (armed/unlocked only) and the run end closes the view", () => {
  const s = rd("app/main/controller.mjs");
  assert.match(s, /async ritualCancel\(\) \{[\s\S]*?state !== "armed" && state !== "unlocked"\) throw refused\(\);[\s\S]*?c\.close\(\);/);
  assert.match(s, /if \(state === "done"\) ctx\.keep = true; else closeWindow\(\);/);
  assert.ok(!/server/i.test(s.match(/const TEXT = Object\.freeze\(\{[\s\S]*?\}\);/)[0]), "no user-visible text says 'server'");
  assert.match(s, /expired: "The app closed the confirmation automatically\. Nothing was deleted\."/);
});

// ---------- main renderer ritual bar ----------
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this._text = ""; this.hidden = false; this.disabled = false; this.checked = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  async fire(t) { for (const f of this.listeners[t] || []) await f({ target: this }); }
  walk(out = []) { out.push(this); for (const c of this.children) c.walk(out); return out; }
}
async function bootRenderer(over = {}) {
  const { createApp } = await import("../../app/renderer/main.js");
  const doc = { createElement: t => new El(t), createElementNS: (_n, t) => new El(t) };
  const app = new El("main");
  doc.getElementById = id => (id === "app" ? app : null);
  const calls = [], handlers = {};
  const nuke = { getSettings: async () => ({ restorePoint: true }), setSettings: async s => s, getStatus: async () => ({ elevated: false }), scanSmart: async () => {}, scanInvestigate: async () => {},
    scanFolder: async () => {}, cancelScan: async () => {}, relaunchAdmin: async () => {}, cancelRitual: async () => { calls.push("cancelRitual"); }, onPhase: cb => { handlers.phase = cb; return () => {}; }, onProgress: () => () => {}, ...over };
  createApp(doc, nuke, () => ({ set() {}, destroy() {} }));
  return { app, nuke, handlers, calls };
}
const byClass = (app, cls) => app.walk().filter(e => (e.getAttribute("class") || "").split(" ").includes(cls));

test("ritual phase shows only the bar with a visible Cancel control; it calls the new channel; the page below is not described as a window", async () => {
  const r = await bootRenderer();
  r.handlers.phase({ phase: "ritual" });
  assert.equal(r.app.getAttribute("data-mode"), "ritual");
  const bar = byClass(r.app, "ritual-bar")[0];
  assert.equal(bar.hidden, false);
  assert.equal(byClass(r.app, "screen").filter(e => !e.hidden).length, 1, "nothing else on screen");
  assert.ok(/final confirmation is below/.test(bar.textContent) && !/Nuke window/.test(bar.textContent));
  const cancel = bar.walk().find(e => e.tagName === "button");
  assert.equal(cancel.textContent, "Cancel - nothing will be deleted");
  await cancel.fire("click");
  assert.deepEqual(r.calls, ["cancelRitual"]);
  assert.equal(cancel.disabled, false);
  // the outcome arrives as a normal phase: normal layout again, text says nothing was deleted
  r.handlers.phase({ phase: "done", detail: "Cancelled. Nothing was deleted." });
  assert.equal(r.app.getAttribute("data-mode"), "normal");
  assert.equal(byClass(r.app, "phase-text")[0].textContent, "Cancelled. Nothing was deleted.");
});

test("a failed ritual cancel shows a message in the bar; AbortError is silent", async () => {
  const r = await bootRenderer({ cancelRitual: async () => { throw new Error("Error invoking remote method 'nuke:ritual:cancel': Error: refused"); } });
  r.handlers.phase({ phase: "ritual" });
  const bar = byClass(r.app, "ritual-bar")[0];
  await bar.walk().find(e => e.tagName === "button").fire("click");
  const err = bar.walk().find(e => e.getAttribute("class") === "error");
  assert.equal(err.hidden, false);
  assert.ok(err.textContent.length > 0);
});

test("phases/main renderer wording: no 'Nuke window' or 'results window' left", () => {
  for (const f of ["app/renderer/phases.js", "app/renderer/main.js", "app/main/controller.mjs", "app/main/main.mjs"]) {
    const s = rd(f);
    assert.ok(!/Nuke window|Review the results window/.test(s), f);
  }
});

// ---------- page: neutral wording + countdown ----------
const page = rd("cleanup.html");
const script = page.slice(page.indexOf('<script type="module">'));

test("cleanup page is neutral for the app and /nuke: Begin button, 'Final confirmation' headline, no session id or 'Session cleanup'", () => {
  assert.match(page, /<button id="arm" title="Begin" disabled><b>&#9762;<\/b> Begin<\/button>/);
  assert.ok(script.includes("$('#idle').textContent = 'Press Begin to start the final confirmation';"));
  assert.ok(script.includes("el('b', 'Final confirmation')"));
  assert.ok(!/Session cleanup|session ' \+ String|Click "/.test(page));
  // the armed/unlock/confirm protocol and the glass logic are untouched
  assert.match(script, /\$\('#arm'\)\.disabled = false;/);
  assert.match(script, /postApi\('unlock'\)/);
  assert.match(script, /canPress\(serverState, glassAngle\)/);
});

test("page text never says 'server' to the user; the old expiry sentence is gone; the new one is present", () => {
  const strings = [...script.matchAll(/'([^'\n]*)'/g)].map(m => m[1]).filter(t => /\s/.test(t) || /server/i.test(t));
  for (const t of strings) assert.ok(!/\bserver\b/i.test(t), "user-visible string mentions server: " + t);
  assert.ok(!/expires in 10 minutes/.test(page));
  assert.ok(script.includes("The app will close automatically if you do not finish in time."));
  assert.ok(script.includes("The app closed the confirmation automatically. Nothing was deleted."));
});

test("timer: element exists, rendered through put(); countdown uses the app's remainingMs and goes urgent in the last minute", () => {
  assert.match(page, /<div id="timer" role="timer" hidden><\/div>/);
  assert.match(page, /#timer\.urgent \{[^}]*background:#c0261c/);
  const grab = re => re.exec(script)[0];
  const code = [grab(/const put = .*\n/), grab(/let deadline = 0, timerHandle = null;\n/), grab(/function fmtClock\(ms\) \{.*\}\n/), /function renderTimer\(\) \{[\s\S]*?\n\}\n/.exec(script)[0], /function syncRemaining\(st\) \{[\s\S]*?\n\}\n/.exec(script)[0]].join("\n");
  const t = { textContent: "", className: "", hidden: true, writes: 0 };
  Object.defineProperty(t, "textContent", { get() { return this._t || ""; }, set(v) { this._t = v; this.writes++; } });
  let now = 1000, intervals = 0;
  const ctx = vm.createContext({ $: () => t, performance: { now: () => now }, Math, Number, String, setInterval: () => { intervals++; return 1; }, serverState: "armed" });
  vm.runInContext(code + "\nthis.syncRemaining = syncRemaining; this.renderTimer = renderTimer; this.fmtClock = fmtClock;", ctx);
  assert.equal(ctx.fmtClock(600000), "10:00"); assert.equal(ctx.fmtClock(59001), "01:00"); assert.equal(ctx.fmtClock(0), "00:00"); assert.equal(ctx.fmtClock(-5), "00:00");
  ctx.syncRemaining({ remainingMs: 125000 });
  assert.equal(t.hidden, false);
  assert.equal(t.textContent, "Closes automatically in 02:05");
  assert.equal(t.className, "");
  now += 70000; ctx.renderTimer();
  assert.equal(t.textContent, "Closes automatically in 00:55");
  assert.equal(t.className, "urgent");
  const w = t.writes; ctx.renderTimer(); assert.equal(t.writes, w, "write-on-change");
  for (const bad of [{}, { remainingMs: NaN }, { remainingMs: -1 }, { remainingMs: "9" }, null]) { now += 1; ctx.syncRemaining(bad); }
  assert.equal(t.textContent, "Closes automatically in 00:55", "garbage does not move the deadline");
  ctx.syncRemaining({ remainingMs: 500000 });
  assert.equal(t.textContent, "Closes automatically in 08:20", "re-sync replaces the deadline");
  assert.equal(intervals, 1, "one interval only");
  ctx.serverState = "expired"; ctx.renderTimer();
  assert.equal(t.hidden, true, "hidden once the confirmation ended");
});

// ---------- server /state remainingMs ----------
test("/state carries remainingMs (finite, decreasing, never negative, no token); expiry behaviour unchanged", async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "srv20-"));
  try {
    const root = path.join(t, "work"); fs.mkdirSync(root, { recursive: true });
    const a = path.join(root, "a.txt"); fs.writeFileSync(a, "x");
    const sel = { sessionId: "S", allowedRoots: [root], protectedPaths: [], livePaths: [], paths: [a] };
    sel.sha256 = selectionHash(sel);
    const selectionFile = path.join(t, "selection.json"); fs.writeFileSync(selectionFile, JSON.stringify(sel));
    const pageFile = path.join(t, "page.html"); fs.writeFileSync(pageFile, "<html></html>");
    const soundsDir = path.join(t, "sounds"); fs.mkdirSync(soundsDir);
    const s = createCleanupServer({ selectionFile, pageFile, soundsDir, ttlMs: 400, minGapMs: 100, afterDoneMs: 50, ageCheckOffForTests: true });
    const { port } = await s.listen();
    const get = () => new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port, path: `/state?t=${s.token}`, agent: false }, res => { let d = ""; res.on("data", x => d += x); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject));
    const one = await get();
    assert.ok(Number.isFinite(one.remainingMs) && one.remainingMs > 0 && one.remainingMs <= 400, String(one.remainingMs));
    assert.ok(!JSON.stringify(one).includes(s.token));
    await sleep(120);
    const two = await get();
    assert.ok(two.remainingMs < one.remainingMs && two.remainingMs >= 0);
    for (let i = 0; i < 100 && s.getState() === "armed"; i++) await sleep(20);
    assert.equal(s.getState(), "expired");
    assert.ok(fs.existsSync(a), "nothing deleted on expiry");
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
