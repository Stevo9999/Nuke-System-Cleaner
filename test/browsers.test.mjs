// Browsers cleaner (round 2): the vetted browser table through the read-only Smart Scan engine, on fake trees under os.tmpdir().
// No real browser data is ever read or touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { smartScan } from "../lib/smartscan.mjs";
import { BROWSER_LOCATIONS, BROWSER_FORBIDDEN, FORBIDDEN_NAMES, HISTORY_FILES, CACHE_GROUP, HISTORY_GROUP, CLOSE_BROWSERS_NOTE,
  CHROMIUM_CACHE_DIRS, FIREFOX_CACHE_DIRS } from "../lib/browsers.mjs";

const H = 3600 * 1000;
const NOW = Date.now() + 100 * H; // files are created "now", so the scan clock runs 100h ahead; mtimes are set relative to it
const age = (p, hours) => { const t = (NOW - hours * H) / 1000; fs.utimesSync(p, t, t); };
const file = (p, hours = 30, body = "data") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); age(p, hours); return p; };
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browsers-"));
  const LOCALAPPDATA = path.join(root, "Local");
  const APPDATA = path.join(root, "Roaming");
  fs.mkdirSync(LOCALAPPDATA, { recursive: true });
  fs.mkdirSync(APPDATA, { recursive: true });
  const env = { LOCALAPPDATA, APPDATA, ProgramData: path.join(root, "PD"), SystemRoot: path.join(root, "Win"), SystemDrive: "C:" };
  return { root, env, L: LOCALAPPDATA, A: APPDATA };
}
const scan = (env, extra = {}) => smartScan({ env, now: NOW, locations: BROWSER_LOCATIONS, excluded: BROWSER_FORBIDDEN, resultKind: "browsers",
  lockedNote: CLOSE_BROWSERS_NOTE, ...extra });

const CHROMIUMS = [["Chrome", ["Google", "Chrome", "User Data"]], ["Edge", ["Microsoft", "Edge", "User Data"]], ["Brave", ["BraveSoftware", "Brave-Browser", "User Data"]]];
const FF = "abcd1234.default-release";

// A full fake machine: every family, every cache folder, plus every kind of personal data that must never be offered.
function fullFixture(t) {
  const made = { cache: [], history: [], personal: [] };
  const personal = (p) => { file(p, 500, "secret"); made.personal.push(p); };
  for (const [, parts] of CHROMIUMS) {
    const ud = path.join(t.L, ...parts);
    for (const prof of ["Default", "Profile 2"]) {
      for (const d of CHROMIUM_CACHE_DIRS) made.cache.push(file(path.join(ud, prof, ...d.split("\\"), "sub", "f1")));
      for (const h of Object.keys(HISTORY_FILES)) made.history.push(file(path.join(ud, prof, h)));
      for (const n of ["Cookies", "Login Data", "Login Data For Account", "Web Data", "Bookmarks", "Preferences", "Secure Preferences"]) personal(path.join(ud, prof, n));
      personal(path.join(ud, prof, "Network", "Cookies"));
      personal(path.join(ud, prof, "Extensions", "abc", "1.0", "manifest.json"));
      personal(path.join(ud, prof, "Local Storage", "leveldb", "000003.log"));
      personal(path.join(ud, prof, "IndexedDB", "x", "y"));
    }
    personal(path.join(ud, "Local State"));
    // folders that are not profiles are never looked at
    file(path.join(ud, "Guest Profile", "Cache", "Cache_Data", "g1"));
    file(path.join(ud, "System Profile", "Cache", "s1"));
  }
  for (const [name, win] of [["Opera Stable", "Opera"], ["Opera GX Stable", "Opera GX"]]) {
    const lo = path.join(t.L, "Opera Software", name), ro = path.join(t.A, "Opera Software", name);
    void win;
    for (const d of CHROMIUM_CACHE_DIRS) made.cache.push(file(path.join(lo, ...d.split("\\"), "sub", "f1")));
    for (const h of Object.keys(HISTORY_FILES)) made.history.push(file(path.join(ro, h)));
    for (const n of ["Cookies", "Login Data", "Bookmarks", "Preferences", "Local State"]) personal(path.join(ro, n));
    personal(path.join(ro, "Extensions", "e", "manifest.json"));
  }
  for (const d of FIREFOX_CACHE_DIRS) made.cache.push(file(path.join(t.L, "Mozilla", "Firefox", "Profiles", FF, d, "entries", "e1")));
  for (const root of [t.L, t.A]) {
    for (const n of ["places.sqlite", "cookies.sqlite", "key4.db", "logins.json", "formhistory.sqlite", "prefs.js"]) personal(path.join(root, "Mozilla", "Firefox", "Profiles", FF, n));
    personal(path.join(root, "Mozilla", "Firefox", "Profiles", FF, "extensions", "x.xpi"));
  }
  return made;
}

