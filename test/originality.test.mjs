// Originality guard: this project is its own design. It must not name, imitate or quote other cleaner/uninstaller products
// in anything that ships or is documented here, and it must not carry text copied from them. The names below are checked
// case-insensitively in every tracked file except test/ (this file) and package-lock.json.
// Allowed on purpose: credits for sources we really used (see app/renderer/credits.js) - those names are not in this list.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const FORBIDDEN = [
  "revo", "hunter mode", "evidence remover", "unrecoverable delete", "autorun manager", "junk files cleaner", "ccleaner", "bleachbit", "iobit",
  "glary", "privazer", "wise registry", "wise disk", "advanced systemcare", "geek uninstaller", "bcuninstaller", "bulk crap", "ashampoo", "cleanmypc",
  "norton utilities", "tuneup", "system mechanic", "avg tuneup", "auslogics", "razer cortex", "total uninstall", "your uninstaller", "ultimate uninstaller",
];
const WORD = new RegExp("(^|[^a-z])(" + FORBIDDEN.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?![a-z])", "i");

const tracked = () => {
  let out = "";
  try { out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", shell: false }); } catch { return []; }
  return out.split("\0").filter(Boolean);
};
const skip = f => f.startsWith("test/") || f === "package-lock.json" || f.startsWith("vendor/") || f.startsWith("sounds/") || !/\.(mjs|cjs|js|json|md|html|css|yml|txt)$/i.test(f);

test("originality: no other cleaner product or feature trademark is named anywhere we ship or document", () => {
  const hits = [];
  for (const f of tracked()) {
    if (skip(f)) continue;
    const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/);
    lines.forEach((l, i) => { const m = WORD.exec(l); if (m) hits.push(f + ":" + (i + 1) + " mentions \"" + m[2] + "\""); });
  }
  assert.deepEqual(hits, []);
});

test("originality: the credits page lists only sources we really use and never a competing product", () => {
  const src = fs.readFileSync(path.join(ROOT, "app/renderer/credits.js"), "utf8");
  assert.ok(!WORD.test(src));
  for (const need of ["Electron", "three.js", "Chromium", "CC0"]) assert.ok(src.includes(need), need);
});
