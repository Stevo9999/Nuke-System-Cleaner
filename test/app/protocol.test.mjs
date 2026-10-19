import test from "node:test";
import assert from "node:assert/strict";
import { UI_FILES, UI_CSP, resolveUi } from "../../app/main/protocol.mjs";

const DIR = "C:\\app\\renderer";

test("UI_FILES and UI_CSP are the exact specified values", () => {
  assert.deepEqual([...UI_FILES].sort(), "index.html main.js main.css phases.js credits.js detective.js detective.css results.html results.js results.css".split(" ").sort());
  assert.equal(UI_CSP, "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
});

test("resolveUi: allowlisted files resolve with a content type", () => {
  for (const f of UI_FILES) {
    const r = resolveUi("app://ui/" + f, DIR);
    assert.ok(r, f);
    assert.equal(r.file, DIR + "\\" + f);
    assert.match(r.type, /^text\/(html|javascript|css)(; charset=utf-8)?$/);
  }
  assert.equal(resolveUi("app://ui/index.html", DIR).type.split(";")[0], "text/html");
  assert.equal(resolveUi("app://ui/main.js", DIR).type.split(";")[0], "text/javascript");
  assert.equal(resolveUi("app://ui/main.css", DIR).type.split(";")[0], "text/css");
});

test("resolveUi: allowlist only; rejects ../, %2e%2e, %5c, other hosts, query/fragment variants, unknown files", () => {
  const bad = [
    "app://ui/../main.mjs", "app://ui/..%2fmain.mjs", "app://ui/%2e%2e/main.js", "app://ui/%2E%2E%2Fmain.js",
    "app://ui/..\\main.js", "app://ui/%5cmain.js", "app://ui/sub%5cmain.js", "app://ui/sub/main.js", "app://ui//main.js",
    "app://ui/index.html?x=1", "app://ui/index.html#frag", "app://ui/index.html?", "app://ui/index.html#",
    "app://ui/", "app://ui", "app://ui/unknown.js", "app://ui/INDEX.HTML", "app://ui/index.html ", "app://ui/index.html.",
    "app://ui/index.html%00", "app://ui/index.html\0", "app://ui/index%2ehtml", "app://ui/%69ndex.html",
    "app://UI.evil/index.html", "app://evil/index.html", "app://ui@evil/index.html", "app://ui:80/index.html",
    "app://user@ui/index.html", "APP://ui/index.html", "http://ui/index.html", "file:///C:/index.html",
    "https://evil/index.html", "app:/ui/index.html", "app:///ui/index.html", "app://ui\\index.html",
    "app://ui/results.json", "app://ui/preload.cjs", "app://ui/main.js/", "app://ui/main.js/..",
    "app://ui/ index.html", "app://ui/index.html\n", "", "app://",
  ];
  for (const u of bad) assert.equal(resolveUi(u, DIR), null, JSON.stringify(u));
  for (const u of [null, undefined, 42, {}, [], ["app://ui/index.html"]]) assert.equal(resolveUi(u, DIR), null);
  assert.equal(resolveUi("app://ui/index.html", ""), null, "empty uiDir refused");
  assert.equal(resolveUi("app://ui/index.html", undefined), null);
});
