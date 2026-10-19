import { test } from "node:test";
import assert from "node:assert/strict";

// Task 17: unknown administrator status must not leave a silent dead end in the results window.
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
  ids.delete.disabled = true;
  ids.error.hidden = true;
  return { ids, createElement: () => new N(), getElementById: (id) => ids[id] };
}
const view = () => ({
  title: "T", removed: [], notes: [], permanentNotice: "N",
  rows: [{ id: "p1", label: "Parent", path: "", size: "10 B", bytes: 10, group: "exclusive", confidence: "high", ticked: true, selectable: true, badge: "", companionOf: "" }],
});
const settle = () => new Promise((r) => setTimeout(r, 15));

test("unknown administrator status (null, or the status call failing) turns Delete off and shows the fixed identity text", async () => {
  const { mount } = await import("../../app/renderer/results.js");
  const { IDENTITY_UNKNOWN_MESSAGE } = await import("../../app/main/controller.mjs");
  for (const getStatus of [async () => ({ elevated: null }), async () => ({}), async () => null, async () => { throw new Error("x"); }]) {
    const doc = fakeDoc();
    const calls = [];
    mount(doc, { getResults: async () => view(), getStatus, deleteSelected: async (ids) => { calls.push(ids); }, scanAgain: async () => view(), closeResults() {} });
    await settle();
    assert.equal(doc.ids.delete.disabled, true, "Delete stays off");
    assert.equal(doc.ids.error.textContent, IDENTITY_UNKNOWN_MESSAGE);
    assert.equal(doc.ids.error.hidden, false);
    await doc.ids.delete.fire("click");
    assert.deepEqual(calls, [], "no delete call goes out");
  }
});

test("known status (true or false) leaves Delete usable and shows no error", async () => {
  const { mount } = await import("../../app/renderer/results.js");
  for (const getStatus of [async () => ({ elevated: false }), async () => ({ elevated: true })]) {
    const doc = fakeDoc();
    const calls = [];
    mount(doc, { getResults: async () => view(), getStatus, deleteSelected: async (ids) => { calls.push(ids); }, scanAgain: async () => view(), closeResults() {} });
    await settle();
    assert.equal(doc.ids.delete.disabled, false);
    assert.equal(doc.ids.error.hidden, true);
    await doc.ids.delete.fire("click");
    assert.deepEqual(calls, [["p1"]]);
  }
});

test("results.js keeps the same wording as the controller constant", async () => {
  const fs = await import("node:fs");
  const { IDENTITY_UNKNOWN_MESSAGE } = await import("../../app/main/controller.mjs");
  const src = fs.readFileSync(new URL("../../app/renderer/results.js", import.meta.url), "utf8");
  assert.ok(src.includes(JSON.stringify(IDENTITY_UNKNOWN_MESSAGE)));
});
