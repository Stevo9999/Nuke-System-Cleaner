import { test } from "node:test";
import assert from "node:assert/strict";
import { displayText, fmtBytes, diffScans, toView } from "../../app/main/view-model.mjs";
import { makeFinding } from "../../lib/confidence.mjs";

const OK = { ok: true };
function resultWith(labels, extra = {}) {
  const items = labels.map((label, i) => makeFinding({
    kind: "dir", path: "C:\\Users\\u\\AppData\\Local\\Temp\\d" + i, label, bytes: 100 * (i + 1),
    safe: OK, basis: "vetted", oldEnough: true, locked: false, category: "temp",
  }));
  return { kind: "smart", target: null, items, allowedRoots: ["C:\\x"], protectedPaths: [], notes: [], adminExtraBytes: null, partial: false, ...extra };
}

test("hostile names render as one capped line", () => {
  const v = toView(resultWith(["evil\u202Etxt.exe", "a\nb", "z\u200Bw", "x".repeat(10000), "nul\0here", "ls\u2028ps\u2029"]));
  assert.equal(v.rows.length, 6);
  for (const r of v.rows) {
    assert.doesNotMatch(r.label, /[\u202E\n\u200B\0\u2028\u2029]/u);
    assert.ok(r.label.length <= 203);
    assert.doesNotMatch(r.path, /[\p{Cc}\p{Cf}]/u);
  }
  assert.equal(v.rows[1].label, "a b");
});

test("displayText: collapse, cap with ellipsis, non-strings, hostile objects", () => {
  assert.equal(displayText("a   \t\n b"), "a b");
  assert.equal(displayText("x".repeat(300)), "x".repeat(200) + "...");
  assert.equal(displayText("abcdef", 3), "abc...");
  assert.equal(displayText(null), "");
  assert.equal(displayText(undefined), "");
  assert.equal(displayText(42), "42");
  assert.equal(displayText({ toString() { throw new Error("boom"); } }), "");
  assert.equal(displayText("\u202E\u202D"), "");
});

test("only high rows are ticked; protected/report-only rows are not selectable", () => {
  const mk = (o) => makeFinding({ kind: "dir", path: "C:\\p\\" + o.n, label: o.n, bytes: 10, category: "c", ...o });
  const items = [
    mk({ n: "hi", safe: OK, basis: "vetted", oldEnough: true, locked: false }),
    mk({ n: "med", safe: OK, basis: "name" }),
    mk({ n: "low", safe: OK, basis: "fuzzy" }),
    mk({ n: "prot", safe: { ok: false, reason: "no" }, basis: "vetted" }),
    makeFinding({ kind: "service", label: "svc", idKey: "svc", bytes: null }),
  ];
  const v = toView({ kind: "smart", target: null, items, allowedRoots: [], protectedPaths: [], notes: [], adminExtraBytes: null, partial: false });
  const by = Object.fromEntries(v.rows.map((r) => [r.label, r]));
  assert.equal(by.hi.ticked, true); assert.equal(by.hi.selectable, true); assert.equal(by.hi.confidence, "high");
  for (const n of ["med", "low"]) { assert.equal(by[n].ticked, false); assert.equal(by[n].selectable, true); }
  for (const n of ["prot", "svc"]) { assert.equal(by[n].ticked, false); assert.equal(by[n].selectable, false); }
  assert.equal(by.svc.group, "report-only");
  assert.equal(by.svc.size, "unknown");
  assert.deepEqual(v.totals, { selectedBytes: 10, count: 1 });
  assert.equal(v.permanentNotice, "Deleting is permanent. A restore point does not bring back your own files.");
});

test("a hostile finding cannot become selectable or ticked through the view", () => {
  const v = toView({ items: [{ id: "0123456789abcdef", label: "x", path: null, bytes: 5, group: "protected", confidence: null, preTicked: true, selectable: false }] });
  assert.equal(v.rows[0].ticked, false);
  assert.equal(v.totals.count, 0);
});

test("diffScans: added, removed, resized by id; same scan -> empty diff", () => {
  const a = resultWith(["one", "two", "three"]);
  const same = diffScans(a, a);
  assert.deepEqual(same, { added: [], removed: [], resized: [] });
  const b = { ...a, items: [a.items[0], { ...a.items[1], bytes: 999 }, makeFinding({ kind: "dir", path: "C:\\new", label: "fresh\u202E", bytes: 1, safe: OK, basis: "name" })] };
  const d = diffScans(a, b);
  assert.equal(d.added.length, 1);
  assert.deepEqual(d.removed, [{ id: a.items[2].id, label: "three" }]);
  assert.deepEqual(d.resized, [{ id: a.items[1].id, before: 200, after: 999 }]);
  const v = toView(b, d);
  const badge = Object.fromEntries(v.rows.map((r) => [r.id, r.badge]));
  assert.equal(badge[d.added[0]], "new");
  assert.equal(badge[a.items[1].id], "resized");
  assert.equal(badge[a.items[0].id], "");
  assert.deepEqual(v.removed, ["three"]);
  assert.deepEqual(diffScans(null, undefined), { added: [], removed: [], resized: [] });
});

test("fmtBytes edge cases: null, NaN, -1, 1e308", () => {
  for (const bad of [null, undefined, NaN, -1, Infinity, "5", {}]) assert.equal(fmtBytes(bad), "unknown");
  assert.equal(fmtBytes(0), "0 B");
  assert.equal(fmtBytes(1023), "1023 B");
  assert.equal(fmtBytes(1024), "1 KB");
  assert.equal(fmtBytes(1536), "1.5 KB");
  assert.equal(fmtBytes(5 * 1024 ** 3), "5 GB");
  const big = fmtBytes(1e308);
  assert.equal(big, "over 1000 YB");
});

test("toView: companions carry parent id, adminExtra text, partial note, notes sanitised", () => {
  const parent = makeFinding({ kind: "dir", path: "C:\\a", label: "a", bytes: 1, safe: OK, basis: "vetted", oldEnough: true, locked: false });
  const comp = makeFinding({ kind: "file", path: "C:\\a.ini", label: "a.ini", bytes: 1, safe: OK, basis: "vetted", oldEnough: true, locked: false, companionOf: parent.id });
  const v = toView({ kind: "investigate", target: "C:\\t\u202Ex", items: [parent, comp], notes: ["n\u0000ote"], adminExtraBytes: 2048, partial: true });
  assert.equal(v.rows[1].companionOf, parent.id);
  assert.equal(v.adminExtra, "2 KB");
  assert.match(v.notes[0], /Partial/);
  assert.equal(v.notes[1], "n ote");
  assert.doesNotMatch(v.title, /\u202E/);
  assert.equal(toView({ items: [], adminExtraBytes: 0 }).adminExtra, null);
});
