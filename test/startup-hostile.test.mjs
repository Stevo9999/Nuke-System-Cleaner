import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listStartupItems } from "../lib/startup.mjs";

const keyOf = (values) => ({ ok: true, keys: [{ path: "HKEY_X\\Run", values }] });
const v = (data, lossy = false) => ({ type: "REG_SZ", data, lossy });
const emptyReg = async () => ({ ok: true, keys: [] });
function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "startup-h-"));
  const su = path.join(base, "AppData", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  mkdirSync(su, { recursive: true });
  return { base, su, env: { APPDATA: path.join(base, "AppData") } };
}

test("(value not set) default values are not startup items", async () => {
  const items = await listStartupItems({
    regQuery: async (n) => (n === "runHKCU" ? keyOf({ "(Default)": v("(value not set)"), Real: v("c.exe") }) : { ok: true, keys: [] }),
    env: {},
  });
  assert.deepEqual(items.map((i) => i.label), ["Real"]);
});

test("lnk reason includes the shortcut arguments", async () => {
  const { base, su, env } = setup();
  try {
    writeFileSync(path.join(su, "A.lnk"), "x");
    const items = await listStartupItems({ regQuery: emptyReg, env, readLnk: () => ({ target: "C:\\a.exe", args: "--silent /x" }) });
    assert.match(items[0].reason, /C:\\a\.exe --silent \/x/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("symlink skip is exercised through an injected lstat (fails if the isSymbolicLink check is removed)", async () => {
  const fsOps = {
    readdir: async () => ["real.lnk", "link.lnk", "dir"],
    lstat: async (p) => {
      if (p.endsWith("link.lnk")) return { isSymbolicLink: () => true, isFile: () => true };
      if (p.endsWith("dir")) return { isSymbolicLink: () => false, isFile: () => false };
      return { isSymbolicLink: () => false, isFile: () => true };
    },
  };
  const items = await listStartupItems({ regQuery: emptyReg, env: { APPDATA: "C:\\x" }, fsOps });
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => i.label === "real.lnk"));
});

test("notes: folder truncation, failed and partial registry reads are reported, never silent", async () => {
  const names = Array.from({ length: 2500 }, (_, i) => "f" + i + ".lnk");
  const fsOps = { readdir: async () => names, lstat: async () => ({ isSymbolicLink: () => false, isFile: () => true }) };
  const regQuery = async (n) =>
    n === "runHKCU" ? { ok: false, reason: "timed out" }
      : n === "runHKLM" ? { ok: true, keys: [], partial: true, notes: ["1 line could not be parsed"] }
        : { ok: true, keys: [] };
  const items = await listStartupItems({ regQuery, env: { APPDATA: "C:\\x" }, fsOps });
  const notes = items.notes.join("\n");
  assert.match(notes, /truncated/i);
  assert.match(notes, /HKCU Run/);
  assert.match(notes, /HKLM Run/);
});
