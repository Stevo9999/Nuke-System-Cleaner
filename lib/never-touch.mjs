// lib/never-touch.mjs: places this app must NEVER offer or delete, whatever a scan, a picked file or a bug says.
// Written from Windows facts (Windows layout and the Windows Resource Protection rules documented by Microsoft; see
// docs/never-touch-list.md), not copied from any other project. Pure: no I/O, no process starts.
//
//   neverTouchPath(p, { profile, allowedAdminDirs })  -> a short reason string, or null when the path is not on the list.
//   neverTouchRegistryKey(key)                        -> a short reason string, or null. For the later registry cleaner;
//                                                        today nothing in the app writes the registry.
// Both fail closed: anything that cannot be understood returns a reason (= refuse).
import path from "node:path";

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const lc = s => s.toLowerCase();

// ---------------------------------------------------------------- files and folders
// Relative to the system drive root. A path equal to one of these, inside one, or the parent of one is refused.
const DRIVE_DENY = [
  "windows", "program files", "program files (x86)", "programdata\\microsoft", "system volume information", "recovery", "boot", "efi",
  "users\\default", "users\\public", "users\\all users", "windows.old", "$winreagent", "pagefile.sys", "hiberfil.sys", "swapfile.sys", "bootmgr", "bootnxt",
];
// Relative to a user profile folder. Same rule. NTUSER.DAT* and UsrClass.dat* are matched by file-name prefix below.
const PROFILE_DENY = [
  "appdata\\roaming\\microsoft\\protect", "appdata\\roaming\\microsoft\\crypto", "appdata\\roaming\\microsoft\\systemcertificates",
  "appdata\\roaming\\microsoft\\credentials", "appdata\\local\\microsoft\\credentials", "appdata\\roaming\\microsoft\\vault",
  "appdata\\local\\microsoft\\vault", "appdata\\local\\microsoft\\windows\\usrclass.dat", ".ssh", ".gnupg",
];
const PROFILE_FILE_PREFIXES = ["ntuser.dat", "usrclass.dat"];

const parts = p => path.win32.resolve(p).split("\\").filter(Boolean);
function relation(a, b) { // a, b: lower-cased segment arrays -> "equal" | "inside" (a inside b) | "parent" (a contains b) | null
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return null;
  return a.length === b.length ? "equal" : a.length > b.length ? "inside" : "parent";
}

export function neverTouchPath(p, { profile = null, allowedAdminDirs = [] } = {}) {
  try {
    if (typeof p !== "string" || p.length === 0 || p.length > 1024 || CONTROL.test(p) || p.includes("/")) return "unreadable path";
    if (!/^[A-Za-z]:\\/.test(p) || p.startsWith("\\\\")) return "not a local drive path";
    const segs = lc(path.win32.resolve(p)).split("\\").filter(Boolean); // ["c:", "windows", ...]
    if (segs.length <= 1) return "drive root";
    const rest = segs.slice(1);
    // The four administrator-mode folders are the only things inside C:\Windows or C:\ProgramData that may ever be offered,
    // and only their direct children (the controller enforces the rest); a direct child of one of them is not refused here.
    for (const d of Array.isArray(allowedAdminDirs) ? allowedAdminDirs : []) {
      const dsegs = lc(path.win32.resolve(d)).split("\\").filter(Boolean);
      if (dsegs.length === segs.length - 1 && relation(segs.slice(0, -1), dsegs) === "equal") return null;
    }
    for (const d of DRIVE_DENY) {
      const r = relation(rest, d.split("\\"));
      if (r) return r === "parent" ? "contains a protected Windows folder" : "protected Windows location";
    }
    if (typeof profile === "string" && /^[A-Za-z]:\\/.test(profile)) {
      const pr = lc(path.win32.resolve(profile)).split("\\").filter(Boolean);
      if (relation(segs, pr) === "inside") {
        const inner = segs.slice(pr.length);
        for (const d of PROFILE_DENY) {
          const r = relation(inner, d.split("\\"));
          if (r) return r === "parent" ? "contains a protected account folder" : "protected account data";
        }
        const name = inner[inner.length - 1];
        if (PROFILE_FILE_PREFIXES.some(x => name.startsWith(x))) return "protected account data";
      }
    }
    return null;
  } catch { return "unreadable path"; }
}

// ---------------------------------------------------------------- registry
const HIVES = { hklm: "hklm", hkey_local_machine: "hklm", hkcu: "hkcu", hkey_current_user: "hkcu", hkcr: "hkcr", hkey_classes_root: "hkcr",
  hku: "hku", hkey_users: "hku", hkcc: "hkcc", hkey_current_config: "hkcc" };

