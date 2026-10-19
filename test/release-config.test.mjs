// Release packaging stays consistent: artifact names, generated disclaimer text, line endings and no stray BOMs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectedFiles } from "../scripts/sync-disclaimer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const norm = s => s.replace(/\r\n/g, "\n");

test("electron-builder artifact names match the zip script, Install.bat, README and the read-me", () => {
  const yml = read("electron-builder.yml");
  const portable = /portable:\s*\n\s*artifactName:\s*(.+?)[ \t]*\r?\n/.exec(yml)[1];
  const setup = /nsis:[\s\S]*?artifactName:\s*(.+?)[ \t]*(\r?\n|$)/.exec(yml)[1];
  assert.equal(portable, "Nuke System Cleaner - Portable.exe");
  assert.equal(setup, "Nuke System Cleaner - Installer.exe");
  assert.ok(!/\$\{version\}/.test(portable + setup), "fixed names: docs and scripts refer to them literally");
  const zip = read("scripts/make-release-zip.ps1");
  for (const n of [portable, setup]) {
    assert.ok(zip.includes(n), "make-release-zip.ps1 mentions " + n);
    assert.ok(read("README.md").includes(n), "README mentions " + n);
    assert.ok(read("scripts/release-extras/READ-ME-FIRST.txt").includes(n), "READ-ME-FIRST mentions " + n);
  }
  assert.ok(read("scripts/release-extras/Install.bat").includes(setup));
  assert.match(yml, /license:\s*build\/license\.txt/);
  assert.match(yml, /allowToChangeInstallationDirectory:\s*true/);
});

test("naming: product/file names, ids, wizard captions and the uninstall entry name", () => {
  const yml = read("electron-builder.yml");
  assert.match(yml, /^appId: local\.nuke-system-cleaner$/m);
  assert.match(yml, /^productName: Nuke System Cleaner$/m);
  assert.match(yml, /include:\s*build\/installer\.nsh/);
  assert.match(yml, /uninstallDisplayName:\s*Nuke System Cleaner$/m);
  const nsh = read("build/installer.nsh");
  assert.match(nsh, /!macro customHeader/);
  assert.match(nsh, /^\s*Caption "Nuke System Cleaner - Installer"$/m);
  assert.match(nsh, /^\s*UninstallCaption "Nuke System Cleaner - Uninstaller"$/m);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, "nuke-system-cleaner");
  assert.match(read("scripts/make-release-zip.ps1"), /Nuke-System-Cleaner-\$v-windows-x64\.zip/);
  for (const f of ["README.md", "package.json", "scripts/release-extras/READ-ME-FIRST.txt"]) assert.ok(read(f).includes("https://github.com/Stevo9999/Nuke-System-Cleaner"), f);
});

test("the disclaimer in README, READ-ME-FIRST and the installer terms is generated from docs/disclaimer.txt (no drift)", () => {
  for (const [f, want] of Object.entries(expectedFiles())) assert.equal(norm(read(f)), norm(want), f + " is out of date: run node scripts/sync-disclaimer.mjs");
  assert.match(read("docs/disclaimer.txt"), /I AM NOT LIABLE/);
});

test("line endings and byte-order marks: batch and installer text are CRLF in the repo rules, no file starts with a BOM", () => {
  const attrs = read(".gitattributes");
  for (const rule of ["*.bat text eol=crlf", "build/license.txt text eol=crlf"]) assert.ok(attrs.includes(rule), rule);
  for (const f of ["README.md", "electron-builder.yml", "package.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "scripts/release-extras/Install.bat", "build/license.txt"])
    assert.ok(!read(f).startsWith("﻿"), f + " must not start with a byte-order mark");
});

test("Install.bat tells the user when setup was cancelled instead of claiming success", () => {
  const bat = read("scripts/release-extras/Install.bat");
  assert.match(bat, /if errorlevel 1/);
  assert.ok(bat.indexOf("if errorlevel 1") < bat.indexOf("Finished."));
});

test("the app icon exists as a real PNG (at least 256 px, as electron-builder needs) with its SVG source, and the build config points at it", () => {
  const png = fs.readFileSync(path.join(ROOT, "build/icon.png"));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
  assert.ok(png.readUInt32BE(16) >= 256 && png.readUInt32BE(20) >= 256, "at least 256x256");
  assert.match(read("build/icon.svg"), /<svg[^>]*viewBox="0 0 512 512"/);
  assert.match(read("electron-builder.yml"), /icon:\s*build\/icon\.png/);
});
