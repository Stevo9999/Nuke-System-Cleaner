// lib/junk-locations.mjs
// THE vetted table of places Smart Scan may look. Reviewed like code: adding an entry here is the only way
// a new folder can ever become a deletion candidate. Pure data plus a read-only template expander.
import fs from "node:fs";
import path from "node:path";
import { suspiciousPathForm } from "./safepath.mjs";

const DAY = 24;
const L = "%LOCALAPPDATA%";
const CHROME = L + "\\Google\\Chrome\\User Data\\<profile>";
const EDGE = L + "\\Microsoft\\Edge\\User Data\\<profile>";
const CHROMIUM_PROFILE = /^(Default|Profile \d{1,3})$/;

const loc = (o) => Object.freeze({ minAgeHours: DAY, ...o });

export const LOCATIONS = Object.freeze([
  loc({ id: "user-temp", label: "Temporary files", scope: "user", base: L + "\\Temp",
    reason: "Temporary files that programs leave behind; anything in use or recent is left alone." }),
  loc({ id: "inet-cache", label: "Internet cache (Windows)", scope: "user", base: L + "\\Microsoft\\Windows\\INetCache",
    reason: "Cached web content kept by Windows components; it is downloaded again when needed." }),
  loc({ id: "thumbcache", label: "Thumbnail and icon cache", scope: "user", base: L + "\\Microsoft\\Windows\\Explorer",
    match: /^(thumbcache|iconcache)_[A-Za-z0-9]+\.db$/,
    reason: "Picture thumbnails and icon caches; rebuilt by Windows the next time they are needed." }),
  loc({ id: "crash-dumps", label: "Crash dumps", scope: "user", base: L + "\\CrashDumps", match: /\.dmp$/,
    reason: "Memory dumps written when a program crashed; only useful to someone debugging that crash." }),
  loc({ id: "wer-user-archive", label: "Error reports (archive)", scope: "user", base: L + "\\Microsoft\\Windows\\WER\\ReportArchive",
    reason: "Windows Error Reporting archive of old crash reports for this user." }),
  loc({ id: "wer-user-queue", label: "Error reports (queue)", scope: "user", base: L + "\\Microsoft\\Windows\\WER\\ReportQueue",
    reason: "Windows Error Reporting queue of crash reports waiting to be sent for this user." }),
  loc({ id: "d3d-cache", label: "Graphics shader cache", scope: "user", base: L + "\\D3DSCache",
    reason: "DirectX shader cache; games and apps rebuild it automatically." }),
  loc({ id: "chrome-cache", label: "Chrome cache", scope: "user", base: CHROME + "\\Cache\\Cache_Data", profile: CHROMIUM_PROFILE,
    reason: "Web pages and images Chrome saved for speed; downloaded again when needed." }),
  loc({ id: "chrome-code-cache", label: "Chrome cache", scope: "user", base: CHROME + "\\Code Cache", profile: CHROMIUM_PROFILE,
    reason: "Compiled web script cache kept by Chrome; rebuilt automatically." }),
  loc({ id: "chrome-gpu-cache", label: "Chrome cache", scope: "user", base: CHROME + "\\GPUCache", profile: CHROMIUM_PROFILE,
    reason: "Graphics cache kept by Chrome; rebuilt automatically." }),
  loc({ id: "edge-cache", label: "Edge cache", scope: "user", base: EDGE + "\\Cache\\Cache_Data", profile: CHROMIUM_PROFILE,
    reason: "Web pages and images Edge saved for speed; downloaded again when needed." }),
  loc({ id: "edge-code-cache", label: "Edge cache", scope: "user", base: EDGE + "\\Code Cache", profile: CHROMIUM_PROFILE,
    reason: "Compiled web script cache kept by Edge; rebuilt automatically." }),
  loc({ id: "edge-gpu-cache", label: "Edge cache", scope: "user", base: EDGE + "\\GPUCache", profile: CHROMIUM_PROFILE,
    reason: "Graphics cache kept by Edge; rebuilt automatically." }),
  loc({ id: "firefox-cache", label: "Firefox cache", scope: "user", base: L + "\\Mozilla\\Firefox\\Profiles\\<profile>\\cache2",
    profile: /^[a-z0-9]{8}\.[A-Za-z0-9_-]{1,64}$/,
    reason: "Web pages and images Firefox saved for speed; downloaded again when needed." }),
  loc({ id: "recycle-bin", label: "Recycle Bin", scope: "user", base: "%SystemDrive%\\$Recycle.Bin\\%SID%", pairing: "recycle",
    reason: "Files you already deleted and left in your Recycle Bin on the system drive." }),

  loc({ id: "windows-temp", label: "Windows temporary files", scope: "system", base: "%SystemRoot%\\Temp", adminCleanable: true,
    reason: "System-wide temporary files; reported only, an administrator run is needed to clear them." }),
  loc({ id: "minidump", label: "System crash dumps", scope: "system", base: "%SystemRoot%\\Minidump", match: /\.dmp$/, adminCleanable: true,
    reason: "Small memory dumps from system crashes; reported only, an administrator run is needed." }),
  loc({ id: "wer-system-archive", label: "System error reports (archive)", scope: "system",
    base: "%ProgramData%\\Microsoft\\Windows\\WER\\ReportArchive", adminCleanable: true,
    reason: "Windows Error Reporting archive for the whole PC; reported only, an administrator run is needed." }),
  loc({ id: "wer-system-queue", label: "System error reports (queue)", scope: "system",
    base: "%ProgramData%\\Microsoft\\Windows\\WER\\ReportQueue", adminCleanable: true,
    reason: "Windows Error Reporting queue for the whole PC; reported only, an administrator run is needed." }),
  loc({ id: "wu-download", label: "Windows Update downloads", scope: "system", base: "%SystemRoot%\\SoftwareDistribution\\Download",
    needsStoppedService: "wuauserv",
    reason: "Update downloads owned by the Windows Update service; always report-only, it must be stopped first." }),
  loc({ id: "other-recycle", label: "Other users' Recycle Bins", scope: "system", base: "%SystemDrive%\\$Recycle.Bin",
    reason: "Recycle Bins of other accounts on this PC; always report-only, never touched." }),
]);