// The key itself and its parents can never be deleted (the folders that hold everything else).
const EXACT = {
  hklm: ["software", "software\\microsoft", "software\\microsoft\\windows", "software\\microsoft\\windows nt", "software\\microsoft\\windows\\currentversion",
    "software\\microsoft\\windows\\currentversion\\uninstall", "software\\microsoft\\windows\\currentversion\\app paths", "software\\microsoft\\windows\\currentversion\\run",
    "software\\microsoft\\windows\\currentversion\\runonce", "software\\classes", "software\\policies"],
  hkcu: ["software", "software\\microsoft", "software\\microsoft\\windows", "software\\microsoft\\windows nt", "software\\microsoft\\windows\\currentversion",
    "software\\microsoft\\windows\\currentversion\\uninstall", "software\\microsoft\\windows\\currentversion\\run", "software\\microsoft\\windows\\currentversion\\runonce",
    "software\\classes", "software\\policies"],
};
// The key and everything below it is off limits.
const CLASS_TREES = ["clsid", "interface", "typelib", "appid", "installer", "licenses", "mime", "packagedcom", "local settings", "wow6432node", "systemfileassociations",
  "*", "allfilesystemobjects", "directory", "folder", "drive", "unknown", "desktopbackground",
  ".exe", ".dll", ".sys", ".com", ".bat", ".cmd", ".lnk", ".reg", ".msi", ".msc", ".cpl", ".scr", ".inf", ".vbs", ".js", ".ps1", ".url", ".cab", ".mui", ".ocx", ".drv",
  "exefile", "batfile", "cmdfile", "comfile", "regfile", "lnkfile", "piffile", "scrfile", "txtfile", "inifile", "inffile", "vbsfile", "jsfile", "wshfile", "mscfile",
  "cplfile", "dllfile", "sysfile", "htmlfile", "cabfolder", "compressedfolder", "themefile", "http", "https", "ftp", "file", "ms-settings", "shell"];
const TREES = {
  hklm: ["sam", "security", "hardware", "bcd00000000", "drivers", "system",
    "software\\policies", "software\\microsoft\\windows nt\\currentversion", "software\\microsoft\\windows\\currentversion\\policies",
    "software\\microsoft\\windows\\currentversion\\component based servicing", "software\\microsoft\\windows\\currentversion\\installer",
    "software\\microsoft\\windows\\currentversion\\explorer", "software\\microsoft\\windows\\currentversion\\group policy",
    "software\\microsoft\\windows\\currentversion\\authentication", "software\\microsoft\\windows\\currentversion\\shellserviceobjectdelayload",
    "software\\microsoft\\active setup", "software\\microsoft\\windows defender", "software\\microsoft\\cryptography", "software\\microsoft\\systemcertificates",
    ...CLASS_TREES.map(c => "software\\classes\\" + c)],
  hkcu: ["environment", "software\\policies", "software\\microsoft\\windows\\currentversion\\policies",
    "software\\microsoft\\windows\\currentversion\\explorer\\user shell folders", "software\\microsoft\\windows\\currentversion\\explorer\\shell folders",
    "software\\microsoft\\windows\\currentversion\\explorer\\fileexts", "software\\microsoft\\windows\\currentversion\\group policy",
    ...CLASS_TREES.map(c => "software\\classes\\" + c)],
};

const sameFlavour = (a, b) => relation(a.split("\\"), b.split("\\"));

export function neverTouchRegistryKey(key) {
  try {
    if (typeof key !== "string" || key.length === 0 || key.length > 1024 || CONTROL.test(key) || key.includes("/") || /(^|\\)\.\.?(\\|$)/.test(key)) return "unreadable key";
    const segs = lc(key).replace(/\\+$/, "").split("\\");
    const hive = HIVES[segs[0]];
    if (!hive) return "unknown registry area";
    let rest = segs.slice(1);
    if (rest.length === 0) return "registry root";
    if (hive === "hkcc") return "current hardware profile";
    if (hive === "hku") { // HKU\<SID>\...: the account's own hive behaves like HKCU
      if (!/^s-1-\d+(-\d+)+(_classes)?$|^\.default$/.test(rest[0])) return "unknown registry area";
      const classes = rest[0].endsWith("_classes");
      rest = rest.slice(1);
      if (rest.length === 0) return "account registry root";
      if (classes) rest = ["software", "classes", ...rest];
      return check("hkcu", rest.join("\\"));
    }
    let r = rest.join("\\");
    if (hive === "hkcr") { // HKCR is the merge of the two Classes keys: test both
      return check("hklm", "software\\classes\\" + r) || check("hkcu", "software\\classes\\" + r);
    }
    return check(hive, r);
  } catch { return "unreadable key"; }
}

function check(hive, rel) {
  // WOW6432Node mirrors the 64-bit tree: HKLM\SOFTWARE\WOW6432Node\X is judged like HKLM\SOFTWARE\X.
  const norm = rel.replace(/^software\\wow6432node(\\|$)/, (m, s) => "software" + s);
  for (const t of TREES[hive] || []) {
    const r = sameFlavour(norm, t);
    if (r === "equal" || r === "inside") return "protected registry area";
    if (r === "parent") return "contains a protected registry area";
  }
  for (const e of EXACT[hive] || []) {
    const r = sameFlavour(norm, e);
    if (r === "equal" || r === "parent") return "protected registry container";
  }
  return null;
}