test("every browser family is found: Chrome, Edge, Brave, Opera, Opera GX and Firefox, cache and history", async () => {
  const t = setup();
  try {
    const made = fullFixture(t);
    const r = await scan(t.env);
    assert.equal(r.kind, "browsers");
    assert.equal(r.partial, false);
    for (const brand of ["Chrome", "Edge", "Brave", "Opera", "Opera GX", "Firefox"]) {
      assert.ok(r.items.some((i) => i.label === brand + " cache"), brand + " cache found");
    }
    for (const brand of ["Chrome", "Edge", "Brave", "Opera", "Opera GX"]) {
      assert.ok(r.items.some((i) => i.label === brand + " browsing history"), brand + " history found");
    }
    // every fixture cache folder / history file shows up as exactly one finding (children of each cache folder, files of the profile)
    const paths = new Set(r.items.map((i) => i.path.toLowerCase()));
    for (const h of made.history) assert.ok(paths.has(h.toLowerCase()), h);
    for (const c of made.cache) {
      const dirOfItem = [...paths].some((p) => c.toLowerCase().startsWith(p + path.sep));
      assert.ok(dirOfItem, "cache file is covered by a finding: " + c);
    }
    // Profile 2 is found too, Guest / System profiles are not
    assert.ok(r.items.some((i) => /[\\/]Profile 2[\\/]Cache[\\/]/.test(i.path)));
    assert.ok(!r.items.some((i) => /Guest Profile|System Profile/.test(i.path)));
  } finally { rm(t.root); }
});

test("cache findings are high confidence and pre-ticked; history findings are medium and NEVER pre-ticked", async () => {
  const t = setup();
  try {
    fullFixture(t);
    const r = await scan(t.env);
    const cache = r.items.filter((i) => i.category === CACHE_GROUP);
    const hist = r.items.filter((i) => i.category === HISTORY_GROUP);
    assert.ok(cache.length > 10 && hist.length === 24);
    assert.equal(cache.length + hist.length, r.items.length, "only the two groups exist");
    for (const i of cache) {
      assert.deepEqual([i.group, i.confidence, i.preTicked, i.selectable, i.kind], ["exclusive", "high", true, true, "dir"], i.path);
      assert.match(i.reason, /Safe to remove/);
    }
    for (const i of hist) {
      assert.deepEqual([i.group, i.confidence, i.preTicked, i.selectable, i.kind], ["exclusive", "medium", false, true, "file"], i.path);
      assert.match(i.reason, /Optional: not ticked for you/);
      assert.ok(["History", "Visited Links", "Top Sites"].includes(path.basename(i.path)), i.path);
    }
    // a plain label, not the raw path
    assert.ok(r.items.every((i) => i.label !== i.path));
  } finally { rm(t.root); }
});

