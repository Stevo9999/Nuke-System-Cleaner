// The Credits page must stay in step with what the project really includes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CREDITS, LICENSE_TEXTS, LICENSE_LINKS } from "../../app/renderer/credits.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("credits: every entry names its maker, license and a source link; licenses have text or a link", () => {
  assert.ok(CREDITS.length >= 8);
  for (const c of CREDITS) {
    for (const k of ["kind", "name", "what", "by", "license", "url"]) assert.ok(typeof c[k] === "string" && c[k].length > 2, c.name + "." + k);
    assert.match(c.url, /^https:\/\//);
    assert.ok(["included", "build", "sound", "reference"].includes(c.kind));
  }
  const known = [...Object.keys(LICENSE_TEXTS), ...Object.keys(LICENSE_LINKS)];
  for (const c of CREDITS.filter(x => x.kind !== "reference")) assert.ok(known.some(l => c.license.includes(l)), c.name + " license text/link missing: " + c.license);
});

test("credits: every dependency in package.json, the vendored 3D code and the sounds are credited", () => {
  const text = JSON.stringify(CREDITS).toLowerCase();
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) assert.ok(text.includes(dep.toLowerCase()), "package.json dependency not credited: " + dep);
  assert.ok(fs.existsSync(path.join(ROOT, "vendor", "three.module.js")) && text.includes("three.js"));
  assert.ok(fs.readdirSync(path.join(ROOT, "sounds")).length > 0 && text.includes("cc0"));
  assert.ok(text.includes("chromium") && text.includes("node.js"));
});

test("credits: every renderer module main.js imports is served by the app:// protocol (a missing entry leaves a blank window)", async () => {
  const { UI_FILES } = await import("../../app/main/protocol.mjs");
  const js = fs.readFileSync(path.join(ROOT, "app/renderer/main.js"), "utf8");
  const files = [...js.matchAll(/^import .* from "\.\/([^"]+)"/gm)].map(m => m[1]);
  assert.ok(files.includes("credits.js"));
  for (const f of files) assert.ok(UI_FILES.has(f), f + " is not served");
});
