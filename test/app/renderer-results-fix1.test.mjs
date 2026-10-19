import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "../../app/renderer/results.js";

class N {
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
  for (const id of ["title", "notice", "notes", "diff", "rows", "report", "report-list", "admin", "summary", "cancel", "again", "delete", "error"]) ids[id] = new N(id);
  return { ids, createElement: (t) => new N(t), getElementById: (id) => ids[id] };
}
const row = (id, o = {}) => ({ id, label: id, path: "", size: "1 B", bytes: 1, group: "exclusive", confidence: "high", ticked: true, selectable: true, badge: "", companionOf: "", ...o });
const view = (rows, o = {}) => ({ title: "T", rows, removed: [], notes: [], totals: { selectedBytes: 0, count: 0 }, adminExtra: null, permanentNotice: "N", ...o });
const box = (doc, i) => doc.ids.rows.children[i].all((n) => n.tag === "input")[0];
const tick = () => new Promise((r) => setImmediate(r));

function setup(first, extra = {}) {
  const doc = fakeDoc(); const calls = []; let next = first;
  const api = { getResults: async () => first, deleteSelected: async (ids) => { calls.push(ids); }, scanAgain: async () => next, closeResults() {}, ...extra };
  mount(doc, api);
  return { doc, calls, push: async (v) => { next = v; await doc.ids.again.fire("click"); } };
}

test("change fired on a disabled protected box ticks nothing and deletes nothing", async () => {
  const { doc, calls } = setup(view([row("a", { ticked: false }), row("prot", { group: "protected", confidence: "", ticked: false, selectable: false })]));
  await tick();
  const b = box(doc, 1);
  assert.equal(b.disabled, true);
  b.checked = true; await b.fire("change");
  assert.equal(b.checked, false);
  assert.equal(doc.ids.delete.disabled, true);
  await doc.ids.delete.fire("click");
  assert.deepEqual(calls, []);
});

test("manual ticks survive a push for ids that still exist; new items get their default", async () => {
  const { doc, push } = setup(view([row("a"), row("b", { ticked: false, confidence: "medium" })]));
  await tick();
  const a = box(doc, 0); a.checked = false; await a.fire("change");
  const b = box(doc, 1); b.checked = true; await b.fire("change");
  await push(view([row("a"), row("b", { ticked: false, confidence: "medium" }), row("c")]));
  assert.equal(box(doc, 0).checked, false);
  assert.equal(box(doc, 1).checked, true);
  assert.equal(box(doc, 2).checked, true);
});

test("a scan again with no changes shows a zero diff line; with badges it counts them", async () => {
  const { doc, push } = setup(view([row("a")]));
  await tick();
  await push(view([row("a")]));
  assert.equal(doc.ids.diff.textContent, "0 new, 0 gone, 0 resized");
  await push(view([row("a", { badge: "new" })]));
  assert.equal(doc.ids.diff.textContent, "1 new, 0 gone, 0 resized");
});

test("rejected deleteSelected / scanAgain show a plain error and re-enable the buttons", async () => {
  const { doc } = setup(view([row("a")]), { deleteSelected: async () => { throw new Error("C:\\secret\\path boom"); }, scanAgain: async () => { throw new Error("x"); } });
  await tick();
  await doc.ids.delete.fire("click");
  assert.match(doc.ids.error.textContent, /did not complete/i);
  assert.doesNotMatch(doc.ids.error.textContent, /secret|boom/);
  assert.equal(doc.ids.error.hidden, false);
  assert.equal(doc.ids.delete.disabled, false);
  await doc.ids.again.fire("click");
  assert.match(doc.ids.error.textContent, /scan/i);
  assert.equal(doc.ids.again.disabled, false);
});

test("round 2: only hand-made ticks carry over; defaults follow the new scan", async () => {
  const med = { ticked: false, confidence: "medium" };
  const { doc, push } = setup(view([row("a"), row("m", med), row("p", med), row("u")]));
  await tick();
  const m = box(doc, 1); m.checked = true; await m.fire("change");
  const p = box(doc, 2); p.checked = true; await p.fire("change");
  const u = box(doc, 3); u.checked = false; await u.fire("change");
  await push(view([
    row("a", med),                                                // downgraded, untouched
    row("m", med),
    row("p", { group: "protected", confidence: "", ticked: false, selectable: false }),
    row("u"),
  ]));
  assert.equal(box(doc, 0).checked, false, "untouched downgraded row unticked");
  assert.equal(box(doc, 1).checked, true, "manual tick survives");
  assert.equal(box(doc, 2).checked, false, "now-protected row cleared");
  assert.equal(box(doc, 3).checked, false, "manual untick survives");
  await push(view([row("a", med), row("m", med), row("p", med), row("u")]));
  assert.equal(box(doc, 2).checked, false, "stale manual tick does not come back");
});
