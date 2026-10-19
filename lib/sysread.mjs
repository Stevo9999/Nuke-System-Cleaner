// Read-only system readers. Three fixed Windows tools, array args, absolute
// System32 path, shell:false. Nothing here writes, deletes or imports anything.
// All tool output is untrusted text: parsers are pure, tolerant, never throw
// on hostile input, and flag anything that cannot be trusted for matching
// (non-ASCII becomes "?" in console output) as lossy.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const CV = "\\Microsoft\\Windows\\CurrentVersion\\";
const mk = (p, args = []) => Object.freeze({ path: p, args: Object.freeze([...args]) });

export const REG_KEYS = Object.freeze({
  uninstallHKLM: mk("HKLM\\SOFTWARE" + CV + "Uninstall", ["/s"]),
  uninstallWow: mk("HKLM\\SOFTWARE\\WOW6432Node" + CV + "Uninstall", ["/s"]),
  uninstallHKCU: mk("HKCU\\SOFTWARE" + CV + "Uninstall", ["/s"]),
  runHKCU: mk("HKCU\\SOFTWARE" + CV + "Run"),
  runOnceHKCU: mk("HKCU\\SOFTWARE" + CV + "RunOnce"),
  runHKLM: mk("HKLM\\SOFTWARE" + CV + "Run"),
  runOnceHKLM: mk("HKLM\\SOFTWARE" + CV + "RunOnce"),
  runWow: mk("HKLM\\SOFTWARE\\WOW6432Node" + CV + "Run"),
  services: mk("HKLM\\SYSTEM\\CurrentControlSet\\Services", ["/s", "/v", "ImagePath"]),
  // Known-folder protection (read-only): redirected Documents/Desktop/... and OneDrive account folders.
  userShellFolders: mk("HKCU\\SOFTWARE" + CV + "Explorer\\User Shell Folders"),
  oneDriveAccounts: mk("HKCU\\SOFTWARE\\Microsoft\\OneDrive\\Accounts", ["/s", "/v", "UserFolder"]),
});

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const SID_USER = /^S-1-5-21(-\d+){4}$/;
const HIGH_INTEGRITY = new Set(["S-1-16-12288", "S-1-16-16384"]);

// Characters we cannot trust for matching: byte >= 0x80, "?" (what the console
// turns unknown characters into), or an unexpanded %variable%.
function isLossy(...parts) {
  // also control characters (an embedded CR means the data is not what it seems)
  return parts.some((s) => /[\x00-\x08\x0a-\x1f\x7f-\xff?%]/.test(s));
}

// The Windows folder is FIXED, never read from the environment (%SystemRoot% can be steered by a same-user program,
// e.g. through HKCU\Environment, and would reach an elevated process). `systemRoot` is injectable for tests only.
export const FIXED_SYSTEM_ROOT = "C:\\Windows";
const okSystemRoot = r => typeof r === "string" && /^[A-Za-z]:\\/.test(r) && r.length < 260 && !r.includes("/")
  && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(r) && !/(^|\\)\.\.?(\\|$)/.test(r);

// Run one fixed System32 tool. Resolves { ok:true, code, stdout, stderr } or
// { ok:false, reason } with a fixed reason string (stderr is never echoed).
function runTool(exeName, args, opts = {}) {
  const { spawnFn = spawn, systemRoot = FIXED_SYSTEM_ROOT, timeoutMs = 30000, maxBytes = MAX_BYTES } = opts;
  if (!okSystemRoot(systemRoot)) {
    return Promise.resolve({ ok: false, reason: "invalid system root" });
  }
  const exe = path.join(systemRoot, "System32", exeName);
  if (!existsSync(exe)) return Promise.resolve({ ok: false, reason: exeName + " not found" });
  return new Promise((resolve) => {
    let done = false;
    let child;
    let timer = null;
    const out = [];
    let size = 0;
    let errBuf = Buffer.alloc(0);
    const finish = (r, kill) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (kill) { try { child.kill(); } catch { /* already gone */ } }
      resolve(r);
    };
    try {
      child = spawnFn(exe, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve({ ok: false, reason: "could not start " + exeName });
    }
    timer = setTimeout(() => finish({ ok: false, reason: "timed out" }, true), timeoutMs);
    child.stdout.on("data", (d) => {
      if (done) return;
      size += d.length;
      if (size > maxBytes) return finish({ ok: false, reason: "output too large" }, true);
      out.push(d);
    });
    child.stderr.on("data", (d) => {
      if (errBuf.length < MAX_STDERR) errBuf = Buffer.concat([errBuf, d]).subarray(0, MAX_STDERR);
    });
    child.on("error", () => finish({ ok: false, reason: "could not run " + exeName }, true));
    child.on("close", (code) =>
      finish({ ok: true, code, stdout: Buffer.concat(out), stderr: errBuf.toString("latin1") }, false));
  });
}