test("nothing outside the allowlist can appear; cookies, passwords, bookmarks, extensions, preferences and the rest are never produced", async () => {
  const t = setup();
  try {
    const made = fullFixture(t);
    const r = await scan(t.env);
    assert.ok(made.personal.length > 40);
    const allowedDirs = new Set([...CHROMIUM_CACHE_DIRS, ...FIREFOX_CACHE_DIRS].map((d) => d.toLowerCase()));
    const historyNames = new Set(Object.keys(HISTORY_FILES).map((n) => n.toLowerCase()));
    for (const i of r.items) {
      const rel = path.relative(t.root, i.path).split(path.sep).map((s) => s.toLowerCase());
      const base = rel[rel.length - 1];
      const underCacheDir = [...allowedDirs].some((d) => {
        const segs = d.split("\\");
        for (let k = 0; k + segs.length <= rel.length; k++) if (segs.every((s, j) => rel[k + j] === s)) return true;
        return false;
      });
      assert.ok(underCacheDir || historyNames.has(base), "allowlisted place only: " + i.path);
      // none of the forbidden names is a segment of the path, and no finding is an ancestor of a personal file
      for (const n of FORBIDDEN_NAMES) assert.ok(!rel.includes(n.toLowerCase()), n + " in " + i.path);
      for (const p of made.personal) assert.ok(!(p.toLowerCase() + path.sep).startsWith(i.path.toLowerCase() + path.sep), i.path + " would contain " + p);
    }
    for (const p of made.personal) assert.ok(fs.existsSync(p), "scanning never touches it: " + p);
    // and the rules themselves: no table entry can name them
    for (const L of BROWSER_LOCATIONS) {
      const tail = L.base.split("\\").slice(-2).join("\\").toLowerCase();
      for (const n of FORBIDDEN_NAMES) assert.notEqual(path.basename(L.base.replace(/\\/g, "/")).toLowerCase(), n.toLowerCase(), L.id + " names " + n);
      assert.ok(typeof tail === "string");
      if (L.match) {
        for (const n of FORBIDDEN_NAMES) { L.match.lastIndex = 0; assert.equal(L.match.test(n), false, L.id + " match accepts " + n); }
        for (const n of ["History-journal", "history", "History ", "Top Sites-journal", "Cookies", "places.sqlite"]) { L.match.lastIndex = 0; assert.equal(L.match.test(n), false, L.id + " match accepts " + n); }
      }
      assert.ok(/^%(LOCALAPPDATA|APPDATA)%\\/.test(L.base), L.id);
      assert.equal(L.scope, "user");
    }
  } finally { rm(t.root); }
});

test("the forbidden names cannot be reached even if a table entry tried: the engine refuses an item that is, holds or sits inside one", async () => {
  const t = setup();
  try {
    const ud = path.join(t.L, "Google", "Chrome", "User Data", "Default");
    file(path.join(ud, "Cookies"), 500);
    file(path.join(ud, "Network", "Cookies"), 500);
    file(path.join(ud, "Login Data"), 500);
    // a hostile table: asks for the whole profile folder's children, so Cookies / Login Data / Network are candidates
    const hostile = [{ id: "x", label: "Hostile", scope: "user", base: "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\<profile>", profile: /^Default$/, minAgeHours: 24, reason: "r", named: true }];
    const r = await scan(t.env, { locations: hostile });
    assert.deepEqual(r.items, [], "every forbidden name is refused by the run-time list");
    assert.ok(fs.existsSync(path.join(ud, "Cookies")));
  } finally { rm(t.root); }
});

test("too-new rule: a cache folder holding one young file, and a young History file, are not offered", async () => {
  const t = setup();
  try {
    const ud = path.join(t.L, "Google", "Chrome", "User Data", "Default");
    file(path.join(ud, "Cache", "Cache_Data", "old"), 30);
    file(path.join(ud, "Cache", "Cache_Data", "young"), 2);
    file(path.join(ud, "Code Cache", "js", "fine"), 40);
    file(path.join(ud, "History"), 3);
    file(path.join(ud, "Top Sites"), 50);
    const r = await scan(t.env);
    const names = r.items.map((i) => path.relative(ud, i.path).replace(/\\/g, "/")).sort();
    assert.deepEqual(names, ["Code Cache/js", "Top Sites"]);
    assert.ok(r.notes.some((n) => /^Chrome cache: 1 items skipped: in use, newer than 24 hours/.test(n)), r.notes.join("|"));
    assert.ok(r.notes.some((n) => /^Chrome browsing history: 1 items skipped/.test(n)));
    assert.ok(!r.notes.includes(CLOSE_BROWSERS_NOTE), "too new is not the same as locked");
  } finally { rm(t.root); }
});

test("locked files are skipped and the results say: Close your browsers for a complete clean", async () => {
  const t = setup();
  try {
    const ud = path.join(t.L, "Google", "Chrome", "User Data", "Default");
    file(path.join(ud, "Cache", "Cache_Data", "data_1"), 30);
    file(path.join(ud, "GPUCache", "data_0"), 30);
    file(path.join(ud, "History"), 30);
    const lock = (p) => p.endsWith("data_1") || p.endsWith("History");
    const r = await scan(t.env, { isLocked: lock });
    assert.deepEqual(r.items.map((i) => path.relative(ud, i.path)), ["GPUCache\\data_0".replace(/\\/g, path.sep)]);
    assert.ok(r.notes.includes("Close your browsers for a complete clean"));
    assert.equal(CLOSE_BROWSERS_NOTE, "Close your browsers for a complete clean");
    assert.equal(r.notes.filter((n) => n === CLOSE_BROWSERS_NOTE).length, 1);
    // nothing locked, nothing to close
    const ok = await scan(t.env, { isLocked: () => false });
    assert.equal(ok.items.length, 3);
    assert.ok(!ok.notes.includes(CLOSE_BROWSERS_NOTE));
  } finally { rm(t.root); }
});

