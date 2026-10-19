// lib/winapps.mjs: Windows (Store) apps for the current user: list and remove.
// The only process this module starts is
//   <systemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>
// (argument array, shell:false). The scripts below are fixed text (pinned by hash in the inventory tests); the only value ever
// placed in script text is a package full name that matched PACKAGE_FULL_NAME, as a single-quoted literal.
// Not elevated: Remove-AppxPackage without -AllUsers only touches the current user's copy.
import { spawn } from "node:child_process";
import { encodeCommand, psLiteral } from "./restore.mjs";

export const PACKAGE_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}_[0-9]+(\.[0-9]+){1,4}_[A-Za-z0-9]*_[A-Za-z0-9.-]*_[a-z0-9]{13}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_OUT = 4 * 1024 * 1024;

export const LIST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$a = @(Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.NonRemovable -and $_.SignatureKind -ne 'System' -and $_.InstallLocation })",
  "@($a | ForEach-Object { [pscustomobject]@{ n = [string]$_.Name; f = [string]$_.PackageFullName; v = [string]$_.Version } }) | ConvertTo-Json -Compress",
].join("\r\n");

export function removeScript(fullName) {
  if (typeof fullName !== "string" || !PACKAGE_FULL_NAME.test(fullName)) throw new TypeError("bad package name");
  return ["$ErrorActionPreference = 'Stop'", "try { Remove-AppxPackage -Package " + psLiteral(fullName) + " -ErrorAction Stop; exit 0 } catch { exit 1 }"].join("\r\n");
}

function runPs(script, { spawnFn = spawn, systemRoot = "C:\\Windows", timeoutMs = 120000 } = {}) {
  const exe = systemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  return new Promise(resolve => {
    let done = false, timer = null, size = 0;
    const out = [];
    let child;
    const finish = (r, kill) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (kill) { try { child.kill(); } catch { /* gone */ } } resolve(r); };
    try { child = spawnFn(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(script)], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve({ ok: false }); return; }
    timer = setTimeout(() => finish({ ok: false }, true), timeoutMs);
    child.stdout.on("data", d => { size += d.length; if (size > MAX_OUT) finish({ ok: false }, true); else out.push(d); });
    child.once("error", () => finish({ ok: false }, false));
    child.once("close", code => finish({ ok: code === 0, code, stdout: Buffer.concat(out).toString("utf8") }, false));
  });
}

/** { ok, apps: [{ name, fullName, version }] } sorted by name; entries with unexpected shapes are dropped. */
export async function listWindowsApps(opts = {}) {
  const r = await runPs(LIST_SCRIPT, opts);
  if (!r.ok) return { ok: false, apps: [] };
  let data;
  try { data = JSON.parse(r.stdout.trim() || "[]"); } catch { return { ok: false, apps: [] }; }
  if (data && !Array.isArray(data)) data = [data];
  const apps = [];
  for (const d of Array.isArray(data) ? data : []) {
    if (!d || typeof d.n !== "string" || typeof d.f !== "string" || !NAME.test(d.n) || !PACKAGE_FULL_NAME.test(d.f)) continue;
    apps.push(Object.freeze({ name: d.n, fullName: d.f, version: typeof d.v === "string" && /^[0-9.]{1,40}$/.test(d.v) ? d.v : "" }));
  }
  apps.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return { ok: true, apps };
}

export async function removeWindowsApp(fullName, opts = {}) {
  const script = removeScript(fullName); // throws before anything starts
  const r = await runPs(script, opts);
  return { ok: r.ok === true };
}