// ---------- reg.exe ----------

const MAX_LINE = 64 * 1024;
const REG_TYPES = new Set([
  "REG_SZ", "REG_EXPAND_SZ", "REG_MULTI_SZ", "REG_DWORD", "REG_QWORD", "REG_BINARY", "REG_NONE",
  "REG_DWORD_BIG_ENDIAN", "REG_DWORD_LITTLE_ENDIAN", "REG_QWORD_LITTLE_ENDIAN", "REG_LINK",
  "REG_RESOURCE_LIST", "REG_FULL_RESOURCE_DESCRIPTOR", "REG_RESOURCE_REQUIREMENTS_LIST",
]);
const HIVE = { HKLM: "HKEY_LOCAL_MACHINE", HKCU: "HKEY_CURRENT_USER" };
const SEP = "    ";

// Hand parser for one value line (no regex, so no backtracking). Linear:
// each marker candidate costs O(1) plus a type read capped at 40 chars.
function parseValueLine(line) {
  if (!line.startsWith(SEP)) return null;
  let from = 4;
  for (;;) {
    const m = line.indexOf(SEP + "REG_", from);
    if (m < 0) return null;
    const ts = m + 4;
    let te = ts;
    const lim = Math.min(line.length, ts + 40);
    while (te < lim) {
      const c = line.charCodeAt(te);
      if ((c >= 65 && c <= 90) || c === 95) te++; else break;
    }
    const type = line.slice(ts, te);
    const name = line.slice(4, m);
    if (name.length > 0 && REG_TYPES.has(type)) {
      if (te === line.length) return { name, type, data: "" };
      if (line.startsWith(SEP, te)) return { name, type, data: line.slice(te + 4) };
    }
    from = m + 1;
  }
}

// expected: optional { path (as in REG_KEYS), recursive }. Without it any HKEY_ line is accepted.
export function parseRegOutputDetailed(buf, expected = null) {
  const res = { keys: [], unparsed: 0, oversized: 0, rejectedKeys: 0, duplicateKeys: 0 };
  if (!Buffer.isBuffer(buf)) return res;
  let rootLc = null;
  if (expected) {
    const [hive, ...rest] = expected.path.split("\\");
    rootLc = [HIVE[hive], ...rest].join("\\").toLowerCase();
  }
  const seen = new Set();
  let cur = null;
  for (let line of buf.toString("latin1").split("\n")) {
    if (line.length > MAX_LINE) { res.oversized++; if (line.startsWith("HKEY_")) cur = null; continue; }
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim() === "" || line.startsWith("End of search:")) continue;
    if (line.startsWith("HKEY_")) {
      const p = line.trimEnd();
      const lc = p.toLowerCase();
      if (rootLc !== null) {
        const inRoot = lc === rootLc || (expected.recursive && lc.startsWith(rootLc + "\\"));
        if (!inRoot) { res.rejectedKeys++; cur = null; continue; }
      }
      if (seen.has(lc)) { res.duplicateKeys++; cur = null; continue; }
      seen.add(lc);
      cur = { path: p, values: Object.create(null) };
      res.keys.push(cur);
      continue;
    }
    const v = cur ? parseValueLine(line) : null;
    if (!v) { res.unparsed++; continue; }
    let name = v.name;
    let lossy = isLossy(name, v.data);
    if (name in cur.values) {
      cur.values[name].lossy = true;
      lossy = true;
      let n = 2;
      while ((name + " (duplicate #" + n + ")") in cur.values) n++;
      name = name + " (duplicate #" + n + ")";
    }
    cur.values[name] = { type: v.type, data: v.data, lossy };
  }
  return res;
}

export function parseRegOutput(buf) {
  return parseRegOutputDetailed(buf).keys;
}

