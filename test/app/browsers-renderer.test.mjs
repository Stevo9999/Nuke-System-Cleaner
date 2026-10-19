// Renderer side of round 2: the Browsers cleaner button, the Exclusions list in Settings, and the browsers results view. Fake DOM, fake nuke API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------- main window (settings + home) ----------
class El {
  constructor(doc, tag) { this.ownerDocument = doc; this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this._text = ""; this.hidden = false; this.checked = false; this.disabled = false; this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  get firstChild() { return this.children[0] ?? null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  async fire(t) { for (const f of this.listeners[t] || []) await f({ target: this }); }
  walk(out = []) { out.push(this); for (const c of this.children) c.walk(out); return out; }
}
function fakeDoc() {
  const doc = {};
  doc.createElement = (t) => new El(doc, t);
  const app = new El(doc, "main");
  doc.getElementById = (id) => (id === "app" ? app : null);
  doc.app = app;
  return doc;
}
function fakeNuke(over = {}) {
  const calls = [], handlers = {};
  return {
    calls, handlers,
    getSettings: async () => ({ restorePoint: true, plainConfirm: false, exclusions: [] }),
    setSettings: async (s) => s,
    getStatus: async () => ({ elevated: false }),
    scanSmart: async () => { calls.push(["scanSmart"]); },
    scanBrowsers: async (...a) => { calls.push(["scanBrowsers", a]); },
    scanInvestigate: async () => {}, scanFolder: async () => {}, scanStartup: async () => {}, cancelScan: async () => {}, relaunchAdmin: async () => {},
    onPhase: (cb) => { handlers.phase = cb; return () => {}; },
    onProgress: (cb) => { handlers.progress = cb; return () => {}; },
    ...over,
  };
}
const find = (doc, pred) => doc.app.walk().filter(pred);
const btn = (doc, label) => find(doc, (e) => e.tagName === "button" && e.textContent === label)[0];
const tick = () => new Promise((r) => setImmediate(r));
async function boot(over) {
  const { createApp, DESCRIPTIONS } = await import("../../app/renderer/main.js");
  const doc = fakeDoc(), nuke = fakeNuke(over);
  const app = createApp(doc, nuke, (host, o) => ({ host, o, set() {}, destroy() {} }));
  return { doc, nuke, app, DESCRIPTIONS };
}
const exclRows = (doc) => find(doc, (e) => e.getAttribute("class") === "excl-row");
const alerts = (doc) => find(doc, (e) => e.getAttribute("role") === "alert" && !e.hidden).map((e) => e.textContent);
const descOf = (b) => b.parent.children.find((c) => c !== b && c.getAttribute("class") === "desc");

test("home: 'Browsers cleaner' has a plain description beside it, calls scanBrowsers with no arguments, and is hidden in administrator mode", async () => {
  const { doc, nuke, DESCRIPTIONS } = await boot();
  const b = btn(doc, "Browsers cleaner");
  assert.ok(b);
  assert.equal(descOf(b).textContent, DESCRIPTIONS.browsers);
  assert.match(DESCRIPTIONS.browsers, /never ticked/);
  assert.equal(b.getAttribute("aria-describedby"), descOf(b).getAttribute("id"));
  await b.fire("click");
  assert.deepEqual(nuke.calls.filter((c) => c[0] === "scanBrowsers"), [["scanBrowsers", []]]);
  const adm = await boot({ getStatus: async () => ({ elevated: true }) });
  await tick(); await tick();
  assert.equal(btn(adm.doc, "Browsers cleaner").parent.hidden, true);
  const std = await boot({ getStatus: async () => ({ elevated: false }) });
  await tick(); await tick();
  assert.equal(btn(std.doc, "Browsers cleaner").parent.hidden, false);
});

test("settings: the exclusions list renders from main's rows (as text), Remove sends only the id, Add folder sends nothing", async () => {
  let rows = [{ id: "0123456789abcdef", path: "C:\\Keep\\One" }, { id: "fedcba9876543210", path: "<img src=x onerror=alert(1)>" }];
  const sent = [];
  const { doc, DESCRIPTIONS } = await boot({
    getSettings: async () => ({ restorePoint: true, plainConfirm: false, exclusions: rows }),
    exclusionsRemove: async (...a) => { sent.push(["remove", a]); rows = rows.filter((r) => r.id !== a[0]); return { ok: true, rows }; },
    exclusionsAdd: async (...a) => { sent.push(["add", a]); rows = [...rows, { id: "1111111111111111", path: "D:\\New" }]; return { ok: true, rows }; },
  });
  await btn(doc, "Settings").fire("click"); await tick(); await tick();
  assert.ok(find(doc, (e) => e.tagName === "h3" && e.textContent === "Folders this app must never touch").length === 1);
  assert.equal(exclRows(doc).length, 2);
  assert.match(exclRows(doc)[0].textContent, /C:\\Keep\\One/);
  assert.match(exclRows(doc)[1].textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(find(doc, (e) => e.tagName === "img").length, 0, "hostile text stays text");
  assert.equal(find(doc, (e) => e.getAttribute("class") === "excl-status")[0].textContent, "2 folders are protected.");
  // every button here has a short description beside it
  const removes = exclRows(doc).flatMap((r) => r.walk().filter((e) => e.tagName === "button" && e.textContent === "Remove")); // (the Windows apps screen has its own Remove)
  assert.equal(removes.length, 2);
  for (const b of [...removes, btn(doc, "Add folder...")]) assert.ok(descOf(b) && descOf(b).textContent.length > 10, b.textContent);
  assert.equal(descOf(btn(doc, "Add folder...")).textContent, DESCRIPTIONS.exclusionsAdd);
  assert.equal(descOf(removes[0]).textContent, DESCRIPTIONS.exclusionsRemove);
  await removes[1].fire("click"); await tick();
  assert.deepEqual(sent.pop(), ["remove", ["fedcba9876543210"]], "only the id");
  assert.equal(exclRows(doc).length, 1);
  await btn(doc, "Add folder...").fire("click"); await tick();
  assert.deepEqual(sent.pop(), ["add", []], "no path from the window");
  assert.equal(exclRows(doc).length, 2);
  assert.match(exclRows(doc)[1].textContent, /D:\\New/);
});

test("settings: add/remove problems are explained in plain words; nothing leaks from engine errors; empty list says so", async () => {
  const outcomes = [{ ok: false, reason: "duplicate", rows: [] }, { ok: false, reason: "invalid", rows: [] }, { ok: false, reason: "full", rows: [] },
    { ok: false, reason: "failed", rows: [] }, { ok: false, reason: "cancelled", cancelled: true, rows: [] }, { ok: false, reason: "C:\\secret", rows: [] }];
  let n = 0;
  const { doc } = await boot({ exclusionsAdd: async () => outcomes[n++] });
  await btn(doc, "Settings").fire("click"); await tick(); await tick();
  assert.equal(find(doc, (e) => e.getAttribute("class") === "excl-status")[0].textContent, "No folders on the list yet.");
  const expect = [/already on the list/, /cannot be added/, /list is full/, /could not be saved/, null, null];
  for (const re of expect) {
    await btn(doc, "Add folder...").fire("click"); await tick();
    if (re) assert.match(alerts(doc).join("|"), re);
    else assert.deepEqual(alerts(doc), [], "cancel and unknown reasons say nothing");
  }
  const boom = await boot({ exclusionsAdd: async () => { throw new Error("Error invoking remote method 'nuke:exclusions:add': Error: C:\\secret"); } });
  await btn(boom.doc, "Settings").fire("click"); await tick(); await tick();
  await btn(boom.doc, "Add folder...").fire("click"); await tick();
  assert.deepEqual(alerts(boom.doc), ["Something went wrong. Please try again."]);
  const busy = await boot({ exclusionsAdd: async () => { throw new Error("Another operation is still running. Please wait."); } });
  await btn(busy.doc, "Settings").fire("click"); await tick(); await tick();
  await btn(busy.doc, "Add folder...").fire("click"); await tick();
  assert.deepEqual(alerts(busy.doc), ["Another operation is still running. Please wait."]);
});

test("settings: an old settings reply without a list still renders, and a failed load shows the list as unknown", async () => {
  const old = await boot({ getSettings: async () => ({ restorePoint: true }) });
  await btn(old.doc, "Settings").fire("click"); await tick(); await tick();
  assert.equal(find(old.doc, (e) => e.getAttribute("class") === "excl-status")[0].textContent, "No folders on the list yet.");
  const bad = await boot({ getSettings: async () => { throw new Error("x"); } });
  await btn(bad.doc, "Settings").fire("click"); await tick(); await tick();
  assert.equal(find(bad.doc, (e) => e.getAttribute("class") === "excl-status")[0].textContent, "Unknown");
  // the two switches still work and never carry the list
  const sent = [];
  const sw = await boot({ getSettings: async () => ({ restorePoint: true, plainConfirm: false, exclusions: [{ id: "0123456789abcdef", path: "C:\\Keep" }] }), setSettings: async (s) => { sent.push(s); return s; } });
  await btn(sw.doc, "Settings").fire("click"); await tick(); await tick();
  const box = find(sw.doc, (e) => e.tagName === "input" && e.getAttribute("role") === "switch")[0];
  box.checked = false; await box.fire("change"); await tick();
  assert.deepEqual(sent, [{ restorePoint: false, plainConfirm: false }]);
});

test("main.js and index.html stay clean: no innerHTML, no inline handlers, no path strings sent to the bridge", () => {
  const JS = readFileSync(new URL("../../app/renderer/main.js", import.meta.url), "utf8");
  assert.match(JS, /nuke\.scanBrowsers\(\)/);
  assert.match(JS, /nuke\.exclusionsAdd\(\)/);
  assert.match(JS, /nuke\.exclusionsRemove\(r\.id\)/);
  assert.doesNotMatch(JS, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|\.style\b/);
});

// ---------- results window ----------
class Node_ {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this._text = ""; this.hidden = false; this.disabled = false; this.checked = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
  get firstChild() { return this.children[0] ?? null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  async fire(t) { for (const f of this.listeners[t] || []) await f({}); }
  all(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) c.all(pred, out); return out; }
}
function resultsDoc(withHelp = true) {
  const ids = {};
  for (const id of ["title", "notice", "notes", "diff", "rows", "report", "report-list", "admin", "summary", "cancel", "again", "delete", ...(withHelp ? ["help"] : [])]) ids[id] = new Node_(id);
  ids.delete.disabled = true;
  return { ids, createElement: (t) => new Node_(t), getElementById: (id) => ids[id] };
}
const browsersView = () => ({
  title: "Browser leftovers", scanKind: "browsers", help: "Browser cache is safe to remove: pages load a little slower once.",
  rows: [
    { id: "a1", label: "Chrome cache", reason: "r", path: "C:\\x\\Cache", size: "10 B", bytes: 10, kind: "dir", group: "exclusive", category: "Browser cache", confidence: "high", ticked: true, selectable: true, badge: "", companionOf: "" },
    { id: "b2", label: "Chrome browsing history", reason: "r", path: "C:\\x\\History", size: "5 B", bytes: 5, kind: "file", group: "exclusive", category: "Browsing history", confidence: "medium", ticked: false, selectable: true, badge: "", companionOf: "" },
  ],
  removed: [], notes: ["Close your browsers for a complete clean"], totals: { selectedBytes: 10, count: 1 }, adminExtra: null, permanentNotice: "N",
});

test("results: the browsers view shows the help line, plain group names, keeps Delete, ticks only the cache, and sends ids only", async () => {
  const { mount } = await import("../../app/renderer/results.js");
  const doc = resultsDoc();
  const calls = [];
  mount(doc, { getResults: async () => browsersView(), getStatus: async () => ({ elevated: false }), deleteSelected: async (ids) => { calls.push(ids); }, scanAgain: async () => browsersView(), closeResults: () => {} });
  await tick();
  const { ids } = doc;
  assert.equal(ids.title.textContent, "Browser leftovers");
  assert.equal(ids.help.textContent, "Browser cache is safe to remove: pages load a little slower once.");
  assert.equal(ids.help.hidden, false);
  assert.match(ids.notes.textContent, /Close your browsers for a complete clean/);
  const badges = ids.rows.all((n) => n.tag === "span" && n.attrs.class === "badge group").map((n) => n.textContent);
  assert.deepEqual(badges, ["Browser cache", "Browsing history"]);
  const boxes = ids.rows.all((n) => n.tag === "input");
  assert.deepEqual(boxes.map((b) => b.checked), [true, false]);
  assert.equal(ids.summary.textContent, "1 selected, 10 B to free");
  assert.equal(ids.delete.disabled, false, "Delete is available for this kind");
  assert.equal(ids.delete.hidden, false);
  await ids.delete.fire("click");
  assert.deepEqual(calls, [["a1"]]);
  // tick the history row by hand: still ids only
  boxes[1].checked = true; await boxes[1].fire("change");
  assert.equal(ids.summary.textContent, "2 selected, 15 B to free");
  await ids.delete.fire("click");
  assert.deepEqual(calls.pop().sort(), ["a1", "b2"]);
  // other kinds: no help line and the old group wording
  const doc2 = resultsDoc();
  const smart = browsersView(); smart.scanKind = "smart"; smart.help = ""; smart.title = "Smart Scan results";
  mount(doc2, { getResults: async () => smart, getStatus: async () => ({ elevated: false }), deleteSelected: async () => {}, scanAgain: async () => smart, closeResults: () => {} });
  await tick();
  assert.equal(doc2.ids.help.hidden, true);
  assert.deepEqual(doc2.ids.rows.all((n) => n.tag === "span" && n.attrs.class === "badge group").map((n) => n.textContent), ["Only used by this", "Only used by this"]);
  // an older results page without a help element still renders
  const doc3 = resultsDoc(false);
  mount(doc3, { getResults: async () => browsersView(), getStatus: async () => ({ elevated: false }), deleteSelected: async () => {}, scanAgain: async () => browsersView(), closeResults: () => {} });
  await tick();
  assert.equal(doc3.ids.rows.children.length, 2);
});

test("results.html has the help line, hidden by default, with no inline script or style", () => {
  const HTML = readFileSync(new URL("../../app/renderer/results.html", import.meta.url), "utf8");
  assert.match(HTML, /<p id="help" class="desc" hidden><\/p>/);
  assert.doesNotMatch(HTML, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(HTML, /style\s*=|<style/i);
});
