import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rd = n => readFileSync(new URL("../../app/renderer/" + n, import.meta.url), "utf8");
const HTML = rd("index.html"), JS = rd("main.js"), CSS = rd("main.css");

// Minimal fake DOM (no jsdom).
class El {
  constructor(doc, tag) { this.ownerDocument = doc; this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this._text = ""; this.hidden = false; this.checked = false; this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  async fire(t) { for (const f of this.listeners[t] || []) await f({ target: this }); }
  walk(out = []) { out.push(this); for (const c of this.children) c.walk(out); return out; }
}
function fakeDoc() {
  const doc = { root: null };
  doc.createElement = t => new El(doc, t);
  doc.createElementNS = (_ns, t) => new El(doc, t);
  const app = new El(doc, "main");
  doc.getElementById = id => (id === "app" ? app : null);
  doc.app = app;
  return doc;
}
function fakeNuke(over = {}) {
  const calls = [], handlers = {};
  const n = {
    calls, handlers,
    getSettings: async () => { calls.push(["getSettings"]); return { restorePoint: true }; },
    setSettings: async s => { calls.push(["setSettings", s]); return s; },
    getStatus: async () => { calls.push(["getStatus"]); return { elevated: false }; },
    scanSmart: async () => { calls.push(["scanSmart"]); },
    scanInvestigate: async () => { calls.push(["scanInvestigate"]); },
    scanFolder: async () => { calls.push(["scanFolder"]); },
    cancelScan: async () => { calls.push(["cancelScan"]); },
    relaunchAdmin: async () => { calls.push(["relaunchAdmin"]); },
    onPhase: cb => { handlers.phase = cb; return () => { handlers.phase = null; }; },
    onProgress: cb => { handlers.progress = cb; return () => { handlers.progress = null; }; },
    ...over,
  };
  return n;
}
const find = (doc, pred) => doc.app.walk().filter(pred);
const btn = (doc, label) => find(doc, e => e.tagName === "button" && e.textContent === label)[0];
const tick = () => new Promise(r => setImmediate(r));
async function boot(over) {
  const { createApp } = await import("../../app/renderer/main.js");
  const doc = fakeDoc(), nuke = fakeNuke(over);
  const mounts = [];
  const app = createApp(doc, nuke, (host, o) => { const m = { host, o, sets: [], destroyed: false, set: (...a) => m.sets.push(a), destroy: () => { m.destroyed = true; } }; mounts.push(m); return m; });
  return { doc, nuke, app, mounts };
}

test("phaseText exact strings for restore and ritual; unknown phase -> generic text", async () => {
  const { phaseText, PHASES } = await import("../../app/renderer/phases.js");
  assert.deepEqual(PHASES, ["idle", "scanning", "results", "warning", "restore", "checking", "ritual", "deleting", "done", "error"]);
  assert.equal(phaseText("restore"), "Windows is creating a system restore point");
  assert.equal(phaseText("ritual"), "The final confirmation is below: turn the key, lift the glass cover and press the red button");
  assert.equal(phaseText("done", "Freed 3 MB"), "Freed 3 MB");
  assert.equal(phaseText("error", "Boom"), "Boom");
  assert.equal(phaseText("error"), "Something went wrong");
  assert.equal(phaseText("done", 42), "Finished");
  assert.equal(phaseText("nonsense"), "Working\u2026");
  assert.equal(phaseText(undefined, "x"), "Working\u2026");
  assert.equal(phaseText("done", "a\u0000b\nc"), "a b c");
});

test("index.html: exact module script, no inline script/style/handlers, no remote", () => {
  assert.match(HTML, /<script type="module" src="main\.js"><\/script>/);
  assert.equal((HTML.match(/<script/g) || []).length, 1);
  assert.doesNotMatch(HTML, /\sstyle\s*=|<style|\son[a-z]+\s*=|https?:|javascript:/i);
  assert.match(HTML, /href="main\.css"/);
});

test("the four exact button labels exist in the UI", async () => {
  const { doc } = await boot();
  for (const l of ["Scan", "Manually find a file to investigate", "Pick a folder to investigate", "Settings"]) assert.ok(btn(doc, l), l);
});

test("main.js: only window.nuke, textContent only, no innerHTML/eval/new Function/fetch/http/ipcRenderer", () => {
  assert.doesNotMatch(JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|https?:|ipcRenderer|require\(|\.style\b|setAttribute\(\s*["']style/);
  assert.match(JS, /\.textContent\s*=/);
  assert.match(JS, /window\.nuke/);
  const imports = [...JS.matchAll(/^import .* from "([^"]+)"/gm)].map(m => m[1]);
  assert.deepEqual(imports.sort(), ["./credits.js", "./detective.js", "./phases.js"]);
  assert.doesNotMatch(CSS, /url\(|@import|https?:/);
});

test("buttons call exactly the matching nuke function", async () => {
  const { doc, nuke } = await boot();
  await btn(doc, "Scan").fire("click");
  await btn(doc, "Manually find a file to investigate").fire("click");
  await btn(doc, "Pick a folder to investigate").fire("click");
  assert.deepEqual(nuke.calls.map(c => c[0]).filter(n => n !== "getStatus"), ["scanSmart", "scanInvestigate", "scanFolder"]);
});

test("administrator mode: Investigate and Pick-folder are hidden once the status says elevated; shown otherwise", async () => {
  for (const [status, hidden] of [[{ elevated: true }, true], [{ elevated: false }, false], [{ elevated: null }, false], [null, false]]) {
    let reads = 0;
    const { doc } = await boot({ getStatus: async () => { reads++; if (status === null) throw new Error("x"); return status; } });
    await tick(); await tick();
    assert.ok(reads >= 1, "status is read at start");
    assert.equal(btn(doc, "Manually find a file to investigate").parent.hidden, hidden, JSON.stringify(status));
    assert.equal(btn(doc, "Pick a folder to investigate").parent.hidden, hidden, JSON.stringify(status));
    assert.equal(btn(doc, "Scan").hidden, false);
  }
});

test("R44: unknown mode shows the fixed delete-off text on the status line and hides relaunch", async () => {
  const { FIXED_MESSAGES } = await import("../../app/renderer/main.js");
  const { doc } = await boot({ getStatus: async () => ({ elevated: null }) });
  await btn(doc, "Settings").fire("click");
  await tick(); await tick();
  assert.equal(find(doc, e => e.getAttribute("class") === "mode")[0].textContent, FIXED_MESSAGES.identityUnknown);
  assert.equal(btn(doc, "Relaunch as administrator").parent.hidden, true);
});

test("relaunch: the fixed timeout and cancel texts reach the user (through Electron's invoke wrapper too)", async () => {
  const { FIXED_MESSAGES } = await import("../../app/renderer/main.js");
  const alertText = doc => find(doc, e => e.getAttribute("role") === "alert" && !e.hidden).map(e => e.textContent);
  let r = await boot({ relaunchAdmin: async () => { throw new Error("Error invoking remote method 'nuke:admin:relaunch': Error: " + FIXED_MESSAGES.relaunchTimeout); } });
  await btn(r.doc, "Settings").fire("click"); await tick(); await tick();
  await btn(r.doc, "Relaunch as administrator").fire("click");
  assert.deepEqual(alertText(r.doc), [FIXED_MESSAGES.relaunchTimeout]);
  r = await boot({ relaunchAdmin: async () => ({ ok: false, cancelled: true }) });
  await btn(r.doc, "Settings").fire("click"); await tick(); await tick();
  await btn(r.doc, "Relaunch as administrator").fire("click");
  assert.deepEqual(alertText(r.doc), [FIXED_MESSAGES.relaunchCancelled]);
  // any other wrapped error is still the generic text (no engine text leaks)
  r = await boot({ relaunchAdmin: async () => { throw new Error("Error invoking remote method 'nuke:admin:relaunch': Error: C:\\secret"); } });
  await btn(r.doc, "Settings").fire("click"); await tick(); await tick();
  await btn(r.doc, "Relaunch as administrator").fire("click");
  assert.deepEqual(alertText(r.doc), ["Something went wrong. Please try again."]);
});

test("restore switch reflects getSettings and writes setSettings({restorePoint}) only; relaunch hidden when elevated", async () => {
  for (const [stored, elevated] of [[false, false], [true, true]]) {
    const { doc, nuke } = await boot({
      getSettings: async () => ({ restorePoint: stored }),
      getStatus: async () => ({ elevated, canRelaunchAdmin: true }),
    });
    await btn(doc, "Settings").fire("click");
    await tick(); await tick();
    const sw = find(doc, e => e.tagName === "input")[0];
    assert.equal(sw.getAttribute("role"), "switch");
    assert.equal(sw.checked, stored);
    const label = find(doc, e => e.textContent === "Create a system restore point before deleting");
    assert.ok(label.length >= 1);
    const mode = find(doc, e => e.getAttribute("class") === "mode")[0];
    assert.equal(mode.textContent, elevated ? "Administrator mode" : "Standard mode");
    assert.equal(btn(doc, "Relaunch as administrator").parent.hidden, elevated);
    sw.checked = !stored;
    await sw.fire("change");
    const sets = nuke.calls.filter(c => c[0] === "setSettings");
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0][1], { restorePoint: !stored, plainConfirm: false });
    assert.deepEqual(Object.keys(sets[0][1]), ["restorePoint", "plainConfirm"]);
  }
});

test("switch reverts and shows error when setSettings rejects; relaunch calls relaunchAdmin", async () => {
  const { doc, nuke } = await boot({ setSettings: async () => { throw new Error("nope"); } });
  await btn(doc, "Settings").fire("click");
  await tick(); await tick();
  const sw = find(doc, e => e.tagName === "input")[0];
  assert.equal(sw.checked, true);
  sw.checked = false;
  await sw.fire("change");
  assert.equal(sw.checked, true);
  assert.ok(find(doc, e => e.getAttribute("role") === "alert" && e.textContent === "nope" && !e.hidden).length === 1);
  await btn(doc, "Relaunch as administrator").fire("click");
  assert.ok(nuke.calls.some(c => c[0] === "relaunchAdmin"));
});

test("scanning phase mounts detective, progress feeds it, Cancel calls cancelScan, leaving destroys it", async () => {
  const { doc, nuke, app, mounts } = await boot();
  nuke.handlers.phase({ phase: "scanning" });
  assert.equal(mounts.length, 1);
  nuke.handlers.progress({ fraction: 0.4, label: "C:\\<b>x</b>" });
  assert.deepEqual(mounts[0].sets[0], [0.4, "C:\\<b>x</b>"]);
  nuke.handlers.progress({ fraction: "bad" });
  assert.deepEqual(mounts[0].sets[1], [null, undefined]);
  await btn(doc, "Cancel").fire("click");
  assert.ok(nuke.calls.some(c => c[0] === "cancelScan"));
  nuke.handlers.phase({ phase: "restore" });
  assert.equal(mounts[0].destroyed, true);
  app.destroy();
  assert.equal(nuke.handlers.phase, null);
});

test("phase screen shows phaseText via textContent (untrusted detail stays text)", async () => {
  const { doc, nuke } = await boot();
  nuke.handlers.phase({ phase: "warning" });
  const line = find(doc, e => e.getAttribute("class") === "phase-text")[0];
  assert.equal(line.textContent, "Review the warning before anything is deleted");
  nuke.handlers.phase({ phase: "done", detail: "<img src=x onerror=alert(1)>" });
  assert.equal(line.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(line.children.length, 0);
});

test("a rejected scan shows an error on home; AbortError is silent", async () => {
  const { doc } = await boot({ scanSmart: async () => { throw new Error("bad scan"); } });
  await btn(doc, "Scan").fire("click");
  const err = find(doc, e => e.getAttribute("class") === "error" && e.textContent === "bad scan");
  assert.equal(err.length, 1);
  assert.equal(err[0].hidden, false);
  const b = await boot({ scanSmart: async () => { const e = new Error("a"); e.name = "AbortError"; throw e; } });
  await btn(b.doc, "Scan").fire("click");
  assert.equal(find(b.doc, e => e.getAttribute("class") === "error" && !e.hidden).length, 0);
});

// ---- Fix round 1 ----
const REMOTE_ABORT = "Error invoking remote method 'nuke:scan:smart': AbortError: The operation was aborted";

test("R1 getSettings failure: switch disabled, shown unknown (not ON), error shown and cleared on next successful load", async () => {
  let fail = true;
  const { doc } = await boot({ getSettings: async () => { if (fail) throw new Error("disk broke"); return { restorePoint: false }; } });
  await btn(doc, "Settings").fire("click");
  await tick(); await tick();
  const sw = find(doc, e => e.tagName === "input")[0];
  assert.equal(sw.disabled, true);
  assert.equal(sw.checked, false);
  assert.ok(find(doc, e => e.getAttribute("class") === "switch-state" && /unknown/i.test(e.textContent)).length === 2);
  const err = find(doc, e => e.getAttribute("class") === "error" && e.textContent === "disk broke" && !e.hidden);
  assert.equal(err.length, 1);
  fail = false;
  await btn(doc, "Back").fire("click");
  await btn(doc, "Settings").fire("click");
  await tick(); await tick();
  assert.equal(sw.disabled, false);
  assert.equal(sw.checked, false);
  assert.equal(err[0].hidden, true);
});

test("R1 a stale pending load never overwrites a newer toggle", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { doc, nuke } = await boot({ getSettings: async () => { await gate; return { restorePoint: true }; } });
  await btn(doc, "Settings").fire("click");
  const sw = find(doc, e => e.tagName === "input")[0];
  sw.checked = false;
  await sw.fire("change");
  release();
  await tick(); await tick();
  assert.equal(sw.checked, false);
  assert.deepEqual(nuke.calls.filter(c => c[0] === "setSettings")[0][1], { restorePoint: false, plainConfirm: false });
});

test("R1 double-click Scan starts exactly one scan; buttons disabled until it settles", async () => {
  let done;
  const { doc, nuke } = await boot({ scanSmart: async function () { nuke.calls.push(["scanSmart"]); await new Promise(r => { done = r; }); } });
  const scan = btn(doc, "Scan");
  const a = scan.fire("click"); const b = scan.fire("click");
  await btn(doc, "Pick a folder to investigate").fire("click");
  await btn(doc, "Manually find a file to investigate").fire("click");
  assert.equal(nuke.calls.filter(c => c[0].startsWith("scan")).length, 1);
  assert.equal(scan.disabled, true);
  assert.equal(btn(doc, "Pick a folder to investigate").disabled, true);
  done(); await a; await b;
  assert.equal(scan.disabled, false);
});

test("R1 realistic remote AbortError is silent and returns home", async () => {
  const { doc } = await boot({ scanSmart: async () => { throw new Error(REMOTE_ABORT); } });
  await btn(doc, "Scan").fire("click");
  assert.equal(find(doc, e => e.getAttribute("class") === "error" && !e.hidden).length, 0);
  assert.equal(btn(doc, "Scan").parent.hidden, false);
});

test("R1 raw remote-method errors are replaced by a friendly message", async () => {
  const { doc } = await boot({ scanSmart: async () => { throw new Error("Error invoking remote method 'nuke:scan:smart': Error: refused"); } });
  await btn(doc, "Scan").fire("click");
  const e = find(doc, e => e.getAttribute("class") === "error" && !e.hidden);
  assert.equal(e.length, 1);
  assert.doesNotMatch(e[0].textContent, /remote method|nuke:/);
});

test("R1 scan resolving after a scanning phase with no further phase leaves the Scanning screen", async () => {
  let go;
  const { doc, nuke, mounts } = await boot({ scanSmart: async () => { await new Promise(r => { go = r; }); } });
  const p = btn(doc, "Scan").fire("click");
  nuke.handlers.phase({ phase: "scanning" });
  assert.equal(mounts.length, 1);
  go(); await p;
  assert.equal(mounts[0].destroyed, true);
  const line = find(doc, e => e.getAttribute("class") === "phase-text")[0];
  assert.equal(line.parent.hidden, false);
});

test("R1 scan resolving with no phase event at all stays home (picker cancelled)", async () => {
  const { doc, mounts } = await boot();
  await btn(doc, "Pick a folder to investigate").fire("click");
  assert.equal(mounts.length, 0);
  assert.equal(btn(doc, "Scan").parent.hidden, false);
});

test("R1 cancelScan failure keeps the Scanning screen and Cancel, shows an error", async () => {
  const { doc, nuke, mounts } = await boot({ cancelScan: async () => { throw new Error("cancel failed"); } });
  nuke.handlers.phase({ phase: "scanning" });
  await btn(doc, "Cancel").fire("click");
  await tick();
  assert.equal(mounts[0].destroyed, false);
  assert.equal(btn(doc, "Cancel").parent.hidden, false);
  assert.equal(find(doc, e => e.getAttribute("class") === "error" && e.textContent === "cancel failed" && !e.hidden).length, 1);
});

test("R1 progress arriving before the scanning phase is applied once the detective mounts", async () => {
  const { nuke, mounts } = await boot();
  nuke.handlers.progress({ fraction: 0.25, label: "early" });
  nuke.handlers.phase({ phase: "scanning" });
  assert.deepEqual(mounts[0].sets[0], [0.25, "early"]);
});

test("R1 getStatus failure shows Mode unknown and hides relaunch", async () => {
  const { doc } = await boot({ getStatus: async () => { throw new Error("x"); } });
  await btn(doc, "Settings").fire("click");
  await tick(); await tick();
  assert.equal(find(doc, e => e.getAttribute("class") === "mode")[0].textContent, "Mode unknown");
  assert.equal(btn(doc, "Relaunch as administrator").parent.hidden, true);
});

test("R1 phase transition clears the home error; bootstrap without window.nuke shows a visible message", async () => {
  const { doc, nuke } = await boot({ scanSmart: async () => { throw new Error("bad scan"); } });
  await btn(doc, "Scan").fire("click");
  nuke.handlers.phase({ phase: "idle" });
  assert.equal(find(doc, e => e.getAttribute("class") === "error" && !e.hidden).length, 0);
  const { bootstrap } = await import("../../app/renderer/main.js");
  const d2 = fakeDoc();
  bootstrap(d2, undefined);
  assert.equal(find(d2, e => e.getAttribute("role") === "alert" && /unavailable/i.test(e.textContent)).length, 1);
});

test("R1 phaseText strips bidi overrides, zero-width and lone surrogates", async () => {
  const { phaseText } = await import("../../app/renderer/phases.js");
  assert.equal(phaseText("done", "a‮b​c\ud800d﻿e"), "a b c d e");
});

// ---- Task 15: R39 honest restore text, results wording, one error channel ----
test("R39 phaseText: restore and results use the main-process detail when given (never a made-up success)", async () => {
  const { phaseText } = await import("../../app/renderer/phases.js");
  assert.equal(phaseText("restore", "No restore point: administrator approval was not given."), "No restore point: administrator approval was not given.");
  assert.equal(phaseText("restore", ""), "Windows is creating a system restore point");
  assert.equal(phaseText("restore", 7), "Windows is creating a system restore point");
  assert.equal(phaseText("results"), "Scan finished.");
  assert.equal(phaseText("results", "Scan finished. Nothing was found."), "Scan finished. Nothing was found.");
});

test("restore phase screen shows the outcome text; error phase from main stays on screen after the call resolves", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { doc, nuke } = await boot({ scanSmart: async () => { nuke.calls.push(["scanSmart"]); await gate; return { ok: false }; } });
  nuke.handlers.phase({ phase: "restore", detail: "Windows did not create a new restore point because one was already created in the last 24 hours." });
  assert.ok(find(doc, e => e.textContent === "Windows did not create a new restore point because one was already created in the last 24 hours.").length >= 1);
  // the controller reports scan errors as a phase and then resolves: that screen must not be replaced by a generic one
  const click = btn(doc, "Scan").fire("click");
  await tick();
  nuke.handlers.phase({ phase: "scanning" });
  nuke.handlers.phase({ phase: "error", detail: "The scan could not be completed. Nothing was changed." });
  release();
  await click;
  await tick();
  const line = find(doc, e => e.getAttribute("class") === "phase-text")[0];
  assert.equal(line.textContent, "The scan could not be completed. Nothing was changed.");
  assert.equal(line.parent.hidden, false);
});

test("restore step: a Stop waiting button (with its description) shows only while waiting and calls cancelScan; live count phases", async () => {
  const { doc, nuke } = await boot();
  const { DESCRIPTIONS } = await import("../../app/renderer/main.js");
  nuke.handlers.phase({ phase: "restore" });
  const b = btn(doc, "Stop waiting");
  assert.ok(find(doc, e => e.textContent === DESCRIPTIONS.stopWaiting).length >= 1, "description beside the button");
  await b.fire("click");
  assert.ok(nuke.calls.some(c => c[0] === "cancelScan"));
  nuke.handlers.phase({ phase: "restore", detail: "No restore point: you stopped waiting for it." });
  assert.equal(b.parent.hidden, true, "hidden once the step has an outcome");
  nuke.handlers.phase({ phase: "checking", detail: "Checking... 150 of 3585" });
  const line = find(doc, e => e.getAttribute("class") === "phase-text")[0];
  assert.equal(line.textContent, "Checking... 150 of 3585");
});

test("M6 a busy rejection shows the friendly sentence, not the generic one", async () => {
  const { doc } = await boot({ scanSmart: async () => { throw new Error("Error invoking remote method 'nuke:scan:smart': Error: Another operation is still running. Please wait."); } });
  await btn(doc, "Scan").fire("click");
  await tick();
  assert.ok(find(doc, e => e.textContent === "Another operation is still running. Please wait." && e.getAttribute("role") === "alert").length === 1);
});

test("R46: relaunch button and the not-offered note follow canRelaunchAdmin; folder button has an honest description", async () => {
  const { FIXED_MESSAGES, FOLDER_HINT } = await import("../../app/renderer/main.js");
  assert.equal(FIXED_MESSAGES.adminNotOffered, "Administrator mode is only offered for a copy installed in C:\\Program Files");
  for (const [status, relaunchHidden, noteHidden] of [
    [{ elevated: false, canRelaunchAdmin: true }, false, true],
    [{ elevated: false, canRelaunchAdmin: false }, true, false],
    [{ elevated: false }, true, false],
    [{ elevated: true, canRelaunchAdmin: false }, true, true],
    [{ elevated: null, canRelaunchAdmin: false }, true, true],
  ]) {
    const { doc } = await boot({ getStatus: async () => status });
    await btn(doc, "Settings").fire("click");
    await tick(); await tick();
    assert.equal(btn(doc, "Relaunch as administrator").parent.hidden, relaunchHidden, JSON.stringify(status));
    const note = find(doc, e => e.textContent === FIXED_MESSAGES.adminNotOffered)[0];
    assert.equal(note.hidden, noteHidden, JSON.stringify(status));
  }
  const { doc } = await boot();
  const hint = find(doc, e => e.textContent === FOLDER_HINT)[0];
  assert.ok(hint);
  assert.match(FOLDER_HINT, /Looks into a folder/);
});

test("R53: every home button has its approved description beside it and linked through aria-describedby", async () => {
  const { DESCRIPTIONS } = await import("../../app/renderer/main.js");
  const { doc } = await boot();
  const want = [
    ["Scan", "Smart Scan. Looks only in a fixed list of safe places (temp files, caches, crash dumps, thumbnails, your Recycle Bin) and lists what could be freed. Nothing is deleted yet."],
    ["Manually find a file to investigate", "Pick a file, shortcut or program. The app follows it to the program it belongs to and lists the leftover files, folders and shortcuts that program made."],
    ["Pick a folder to investigate", "Looks into a folder and checks whether other programs, sub-folders or shortcuts use its contents, so you can see what is safe to remove together."],
    ["Settings", "Choose whether Windows makes a restore point before deleting (on by default)."],
  ];
  for (const [label, text] of want) {
    const b = btn(doc, label);
    const row = b.parent;
    assert.equal(row.getAttribute("class"), "action", label);
    const d = row.children.find(c => c !== b);
    assert.equal(d.textContent, text, label);
    assert.equal(b.getAttribute("aria-describedby"), d.getAttribute("id"), label);
  }
  assert.equal(DESCRIPTIONS.relaunch, "Restart with administrator rights to also clear a few Windows system folders. Only offered from a copy installed in C:\\Program Files.");
});

test("plain-confirm switch: second switch with the approved label, off by default, writes both keys together", async () => {
  for (const stored of [false, true]) {
    const { doc, nuke } = await boot({ getSettings: async () => ({ restorePoint: false, plainConfirm: stored }) });
    await btn(doc, "Settings").fire("click");
    await tick(); await tick();
    const inputs = find(doc, e => e.tagName === "input");
    const sw2 = inputs[1];
    assert.equal(sw2.getAttribute("role"), "switch");
    assert.equal(sw2.checked, stored);
    assert.equal(find(doc, e => e.textContent === "Turn off the nuke-key animation (use a simple confirm screen instead)").length >= 1, true);
    sw2.checked = !stored;
    await sw2.fire("change");
    const sets = nuke.calls.filter(c => c[0] === "setSettings");
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0][1], { restorePoint: false, plainConfirm: !stored });
    assert.equal(sw2.disabled, false);
    assert.equal(sw2.checked, !stored);
  }
});

test("plain-confirm switch defaults to off when settings omit it (old settings file); a failed save puts both switches back", async () => {
  const { doc } = await boot({ getSettings: async () => ({ restorePoint: true }), setSettings: async () => { throw new Error("nope"); } });
  await btn(doc, "Settings").fire("click");
  await tick(); await tick();
  const [sw, sw2] = find(doc, e => e.tagName === "input");
  assert.equal(sw2.checked, false);
  assert.equal(sw.checked, true);
  sw2.checked = true;
  await sw2.fire("change");
  assert.equal(sw2.checked, false);
  assert.equal(sw.checked, true);
  assert.equal(sw2.disabled, false);
  assert.ok(find(doc, e => e.getAttribute("class") === "error" && e.textContent === "nope" && !e.hidden).length === 1);
});

test("Windows tools: home button with the approved description, hidden in administrator mode; list from toolsList, only the key goes to toolsOpen", async () => {
  const rows = [{ key: "services", label: "Services", description: "Lists the background services." }, { key: "keyboard", label: "On-Screen Keyboard", description: "A keyboard you can click." }];
  const { doc, nuke } = await boot({
    toolsList: async () => { return rows; },
    toolsOpen: async k => { nuke.calls.push(["toolsOpen", k]); return { ok: k === "services" }; },
  });
  const home = btn(doc, "Windows tools");
  const d = home.parent.children.find(c => c !== home);
  assert.equal(d.textContent, "One-click shortcuts to handy Windows tools such as System Restore, Task Scheduler and Services. Nothing is changed by this app.");
  assert.equal(home.getAttribute("aria-describedby"), d.getAttribute("id"));
  await home.fire("click");
  await tick(); await tick();
  const svc = btn(doc, "Services"), kb = btn(doc, "On-Screen Keyboard");
  assert.ok(svc && kb);
  assert.equal(svc.parent.children.find(c => c !== svc).textContent, "Lists the background services.");
  await svc.fire("click");
  assert.deepEqual(nuke.calls.filter(c => c[0] === "toolsOpen"), [["toolsOpen", "services"]]);
  assert.ok(find(doc, e => e.getAttribute("class") === "mode" && e.textContent === "Opened Services.").length === 1);
  await kb.fire("click");
  assert.ok(find(doc, e => e.getAttribute("class") === "error" && e.textContent === "That tool could not be opened." && !e.hidden).length === 1);
  assert.equal(find(doc, e => e.tagName === "button" && e.textContent === "Back").filter(b => !b.parent.parent.hidden).length, 1);
});

test("Windows tools: button is hidden in administrator mode", async () => {
  const { doc } = await boot({ getStatus: async () => ({ elevated: true, canRelaunchAdmin: false }) });
  await tick(); await tick();
  assert.equal(btn(doc, "Windows tools").parent.hidden, true);
});

test("restore point step shows a moving progress bar with the seconds so far; it goes away with the outcome and on destroy", async () => {
  const { doc, nuke, app } = await boot();
  const walk = (n, out = []) => { out.push(n); for (const c of n.children || []) walk(c, out); return out; };
  const bar = () => walk(doc.getElementById("app")).find(n => n.attrs && n.attrs.role === "progressbar");
  const time = () => walk(doc.getElementById("app")).find(n => n.attrs && n.attrs.class === "desc restore-time");
  assert.equal(bar().hidden, true, "hidden until the restore step");
  nuke.handlers.phase({ phase: "restore" });
  assert.equal(bar().hidden, false);
  assert.match(time().textContent, /^Working\.\.\. \d+ s/);
  nuke.handlers.phase({ phase: "restore", detail: "A system restore point was created and verified." });
  assert.equal(bar().hidden, true, "the outcome message replaces the bar");
  nuke.handlers.phase({ phase: "restore" });
  assert.equal(bar().hidden, false);
  app.destroy();
  assert.equal(bar().hidden, true, "no timer is left running after destroy");
});