const BROWSER_PROFILE = /^[^\\/]+$/;
export const EXCLUDED = Object.freeze([
  { base: "%SystemRoot%\\Installer", reason: "Windows Installer cache: needed to repair, update or remove installed programs." },
  { base: "%SystemRoot%\\Installer\\$PatchCache$", reason: "Windows Installer patch cache: needed to uninstall updates." },
  { base: "%ProgramData%\\Package Cache", reason: "Installer packages that programs need to repair or uninstall themselves." },
  { base: "%SystemRoot%\\Prefetch", reason: "Windows start-up speed data; deleting it only slows things down." },
  { base: "%SystemRoot%\\WinSxS", reason: "Windows component store: never safe to delete by hand." },
  { base: "%LOCALAPPDATA%\\Microsoft\\Windows\\INetCache\\Content.Outlook",
    reason: "Outlook's attachment folder: it can hold the only copy of a file you opened and edited from an email." },
  { base: "%LOCALAPPDATA%\\Packages", reason: "Store app data, including saved settings and documents." },
  ...["Google\\Chrome", "Microsoft\\Edge"].flatMap((b) => ["History", "Cookies", "Network\\Cookies", "Login Data", "Web Data"].map((f) => ({
    base: "%LOCALAPPDATA%\\" + b + "\\User Data\\<profile>\\" + f, profile: BROWSER_PROFILE,
    reason: "Browser history, cookies, passwords or saved forms: personal data, not cache." }))),
  ...["places.sqlite", "cookies.sqlite", "logins.json", "key4.db", "formhistory.sqlite"].map((f) => ({
    base: "%APPDATA%\\Mozilla\\Firefox\\Profiles\\<profile>\\" + f, profile: BROWSER_PROFILE,
    reason: "Browser history, cookies, passwords or saved forms: personal data, not cache." })),
]);

const VAR_NAMES = new Set(["LOCALAPPDATA", "APPDATA", "SystemRoot", "ProgramData", "SystemDrive", "SID"]);
const SID_RE = /^S-1-\d+(-\d+){1,15}$/;
const DRIVE_RE = /^[A-Za-z]:$/;

function varOk(name, v) {
  if (typeof v !== "string" || v.length === 0 || v.includes("\0")) return false;
  if (name === "SID") return SID_RE.test(v);
  if (name === "SystemDrive") return DRIVE_RE.test(v);
  return path.isAbsolute(v) && suspiciousPathForm(v) === null;
}

function isRealDir(p) {
  try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
}

// Expands %VAR%s (only the six listed) and an optional single "<profile>" segment (names in the folder before it
// that match `profile` and are real folders). Unknown var, missing/odd value, or a bad template -> [].
export function expandBase(template, vars, profile) {
  try {
    if (typeof template !== "string" || template.length === 0 || !vars || typeof vars !== "object") return [];
    let bad = false;
    const sub = template.replace(/%([^%\\]*)%/g, (_m, name) => {
      if (!VAR_NAMES.has(name) || !Object.hasOwn(vars, name) || !varOk(name, vars[name])) { bad = true; return ""; }
      return vars[name];
    });
    if (bad || sub.includes("%")) return [];
    const segs = sub.split("\\");
    const at = segs.indexOf("<profile>");
    if (segs.some((s, i) => i !== at && s.includes("<"))) return [];
    if (at === -1) return [path.resolve(sub)];
    if (!(profile instanceof RegExp) || at === 0) return [];
    const parent = path.resolve(segs.slice(0, at).join("\\"));
    const rest = segs.slice(at + 1);
    if (!isRealDir(parent)) return [];
    const out = [];
    for (const name of fs.readdirSync(parent)) {
      profile.lastIndex = 0;
      if (!profile.test(name)) continue;
      const dir = path.join(parent, name);
      if (!isRealDir(dir)) continue;
      out.push(path.resolve(dir, ...rest));
    }
    return out;
  } catch { return []; }
}