export function regQuery(name, opts = {}) {
  if (typeof name !== "string" || !Object.hasOwn(REG_KEYS, name)) {
    throw new Error("regQuery: unknown key name");
  }
  const k = REG_KEYS[name];
  return runTool("reg.exe", ["query", k.path, ...k.args], opts).then((r) => {
    if (!r.ok) return r;
    if (r.code !== 0) {
      if (/unable to find the specified registry key/i.test(r.stderr)) return { ok: true, keys: [] };
      return { ok: false, reason: "reg.exe failed" };
    }
    const d = parseRegOutputDetailed(r.stdout, { path: k.path, recursive: k.args.includes("/s") });
    const notes = [];
    if (d.unparsed) notes.push(d.unparsed + " line(s) of registry output could not be read");
    if (d.oversized) notes.push(d.oversized + " over-long line(s) skipped");
    if (d.rejectedKeys) notes.push(d.rejectedKeys + " unexpected key line(s) ignored");
    if (d.duplicateKeys) notes.push(d.duplicateKeys + " duplicate key line(s) ignored");
    return notes.length ? { ok: true, keys: d.keys, partial: true, notes } : { ok: true, keys: d.keys };
  });
}

// ---------- CSV (schtasks / whoami) ----------

// Strict CSV. Returns array of rows, or null on any doubt.
function parseCsv(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const s = buf.toString("latin1");
  const rows = [];
  let row = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    let field = "";
    if (s[i] === '"') {
      i++;
      for (;;) {
        if (i >= n) return null; // unterminated quote
        const c = s[i];
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          i++;
          break;
        }
        field += c;
        i++;
      }
      if (i < n && s[i] !== "," && s[i] !== "\r" && s[i] !== "\n") return null;
    } else {
      while (i < n && s[i] !== "," && s[i] !== "\r" && s[i] !== "\n") {
        if (s[i] === '"') return null;
        field += s[i++];
      }
    }
    row.push(field);
    if (i >= n) break;
    if (s[i] === ",") {
      i++;
      if (i >= n) { row.push(""); break; }
      continue;
    }
    if (s[i] === "\r" && s[i + 1] === "\n") i += 2; else i++;
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  }
  if (row.length && !(row.length === 1 && row[0] === "")) rows.push(row);
  return rows;
}

export function parseSchtasksCsv(buf) {
  const rows = parseCsv(buf);
  if (!rows) return { ok: false, reason: "unreadable schtasks output" };
  const tasks = [];
  for (const r of rows) {
    if (r.length < 9) continue;
    tasks.push({ name: r[1], run: r[8], lossy: isLossy(r[1], r[8]) });
  }
  if (rows.length > 0 && tasks.length === 0) return { ok: false, reason: "unreadable schtasks output" };
  return { ok: true, tasks };
}

export function listScheduledTasks(opts = {}) {
  return runTool("schtasks.exe", ["/query", "/fo", "csv", "/v", "/nh"], opts).then((r) => {
    if (!r.ok) return r;
    if (r.code !== 0) return { ok: false, reason: "schtasks.exe failed" };
    return parseSchtasksCsv(r.stdout);
  });
}

// ---------- whoami.exe ----------

// Ruling R44: `elevated` is true or false only when the integrity level is known (exactly one Mandatory Label SID
// S-1-16-<n> in the third column of whoami /groups); otherwise it is null, never a silent false. `sid` is the account
// SID when it is a normal local/domain user SID (S-1-5-21-...), otherwise null (e.g. Entra), independently of `elevated`.
const LABEL_RE = /^S-1-16-\d{1,10}$/;

function sidOf(userBuf) {
  try {
    const u = parseCsv(userBuf);
    return u && u.length === 1 && u[0].length === 2 && SID_USER.test(u[0][1]) ? u[0][1] : null;
  } catch { return null; }
}
function elevationOf(groupsBuf) {
  try {
    const g = parseCsv(groupsBuf);
    if (!g) return null;
    const labels = new Set(g.filter((r) => r.length >= 3 && LABEL_RE.test(r[2])).map((r) => r[2]));
    if (labels.size !== 1) return null;   // none, or conflicting labels: cannot tell
    return HIGH_INTEGRITY.has([...labels][0]);
  } catch { return null; }
}

export function parseWhoami(userBuf, groupsBuf) {
  return { sid: sidOf(userBuf), elevated: elevationOf(groupsBuf) };
}

export async function readIdentity(opts = {}) {
  const u = await runTool("whoami.exe", ["/user", "/fo", "csv", "/nh"], opts);
  const userBuf = u.ok && u.code === 0 ? u.stdout : null;
  const g = await runTool("whoami.exe", ["/groups", "/fo", "csv", "/nh"], opts);
  const groupsBuf = g.ok && g.code === 0 ? g.stdout : null;
  return parseWhoami(userBuf, groupsBuf);
}
