import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveUi } from "../../app/main/protocol.mjs";

const read = (n) => readFileSync(new URL("../../app/renderer/" + n, import.meta.url), "utf8");
const JS = read("results.js");
const HTML = read("results.html");
const CSS = read("results.css");

test("results.js: textContent/createElement only, no innerHTML/eval/fetch; Delete sends ids only (no paths)", () => {
  const code = JS.replace(/\/\/.*$/gm, "");
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /\bimport\s*\(/, /localStorage/]) {
    assert.doesNotMatch(code, bad);
  }
  assert.match(code, /createElement/);
  assert.match(code, /\.textContent\s*=/);
  assert.match(code, /deleteSelected\(ids\)/);
  assert.doesNotMatch(code, /deleteSelected\([^)]*(path|\.label)/);
  assert.doesNotMatch(code, /\bimport\b.*from/);
});

test("results.html: exact button labels Cancel, Scan Again, Delete them!; permanent notice present; no inline script", () => {
  for (const label of ["Cancel", "Scan Again", "Delete them!"]) assert.match(HTML, new RegExp(">" + label + "</button>"));
  assert.match(HTML, /Deleting is permanent\. A restore point does not bring back your own files\./);
  assert.match(HTML, /Shown only \(not changed by this app\)/);
  assert.doesNotMatch(HTML, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(HTML, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(HTML, /style\s*=/i);
  assert.doesNotMatch(HTML, /<style/i);
  assert.doesNotMatch(HTML, /https?:/i);
  assert.match(HTML, /id="delete"[^>]*disabled/);
  assert.doesNotMatch(CSS, /url\(|@import|https?:/i);
});

test("results.html/js/css resolve through the app:// protocol allowlist", () => {
  for (const f of ["results.html", "results.js", "results.css"]) assert.ok(resolveUi("app://ui/" + f, "C:\\ui"), f);
  for (const m of HTML.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(resolveUi(m[1], "C:\\ui"), m[1]);
});

const rowsFixture = () => [
  { id: "p1", label: "Parent", path: "", size: "10 B", bytes: 10, group: "exclusive", confidence: "high", ticked: true, selectable: true, badge: "", companionOf: "" },
  { id: "c1", label: "Comp", path: "", size: "5 B", bytes: 5, group: "exclusive", confidence: "high", ticked: true, selectable: true, badge: "", companionOf: "p1" },
  { id: "m1", label: "Medium", path: "", size: "100 B", bytes: 100, group: "shared", confidence: "medium", ticked: false, selectable: true, badge: "new", companionOf: "" },
  { id: "x1", label: "Prot", path: "", size: "1 B", bytes: 1, group: "protected", confidence: "", ticked: false, selectable: false, badge: "", companionOf: "" },
  { id: "s1", label: "Svc", path: "", size: "unknown", bytes: null, group: "report-only", confidence: "", ticked: false, selectable: false, badge: "", companionOf: "" },
];
const viewFixture = () => ({ title: "T", rows: rowsFixture(), removed: ["old"], notes: [], totals: { selectedBytes: 15, count: 2 }, adminExtra: "3 MB", permanentNotice: "N" });

test("pure logic: companions follow parent, protected/report-only never deleted, hidden from main table", async () => {
  const m = await import("../../app/renderer/results.js");
  const v = viewFixture();
  assert.deepEqual(m.mainRows(v).map((r) => r.id), ["p1", "m1", "x1"]);
  assert.deepEqual(m.reportRows(v).map((r) => r.id), ["s1"]);
  let t = m.initialTicked(v);
  assert.deepEqual(m.idsToDelete(v, t).sort(), ["c1", "p1"]);
  assert.deepEqual(m.summarize(v, t), { count: 2, bytes: 15, tooMany: false, text: "2 selected, 15 B to free" });
  t = m.toggle(v, t, "p1", false);
  assert.deepEqual(m.idsToDelete(v, t), []);
  assert.equal(m.summarize(v, t).text, "Nothing ticked.");
  t = m.toggle(v, t, "x1", true);        // protected: ignored
  t = m.toggle(v, t, "s1", true);        // report-only: ignored
  t = m.toggle(v, t, "c1", true);        // companion cannot be ticked alone
  t = m.toggle(v, t, "nope", true);
  assert.deepEqual(m.idsToDelete(v, t), []);
  t = m.toggle(v, t, "m1", true);
  assert.deepEqual(m.idsToDelete(v, t), ["m1"]);
  assert.equal(m.diffLine(v), "1 new, 1 gone, 0 resized");
  // a forged ticked flag on a non-selectable row does not survive
  const forged = viewFixture(); forged.rows[3].ticked = true;
  assert.equal(m.initialTicked(forged).has("x1"), false);
  assert.equal(m.fmtBytes(null), "unknown");
});

// ---- minimal fake DOM ----
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
function fakeDoc() {
  const ids = {};
  for (const id of ["title", "notice", "notes", "diff", "rows", "report", "report-list", "admin", "summary", "cancel", "again", "delete", "sort-name", "sort-size", "sort-group", "sort-sure", "sort-change", "th-name", "th-size", "th-group", "th-sure", "th-change"]) ids[id] = new Node_(id);
  ids.delete.disabled = true;
  return { ids, createElement: (t) => new Node_(t), getElementById: (id) => ids[id] };
}

test("mount: renders hostile text as text, report section, admin line, buttons call API with ids only", async () => {
  const { mount } = await import("../../app/renderer/results.js");
  const doc = fakeDoc();
  const calls = [];
  const again = viewFixture();
  again.rows[0].label = "<img src=x onerror=alert(1)>";
  again.rows[2].badge = "resized";
  const api = {
    getResults: async () => viewFixture(), getStatus: async () => ({ elevated: false, canRelaunchAdmin: true }),
    deleteSelected: async (ids) => { calls.push(["delete", ids]); },
    scanAgain: async () => again,
    closeResults: () => { calls.push(["close"]); },
    
  };
  mount(doc, api);
  await new Promise((r) => setImmediate(r));
  const { ids } = doc;
  assert.equal(ids.rows.children.length, 3);                      // companion hidden
  assert.equal(ids.rows.children[2].all((n) => n.tag === "input")[0].disabled, true); // protected
  assert.equal(ids.rows.children[1].all((n) => n.tag === "input")[0].checked, true); // Parent is second: the table starts biggest-first (Medium 100 B, Parent 10 B, Prot 1 B)
  assert.equal(ids.report.hidden, false);
  assert.match(ids["report-list"].textContent, /Svc/);
  assert.equal(ids.admin.textContent, "Could free 3 MB more in administrator mode");
  assert.equal(ids.admin.hidden, false);
  assert.equal(ids.summary.textContent, "2 selected, 15 B to free");
  assert.equal(ids.delete.disabled, false);

  await ids.delete.fire("click");
  assert.deepEqual(calls.pop(), ["delete", ["p1", "c1"]]);
  await ids.cancel.fire("click");
  assert.deepEqual(calls.pop(), ["close"]);

  // untick parent -> delete disabled
  const box = ids.rows.children[1].all((n) => n.tag === "input")[0]; // Parent: second row, the table is biggest-first
  box.checked = false; await box.fire("change");
  assert.equal(ids.delete.disabled, true);
  assert.equal(ids.summary.textContent, "Nothing ticked.");

  await ids.again.fire("click");
  assert.equal(ids.diff.textContent, "0 new, 1 gone, 1 resized (gone: old)");
  const hostile = ids.rows.children.find((tr) => /<img src=x onerror=alert\(1\)>/.test(tr.textContent)); // inert text, wherever the sort puts it
  assert.ok(hostile);
  assert.equal(hostile.all((n) => n.tag === "img").length, 0);

});


test("sortRows: size biggest-first by default, unknown sizes last, name/sure/change/group sort, ties by name, input untouched", async () => {
  const { sortRows } = await import("../../app/renderer/results.js");
  const rows = [
    { id: "a", label: "beta", bytes: 10, group: "exclusive", confidence: "high", badge: "" },
    { id: "b", label: "alpha", bytes: 10, group: "shared", confidence: "low", badge: "new" },
    { id: "c", label: "gamma", bytes: 999, group: "exclusive", confidence: "medium", badge: "resized" },
    { id: "d", label: "delta", bytes: null, group: "protected", confidence: "", badge: "" },
    { id: "e", label: "file10", bytes: 1, group: "exclusive", confidence: "high", badge: "" },
    { id: "f", label: "file9", bytes: 1, group: "exclusive", confidence: "high", badge: "" },
  ];
  const ids = (k, d) => sortRows(rows, k, d).map((r) => r.id).join("");
  assert.equal(ids("size", "desc"), "cbafed", "biggest first; equal sizes by name; unknown last");
  assert.equal(ids("size", "asc"), "febacd", "smallest first; unknown still last");
  assert.equal(ids("name", "asc"), "badfec", "natural name order (file9 before file10)");
  assert.equal(ids("name", "desc"), "cefdab");
  assert.equal(ids("sure", "desc"), "afecbd", "high, medium, low, none; ties by name");
  assert.equal(ids("change", "desc"), "bcadfe", "new, size changed, unchanged");
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c", "d", "e", "f"], "the input array is not reordered");
  assert.deepEqual(sortRows([], "size", "desc"), []);
});

test("mount: the table starts biggest-first; clicking a heading sorts by it and a second click reverses it; arrows and aria-sort follow", async () => {
  const doc = fakeDoc();
  const api = { getResults: async () => viewFixture(), closeResults() {}, scanAgain: async () => viewFixture(), deleteSelected: async () => ({}), getStatus: async () => ({}) };
  const { mount } = await import("../../app/renderer/results.js");
  mount(doc, api);
  await new Promise((r) => setImmediate(r));
  const order = () => doc.ids.rows.children.map((tr) => tr.all((n) => n.attrs && n.attrs["aria-label"]).map((n) => n.attrs["aria-label"].replace("Delete ", ""))[0]).join(",");
  assert.equal(order(), "Medium,Parent,Prot");
  assert.equal(doc.ids["sort-size"].textContent, "Size \u25BC");
  assert.equal(doc.ids["th-size"].attrs["aria-sort"], "descending");
  assert.equal(doc.ids["th-name"].attrs["aria-sort"], "none");
  await doc.ids["sort-name"].fire("click");
  assert.equal(order(), "Medium,Parent,Prot", "A to Z");
  assert.equal(doc.ids["sort-name"].textContent, "Name \u25B2");
  await doc.ids["sort-name"].fire("click");
  assert.equal(order(), "Prot,Parent,Medium", "Z to A");
  assert.equal(doc.ids["th-name"].attrs["aria-sort"], "descending");
  await doc.ids["sort-size"].fire("click");
  assert.equal(order(), "Medium,Parent,Prot", "size starts biggest-first again");
  await doc.ids["sort-size"].fire("click");
  assert.equal(order(), "Prot,Parent,Medium", "second click: smallest first");
});
