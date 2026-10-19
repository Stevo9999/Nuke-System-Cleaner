import { test } from "node:test";
import assert from "node:assert/strict";
import { displayText, fmtBytes, diffScans, toView } from "../../app/main/view-model.mjs";
import { fmtBytes as rendererFmt } from "../../app/renderer/results.js";
import { makeFinding } from "../../lib/confidence.mjs";

const OK = { ok: true };

test("fmtBytes boundaries: unit promotion, over-limit only on last unit, both copies agree", () => {
  const want = [
    [999, "999 B"], [1000, "1000 B"], [1023, "1023 B"], [1023.5, "1 KB"], [1024, "1 KB"],
    [1024000, "1000 KB"], [1023 * 1024, "1023 KB"], [1048575, "1 MB"], [1048576, "1 MB"],
    [1000 * 1024 * 1024, "1000 MB"], [1023.95 * 1024, "1 MB"], [1536, "1.5 KB"],
    [1e308, "over 1000 YB"],
  ];
  for (const [n, s] of want) { assert.equal(fmtBytes(n), s, "main " + n); assert.equal(rendererFmt(n), s, "renderer " + n); }
  for (const bad of [NaN, -1, -0.5, Infinity, 10n, "9", null, undefined]) {
    assert.equal(fmtBytes(bad), "unknown"); assert.equal(rendererFmt(bad), "unknown");
  }
  for (let e = 0; e < 75; e++) for (const k of [0.999, 1, 1.0004, 1023.9, 1024]) {
    const n = k * 2 ** e;
    assert.equal(fmtBytes(n), rendererFmt(n));
    assert.doesNotMatch(fmtBytes(n), /^over/, "n=" + n);
  }
});

test("displayText: lone surrogates replaced, pairs never split by the cap, blank names become (unnamed)", () => {
  assert.doesNotMatch(displayText("a\uD800b\uDC00c"), /[\uD800-\uDFFF]/);
  const s = displayText("\u{1F600}".repeat(5), 3).replace(/\.\.\.$/, "");
  assert.doesNotMatch(s, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  const v = toView({ items: ["\u202E\u200B", "__proto__", "\uD800"].map((label, i) => makeFinding({ kind: "dir", path: "C:\\p" + i, label, bytes: 1, safe: OK, basis: "name" })) });
  assert.equal(v.rows[0].label, "(unnamed)");
  assert.equal(v.rows[1].label, "__proto__");
  assert.equal(v.rows[2].label, "(unnamed)");
});

test("ids are validated, never altered: bad id or bad companionOf drops the row", () => {
  const good = makeFinding({ kind: "dir", path: "C:\\g", label: "g", bytes: 1, safe: OK, basis: "vetted", oldEnough: true, locked: false });
  const base = { label: "x", path: null, bytes: 1, group: "exclusive", confidence: "high", preTicked: true, selectable: true };
  const v = toView({ items: [good, { ...base, id: "__proto__" }, { ...base, id: "p\nq" }, { ...base, id: "A".repeat(16) }, { ...base, id: "0123456789abcdef", companionOf: "zz" }, { ...base, id: 5 }] });
  assert.deepEqual(v.rows.map((r) => r.id), [good.id]);
});

test("ticked requires high confidence; NaN bytes are not 'resized'", () => {
  const base = { id: "0123456789abcdef", label: "x", path: null, bytes: 1, group: "exclusive", preTicked: true, selectable: true };
  assert.equal(toView({ items: [{ ...base, confidence: "medium" }] }).rows[0].ticked, false);
  assert.equal(toView({ items: [{ ...base, confidence: "high" }] }).rows[0].ticked, true);
  const a = { items: [{ ...base, bytes: NaN }] }, b = { items: [{ ...base, bytes: null }] };
  assert.deepEqual(diffScans(a, b), { added: [], removed: [], resized: [] });
  assert.deepEqual(diffScans(a, a), { added: [], removed: [], resized: [] });
});
