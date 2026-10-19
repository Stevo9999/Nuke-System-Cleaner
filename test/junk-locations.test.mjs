import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCATIONS, EXCLUDED, expandBase } from "../lib/junk-locations.mjs";
import { appProtectedRoots, violatesRoots } from "../app/main/appdata.mjs";
import { within } from "../lib/safepath.mjs";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

function fakeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "junkloc-"));
  const LOCALAPPDATA = path.join(root, "Users", "me", "AppData", "Local");
  const APPDATA = path.join(root, "Users", "me", "AppData", "Roaming");
  const vars = { LOCALAPPDATA, APPDATA, SystemRoot: path.join(root, "Windows"), ProgramData: path.join(root, "ProgramData"), SystemDrive: "C:", SID };
  for (const p of ["Default", "Profile 1", "Guest Profile", "System Profile"]) {
    for (const b of ["Google\\Chrome", "Microsoft\\Edge"]) fs.mkdirSync(path.join(LOCALAPPDATA, ...(b + "\\User Data\\" + p).split("\\")), { recursive: true });
  }
  for (const p of ["abcd1234.default-release", "notaprofile"]) fs.mkdirSync(path.join(LOCALAPPDATA, "Mozilla", "Firefox", "Profiles", p), { recursive: true });
  for (const p of ["abcd1234.default-release", "notaprofile"]) fs.mkdirSync(path.join(APPDATA, "Mozilla", "Firefox", "Profiles", p), { recursive: true });
  return { root, vars };
}
const expandLoc = (l, vars) => expandBase(l.base, vars, l.profile);

test("table: every entry has reason >= 20 chars, minAgeHours >= 24, a known scope; user bases expand under LOCALAPPDATA or the recycle bin", () => {
  const { root, vars } = fakeEnv();
  try {
    assert.ok(LOCATIONS.length >= 18);
    assert.ok(Object.isFrozen(LOCATIONS));
    const ids = new Set();
    for (const l of LOCATIONS) {
      assert.ok(typeof l.reason === "string" && l.reason.length >= 20, l.id);
      assert.ok(l.minAgeHours >= 24, l.id);
      assert.ok(["user", "system"].includes(l.scope), l.id);
      assert.ok(!ids.has(l.id), "duplicate id " + l.id);
      ids.add(l.id);
      if (l.scope === "user") {
        const exp = expandLoc(l, vars);
        if (l.pairing === "recycle") {
          assert.deepEqual(exp, [path.resolve("C:\\$Recycle.Bin\\" + SID)]);
        } else {
          assert.ok(exp.length >= 1, l.id + " expands to something in the fake tree or is a profile-less base");
          for (const p of exp) assert.ok(within(p, vars.LOCALAPPDATA) && p.toLowerCase() !== vars.LOCALAPPDATA.toLowerCase(), l.id + " " + p);
        }
      }
    }
    for (const id of ["user-temp", "inet-cache", "thumbcache", "crash-dumps", "d3d-cache", "chrome-cache", "edge-cache", "firefox-cache", "recycle-bin",
      "windows-temp", "minidump", "wu-download", "other-recycle"]) assert.ok(ids.has(id), id);
    const wu = LOCATIONS.find((l) => l.id === "wu-download");
    assert.equal(wu.needsStoppedService, "wuauserv");
    assert.equal(LOCATIONS.find((l) => l.id === "recycle-bin").pairing, "recycle");
    assert.ok(LOCATIONS.filter((l) => l.scope === "system" && l.adminCleanable).length >= 3);
    // only the profiles that match the entry's regexp are used
    const chrome = expandLoc(LOCATIONS.find((l) => l.id === "chrome-cache"), vars).map((p) => p.toLowerCase());
    assert.equal(chrome.length, 2);
    assert.ok(chrome.every((p) => !p.includes("guest") && !p.includes("system profile")));
    assert.equal(expandLoc(LOCATIONS.find((l) => l.id === "firefox-cache"), vars).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("table: no base expands to a drive root, home, LOCALAPPDATA/APPDATA itself, or an EXCLUDED path", () => {
  const { root, vars } = fakeEnv();
  try {
    const env = { LOCALAPPDATA: vars.LOCALAPPDATA, APPDATA: vars.APPDATA, ProgramData: vars.ProgramData };
    const roots = appProtectedRoots({ home: os.homedir(), env });
    const excluded = EXCLUDED.flatMap((x) => {
      assert.ok(x.reason.length >= 10);
      return expandBase(x.base, vars, x.profile ?? /^[^\\/]+$/);
    });
    assert.ok(excluded.length >= 10);
    for (const l of LOCATIONS) {
      for (const p of expandLoc(l, vars)) {
        assert.notEqual(path.parse(p).root.toLowerCase(), p.toLowerCase(), "drive root " + l.id);
        assert.equal(violatesRoots(p, roots), false, "equals or contains a protected root: " + l.id);
        for (const x of excluded) assert.ok(!within(p, x) && (!within(x, p) || path.dirname(x).toLowerCase() === p.toLowerCase()), l.id + " overlaps excluded " + x);   // a base may hold an excluded DIRECT child (smartScan skips it, tested there)
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("expandBase: only the six vars, missing or odd values and unknown vars give []", () => {
  const { root, vars } = fakeEnv();
  try {
    assert.deepEqual(expandBase("%LOCALAPPDATA%\\Temp", vars), [path.join(vars.LOCALAPPDATA, "Temp")]);
    assert.deepEqual(expandBase("%PATH%\\x", { ...vars, PATH: "C:\\x" }), []);
    assert.deepEqual(expandBase("%USERPROFILE%\\x", { ...vars, USERPROFILE: "C:\\Users\\me" }), []);
    assert.deepEqual(expandBase("%LOCALAPPDATA%\\Temp", { ...vars, LOCALAPPDATA: undefined }), []);
    assert.deepEqual(expandBase("%LOCALAPPDATA%\\Temp", { ...vars, LOCALAPPDATA: "relative\\path" }), []);
    assert.deepEqual(expandBase("%LOCALAPPDATA%\\Temp", { ...vars, LOCALAPPDATA: "\\\\server\\share" }), []);
    assert.deepEqual(expandBase("%SystemDrive%\\$Recycle.Bin\\%SID%", { ...vars, SID: "S-1-5-21-1\\..\\x" }), []);
    assert.deepEqual(expandBase("%SystemDrive%\\$Recycle.Bin\\%SID%", { ...vars, SID: undefined }), []);
    assert.deepEqual(expandBase("%SystemDrive%\\$Recycle.Bin", { ...vars, SystemDrive: "C:\\evil" }), []);
    assert.deepEqual(expandBase("%LOCALAPPDATA%\\%oops", vars), []);
    assert.deepEqual(expandBase("%LOCALAPPDATA%\\Google\\Chrome\\User Data\\<profile>\\Cache", vars), [], "no profile regexp");
    assert.deepEqual(expandBase("<profile>\\x", vars, /./), []);
    assert.deepEqual(expandBase(null, vars), []);
    assert.deepEqual(expandBase("%LOCALAPPDATA%\\Temp", null), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
