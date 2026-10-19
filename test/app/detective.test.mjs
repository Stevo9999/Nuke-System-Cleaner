import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../app/renderer/detective.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../../app/renderer/detective.css", import.meta.url), "utf8");

test("clampFraction: NaN/null -> null, -1 -> 0, 2 -> 1, 0.42 -> 0.42", async () => {
  const { clampFraction } = await import("../../app/renderer/detective.js");
  assert.equal(clampFraction(NaN), null);
  assert.equal(clampFraction(null), null);
  assert.equal(clampFraction(undefined), null);
  assert.equal(clampFraction(Infinity), null);
  assert.equal(clampFraction("0.5"), null);
  assert.equal(clampFraction(-1), 0);
  assert.equal(clampFraction(2), 1);
  assert.equal(clampFraction(0.42), 0.42);
  assert.equal(clampFraction(0), 0);
  assert.equal(clampFraction(1), 1);
});

test("pure helpers: eyePhase bounded and periodic, labelText, percentOf", async () => {
  const { eyePhase, labelText, percentOf } = await import("../../app/renderer/detective.js");
  for (let t = 0; t < 10000; t += 137) {
    const p = eyePhase(t);
    assert.ok(p >= -1 && p <= 1, `phase ${p}`);
  }
  assert.equal(eyePhase(0), 0);
  assert.equal(eyePhase(NaN), 0);
  assert.ok(Math.abs(eyePhase(300) - eyePhase(300 + 2400)) < 1e-9);
  assert.equal(percentOf(0.42), 42);
  assert.equal(percentOf(null), null);
  assert.equal(labelText("Scanning", 0.42), "Scanning 42%");
  assert.equal(labelText("Scanning", null), "Scanning\u2026");
  assert.equal(labelText("Scanning", 0.5, "C:\\x"), "C:\\x");
  assert.equal(labelText("Scanning", 0.5, 42), "Scanning 50%");
});

test("source: SVG via createElementNS, role=progressbar, aria-valuenow updated in set(), text via textContent", () => {
  assert.match(SRC, /createElementNS/);
  assert.match(SRC, /"role",\s*"progressbar"/);
  assert.match(SRC, /aria-valuenow/);
  assert.match(SRC, /aria-valuemin/);
  assert.match(SRC, /aria-valuemax/);
  assert.match(SRC, /\.textContent\s*=/);
  assert.match(SRC, /aria-live/);
});

test("css: eyes keyframes exist and a prefers-reduced-motion block sets animation:none", () => {
  assert.match(CSS, /@keyframes\s+det-eyes/);
  assert.match(CSS, /@keyframes\s+det-glass/);
  const m = CSS.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/);
  assert.ok(m, "reduced-motion block");
  assert.match(m[1], /animation:\s*none/);
  assert.match(m[1], /transition:\s*none/);
});

test("no innerHTML/insertAdjacentHTML/url(/http/import of anything", () => {
  for (const [name, s] of [["js", SRC], ["css", CSS]]) {
    assert.doesNotMatch(s, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, name);
    assert.doesNotMatch(s, /url\(/i, name);
    assert.doesNotMatch(s, /@import/, name);
    assert.doesNotMatch(s, /https?:\/\//, name === "js" ? "js (svg ns is built from parts)" : name);
  }
  assert.doesNotMatch(SRC, /^\s*import\s|\bimport\s*\(|\brequire\(/m);
  assert.doesNotMatch(SRC, /fetch\(|XMLHttpRequest|WebSocket/);
});

function stubDoc() {
  const mk = (tag, ns) => {
    const e = {
      tag, ns, attrs: {}, children: [], style: {}, _text: "", textWrites: 0, classes: new Set(),
      setAttribute(k, v) { this.attrs[k] = String(v); },
      removeAttribute(k) { delete this.attrs[k]; },
      getAttribute(k) { return this.attrs[k] ?? null; },
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); this.textWrites++; },
    };
    e.classList = { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c) };
    return e;
  };
  const doc = { createElement: (t) => mk(t), createElementNS: (ns, t) => mk(t, ns) };
  const host = doc.createElement("div");
  host.ownerDocument = doc;
  return { doc, host };
}
const find = (n, pred) => (pred(n) ? n : n.children.map((c) => find(c, pred)).find(Boolean));

test("set() on a stub DOM writes aria-valuenow 42 for 0.42 and removes it for null", async () => {
  const { mountDetective } = await import("../../app/renderer/detective.js");
  const { host } = stubDoc();
  const d = mountDetective(host, { label: "Scanning" });
  const bar = find(host, (n) => n.attrs.role === "progressbar");
  assert.ok(bar);
  assert.equal(bar.attrs["aria-valuemin"], "0");
  assert.equal(bar.attrs["aria-valuemax"], "100");
  assert.equal(bar.attrs["aria-valuenow"], undefined, "starts indeterminate");
  d.set(0.42);
  assert.equal(bar.attrs["aria-valuenow"], "42");
  d.set(7);
  assert.equal(bar.attrs["aria-valuenow"], "100");
  d.set(null);
  assert.equal(bar.attrs["aria-valuenow"], undefined);
  const svg = find(host, (n) => n.tag === "svg");
  assert.equal(svg.ns, "http://www.w3.org/2000/svg");
});

test("text only written on change; hostile text goes through textContent", async () => {
  const { mountDetective } = await import("../../app/renderer/detective.js");
  const { host } = stubDoc();
  const d = mountDetective(host);
  const line = find(host, (n) => n.attrs["aria-live"]);
  assert.ok(line);
  d.set(0.1, "<img src=x onerror=1>");
  const w = line.textWrites;
  assert.equal(line.textContent, "<img src=x onerror=1>");
  d.set(0.1, "<img src=x onerror=1>");
  d.set(0.1, "<img src=x onerror=1>");
  assert.equal(line.textWrites, w);
  d.set(0.2);
  assert.equal(line.textContent, "Scanning 20%");
  d.destroy();
  assert.equal(host.children.length, 0);
  d.set(0.5); // no throw after destroy
});