test("a History file with a leftover -journal next to it is left alone", async () => {
  const t = setup();
  try {
    const ud = path.join(t.L, "Google", "Chrome", "User Data", "Default");
    file(path.join(ud, "History"), 30);
    file(path.join(ud, "History-journal"), 30);
    file(path.join(ud, "Visited Links"), 30);
    const r = await scan(t.env);
    assert.deepEqual(r.items.map((i) => path.basename(i.path)), ["Visited Links"]);
  } finally { rm(t.root); }
});

test("a link or junction inside a cache folder is never followed or offered", async () => {
  const t = setup();
  try {
    const ud = path.join(t.L, "Google", "Chrome", "User Data", "Default");
    const outside = path.join(t.root, "Precious");
    file(path.join(outside, "keep.txt"), 500);
    fs.mkdirSync(path.join(ud, "Cache"), { recursive: true });
    let linked = true;
    try { fs.symlinkSync(outside, path.join(ud, "Cache", "Cache_Data"), "junction"); } catch { linked = false; }
    file(path.join(ud, "GPUCache", "data_0"), 30);
    const r = await scan(t.env);
    if (linked) assert.ok(!r.items.some((i) => /Cache_Data/.test(i.path)), "the junction is not offered");
    assert.ok(r.items.some((i) => /GPUCache/.test(i.path)));
    assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
  } finally { rm(t.root); }
});

test("user-excluded folders: nothing at, inside or around them is offered, and a base inside one is refused", async () => {
  const t = setup();
  try {
    const ud = path.join(t.L, "Google", "Chrome", "User Data", "Default");
    file(path.join(ud, "Cache", "Cache_Data", "a"), 30);
    file(path.join(ud, "GPUCache", "data_0"), 30);
    file(path.join(ud, "Code Cache", "js", "j"), 30);
    file(path.join(ud, "History"), 30);
    const all = await scan(t.env);
    assert.equal(all.items.length, 4);
    // exclude the GPUCache folder itself, something inside Code Cache, and the History file
    const r = await scan(t.env, { extraProtected: [path.join(ud, "GPUCache"), path.join(ud, "Code Cache", "js", "j"), path.join(ud, "History")] });
    assert.deepEqual(r.items.map((i) => path.relative(ud, i.path)).sort(), [path.join("Cache", "Cache_Data")]);
    // excluding a folder ABOVE a base removes the base entirely (and says so)
    const r2 = await scan(t.env, { extraProtected: [ud] });
    assert.deepEqual(r2.items, []);
    assert.ok(r2.notes.some((n) => /was not scanned/.test(n)));
  } finally { rm(t.root); }
});

test("table shape: ids unique, labels plain, every cache folder and the three history files are covered, nothing else", () => {
  const ids = BROWSER_LOCATIONS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(BROWSER_LOCATIONS.length, 5 * (CHROMIUM_CACHE_DIRS.length + 3) + FIREFOX_CACHE_DIRS.length);
  assert.deepEqual(CHROMIUM_CACHE_DIRS, ["Cache", "Code Cache", "GPUCache", "DawnCache", "Service Worker\\CacheStorage", "Service Worker\\ScriptCache"]);
  assert.deepEqual(FIREFOX_CACHE_DIRS, ["cache2", "startupCache"]);
  assert.deepEqual(Object.keys(HISTORY_FILES), ["History", "Visited Links", "Top Sites"]);
  for (const l of BROWSER_LOCATIONS) {
    assert.ok(l.category === CACHE_GROUP || l.category === HISTORY_GROUP, l.id);
    assert.equal(l.minAgeHours, 24);
    assert.equal(l.named, true);
    assert.equal(l.basis === "name", l.category === HISTORY_GROUP, l.id + ": only history is medium");
    assert.ok(Object.isFrozen(l));
  }
  assert.ok(Object.isFrozen(BROWSER_LOCATIONS) && Object.isFrozen(BROWSER_FORBIDDEN));
  assert.ok(!BROWSER_LOCATIONS.some((l) => /Firefox/.test(l.base) && l.category === HISTORY_GROUP), "Firefox places.sqlite (bookmarks live there) is not offered");
  assert.ok(!BROWSER_LOCATIONS.some((l) => /%APPDATA%\\Mozilla/.test(l.base)));
});
