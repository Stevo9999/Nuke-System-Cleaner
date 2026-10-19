// lib/browsers.mjs
// THE vetted table for the "Browsers cleaner" scan. Pure data (no I/O, no process starts). It is handed to the same
// read-only engine as Smart Scan (lib/smartscan.mjs smartScan({ locations, excluded, ... })), so every candidate goes through
// the same checks: age floor, lock check, links never followed, protected roots, checkPath, and the R45 profile rule in the
// controller. Adding a name here is the only way a browser file can ever become a deletion candidate.
//
//   Browser cache     (pre-ticked like other vetted junk when old enough and not in use): the cache folders only.
//   Browsing history  (NEVER pre-ticked, medium confidence at most): three Chromium files, each with its consequence in words.
//
// Never offered, by construction (nothing in this table names them) and again by BROWSER_FORBIDDEN, which the engine checks at
// run time: cookies, saved passwords (Login Data), saved forms (Web Data), bookmarks, extensions, preferences, Local State,
// Firefox places.sqlite (it also holds bookmarks), key4.db, logins.json, and so on.

const L = "%LOCALAPPDATA%";
const A = "%APPDATA%";
const CHROMIUM_PROFILE = /^(Default|Profile \d{1,3})$/;
const FIREFOX_PROFILE = /^[a-z0-9]{8}\.[A-Za-z0-9_-]{1,64}$/;
const NOT_A_PATH = /^[^\\/]+$/;

export const CACHE_GROUP = "Browser cache";
export const HISTORY_GROUP = "Browsing history";
export const CLOSE_BROWSERS_NOTE = "Close your browsers for a complete clean";

// Only these folders inside a Chromium profile are cache (relative to the profile folder).
export const CHROMIUM_CACHE_DIRS = Object.freeze(["Cache", "Code Cache", "GPUCache", "DawnCache", "Service Worker\\CacheStorage", "Service Worker\\ScriptCache"]);
// Only these folders inside a Firefox profile under %LOCALAPPDATA% are cache.
export const FIREFOX_CACHE_DIRS = Object.freeze(["cache2", "startupCache"]);
// The only three files ever offered as "browsing history" (Chromium family only).
export const HISTORY_FILES = Object.freeze({
  "History": "The list of web pages you visited. Removing it clears your history and the suggestions that come from it. Bookmarks, passwords and cookies are not touched.",
  "Visited Links": "Remembers which links you already clicked, so they can show as visited. Removing it makes every link look unvisited again.",
  "Top Sites": "The tiles of your most-visited sites shown on a new tab. They fill in again as you browse.",
});

// Names that must never be produced by this scan (a test asserts it; the engine also refuses them at run time).
export const FORBIDDEN_NAMES = Object.freeze(["Cookies", "Login Data", "Login Data For Account", "Web Data", "Bookmarks", "Extensions", "Preferences",
  "Secure Preferences", "Local State", "places.sqlite", "cookies.sqlite", "formhistory.sqlite", "key4.db", "logins.json", "prefs.js", "extensions"]);

const FAMILIES = Object.freeze([
  { key: "chrome", name: "Chrome", local: L + "\\Google\\Chrome\\User Data", profiled: true },
  { key: "edge", name: "Edge", local: L + "\\Microsoft\\Edge\\User Data", profiled: true },
  { key: "brave", name: "Brave", local: L + "\\BraveSoftware\\Brave-Browser\\User Data", profiled: true },
  // Opera keeps one profile folder directly (no Default / Profile N); its cache is under Local, its history under Roaming.
  { key: "opera", name: "Opera", local: L + "\\Opera Software\\Opera Stable", roaming: A + "\\Opera Software\\Opera Stable", profiled: false },
  { key: "operagx", name: "Opera GX", local: L + "\\Opera Software\\Opera GX Stable", roaming: A + "\\Opera Software\\Opera GX Stable", profiled: false },
]);

const base = (o) => Object.freeze({ scope: "user", named: true, mergeNotes: true, minAgeHours: 24, ...o });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const exact = (name) => new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");

function build() {
  const out = [];
  for (const f of FAMILIES) {
    const profileSeg = f.profiled ? "\\<profile>" : "";
    const common = f.profiled ? { profile: CHROMIUM_PROFILE } : {};
    for (const dir of CHROMIUM_CACHE_DIRS) {
      out.push(base({ id: `${f.key}-cache-${slug(dir)}`, label: f.name + " cache", category: CACHE_GROUP, base: f.local + profileSeg + "\\" + dir, ...common,
        reason: "Temporary copies of web pages, images and scripts that " + f.name + " keeps so pages load faster. Safe to remove: pages just load a little slower the first time afterwards." }));
    }
    const histBase = (f.roaming ?? f.local) + profileSeg;
    for (const [file, why] of Object.entries(HISTORY_FILES)) {
      out.push(base({ id: `${f.key}-history-${slug(file)}`, label: f.name + " " + (file === "History" ? "browsing history" : file === "Visited Links" ? "visited-link memory" : "most-visited sites"),
        category: HISTORY_GROUP, base: histBase, ...common, match: exact(file), basis: "name", skipIfSibling: "-journal",
        reason: why + " Optional: not ticked for you." }));
    }
  }
  for (const dir of FIREFOX_CACHE_DIRS) {
    out.push(base({ id: `firefox-cache-${slug(dir)}`, label: "Firefox cache", category: CACHE_GROUP, base: L + "\\Mozilla\\Firefox\\Profiles\\<profile>\\" + dir, profile: FIREFOX_PROFILE,
      reason: "Temporary copies of web pages and images that Firefox keeps so pages load faster. Safe to remove: pages just load a little slower the first time afterwards." }));
  }
  return out;
}

export const BROWSER_LOCATIONS = Object.freeze(build());

// The engine's never-touch list for this table (replaces the Smart Scan list, which names the three history files).
function forbidden() {
  const out = [];
  for (const f of FAMILIES) {
    for (const r of [f.local, ...(f.roaming ? [f.roaming] : [])]) {
      if (f.profiled) {
        for (const n of [...FORBIDDEN_NAMES, "Network\\Cookies"]) out.push({ base: r + "\\<profile>\\" + n, profile: NOT_A_PATH });
        out.push({ base: r + "\\Local State" });   // the browser-wide file sits next to the profile folders
      } else {
        for (const n of [...FORBIDDEN_NAMES, "Network\\Cookies"]) out.push({ base: r + "\\" + n });
      }
    }
  }
  for (const root of [L, A]) {
    for (const n of FORBIDDEN_NAMES) out.push({ base: root + "\\Mozilla\\Firefox\\Profiles\\<profile>\\" + n, profile: NOT_A_PATH });
  }
  return out.map((x) => Object.freeze({ ...x, reason: "Cookies, passwords, bookmarks, extensions or settings: personal data, never part of the Browsers cleaner." }));
}
export const BROWSER_FORBIDDEN = Object.freeze(forbidden());
