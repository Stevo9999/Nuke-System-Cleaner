import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { squarify } from "../lib/squarify.mjs";

const area = c => c.w * c.h;
test("cells tile the rectangle exactly and areas are proportional to value", () => {
  const items = [{ value: 60 }, { value: 30 }, { value: 6 }, { value: 4 }];
  const cells = squarify(items, 0, 0, 200, 100);
  assert.equal(cells.length, 4);
  assert.ok(Math.abs(cells.reduce((n, c) => n + area(c), 0) - 20000) < 1e-6);
  cells.forEach((c, i) => assert.ok(Math.abs(area(c) / 20000 - items[i].value / 100) < 1e-9));
  for (const c of cells) assert.ok(c.x >= -1e-9 && c.y >= -1e-9 && c.x + c.w <= 200 + 1e-9 && c.y + c.h <= 100 + 1e-9);
});
test("a single item fills the rectangle", () => {
  const [c] = squarify([{ value: 5 }], 10, 20, 300, 150);
  assert.deepEqual([c.x, c.y, c.w, c.h], [10, 20, 300, 150]);
});
test("one huge item and many tiny ones still produce finite, positive cells", () => {
  const items = [{ value: 1e9 }, ...Array.from({ length: 50 }, () => ({ value: 1 }))];
  for (const c of squarify(items, 0, 0, 800, 400)) assert.ok(Number.isFinite(c.w) && Number.isFinite(c.h) && c.w > 0 && c.h > 0);
});
test("empty input gives no cells", () => assert.deepEqual(squarify([], 0, 0, 10, 10), []));
test("cells keep input order and reference their item; no two cells overlap", () => {
  const items = [50, 20, 10, 10, 5, 3, 2].map((value, i) => ({ value, i }));
  const cells = squarify(items, 5, 5, 400, 300);
  cells.forEach((c, k) => assert.equal(c.item, items[k]));
  for (let a = 0; a < cells.length; a++) for (let b = a + 1; b < cells.length; b++) {
    const p = cells[a], q = cells[b];
    const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x), oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
    assert.ok(ox <= 1e-6 || oy <= 1e-6, `cells ${a} and ${b} overlap`);
  }
});
test("equal values on a tall rectangle also tile exactly", () => {
  const cells = squarify(Array.from({ length: 9 }, () => ({ value: 7 })), 0, 0, 90, 400);
  assert.ok(Math.abs(cells.reduce((n, c) => n + area(c), 0) - 36000) < 1e-6);
});
test("the copy of squarify inlined in cleanup.html is identical to lib/squarify.mjs", () => {
  const lf = s => s.replace(/\r\n/g, "\n");
  const lib = lf(fs.readFileSync(new URL("../lib/squarify.mjs", import.meta.url), "utf8"));
  const page = lf(fs.readFileSync(new URL("../cleanup.html", import.meta.url), "utf8"));
  const m = /\/\* squarify:begin \*\/\n([\s\S]*?)\/\* squarify:end \*\//.exec(page);
  assert.ok(m, "markers present");
  assert.equal(m[1], lib.replace(/^export function/m, "function").replace(/^\/\/.*\n/gm, ""));
});
