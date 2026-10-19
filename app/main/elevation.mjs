// app/main/elevation.mjs: Phase 1b "Relaunch as administrator".
//
// The only process this module ever starts is
//   <systemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>
// with an argument array and shell:false. The encoded script runs
//   Start-Process -FilePath '<execPath>' [-ArgumentList '"<arg>"',...] -Verb RunAs
// which shows the normal Windows UAC prompt. Every value is checked BEFORE anything starts: execPath and each argument
// must be an absolute local drive path (no UNC/device form, no "..", no control characters, no double quote, no
// trailing backslash). Each value is a single-quoted PowerShell literal with its quote characters doubled; arguments are
// also wrapped in double quotes because Start-Process joins -ArgumentList with spaces.
// Exit 0 = the elevated instance was started; 1223 (ERROR_CANCELLED) = the user said no at the UAC prompt.
// This module stops no service and changes no setting.
import path from "node:path";
import { spawn } from "node:child_process";
import { encodeCommand, psLiteral } from "../../lib/restore.mjs";

const UAC_CANCELLED = 1223;
const MAX_ARGS = 8;
const MAX_ENCODED = 30000;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function okPath(p) {
  return typeof p === "string" && p.length > 3 && p.length < 1024 && /^[A-Za-z]:\\/.test(p) && path.win32.isAbsolute(p)
    && !CONTROL_RE.test(p) && !p.includes("/") && !p.includes('"') && !p.endsWith("\\") && !p.slice(2).includes(":")
    && !/(^|\\)\.\.?(\\|$)/.test(p);
}
// Start-Process -FilePath is a wildcard pattern (there is no -LiteralPath): 'a[1]\x.exe' would start 'a1\x.exe'.
// So the program path may not contain any wildcard character. Arguments are passed literally and are not affected.
const WILDCARD_RE = /[[\]*?]/;
function checkInputs(execPath, args) {
  if (!okPath(execPath) || WILDCARD_RE.test(execPath)) throw new TypeError("execPath must be an absolute local path without control or wildcard characters");
  if (!Array.isArray(args) || args.length > MAX_ARGS) throw new TypeError("args must be an array of at most " + MAX_ARGS + " paths");
  for (const a of args) if (!okPath(a)) throw new TypeError("each argument must be an absolute local path without control characters");
}

export function relaunchScript({ execPath, args = [] } = {}) {
  checkInputs(execPath, args);
  const list = args.length ? " -ArgumentList " + args.map(a => psLiteral('"' + a + '"')).join(",") : "";
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  Start-Process -FilePath ${psLiteral(execPath)}${list} -Verb RunAs`,
    "  exit 0",
    "} catch {",
    "  $code = 1",
    "  $e = $_.Exception",
    `  while ($e) { if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq ${UAC_CANCELLED}) { $code = ${UAC_CANCELLED} }; $e = $e.InnerException }`,
    `  if ([string]$_.Exception.Message -match 'cancell?ed by the user') { $code = ${UAC_CANCELLED} }`,
    "  exit $code",
    "}",
  ].join("\r\n");
}

// R46: administrator mode is offered only for the installed (packaged) app under one of two fixed folders.
// The folders are literals, not taken from the environment: a user-controlled variable must not widen the list.
const PROGRAM_FILES = ["c:\\program files\\", "c:\\program files (x86)\\"];
export function relaunchAllowed({ app, execPath } = {}) {
  try {
    if (!app || app.isPackaged !== true || !okPath(execPath) || WILDCARD_RE.test(execPath)) return false;
    const norm = path.win32.normalize(execPath).toLowerCase();
    if (norm !== execPath.toLowerCase()) return false; // no ".", "..", doubled separators
    return PROGRAM_FILES.some(d => norm.startsWith(d) && norm.length > d.length);
  } catch { return false; }
}

/**
 * The wiring main.mjs uses (kept here so it can be tested with a fake `app`). The single-instance lock is released first
 * so the elevated instance can take it; on "started" this instance quits at once (the two never stay open side by side);
 * otherwise the lock is taken back, and if another instance took it meanwhile this one quits. Packaged: the app exe alone;
 * from source: electron.exe plus the absolute app folder.
 */
export function makeRelaunchElevated({ app, execPath, relaunch = relaunchAsAdmin }) {
  const allowed = relaunchAllowed({ app, execPath });
  const relaunchElevated = async function relaunchElevated() {
    if (!allowed) return "failed"; // R46: refused before the lock is touched or anything is started
    const args = app.isPackaged ? [] : [app.getAppPath()];
    app.releaseSingleInstanceLock();
    let out;
    try { out = await relaunch({ execPath, args }); } catch { out = "failed"; }
    if (out === "started") { app.quit(); return out; }
    if (!app.requestSingleInstanceLock()) { app.quit(); return "failed"; }
    return out;
  };
  relaunchElevated.allowed = allowed; // the controller reads this for statusGet / adminRelaunch
  return relaunchElevated;
}

/**
 * Resolves "started" | "cancelled" | "failed" | "timeout" (the prompt did not finish in time). Rejects (TypeError) only for
 * bad input, before anything starts.
 */
export async function relaunchAsAdmin({ execPath, args = [], spawnFn = spawn, systemRoot = "C:\\Windows", timeoutMs = 600000 } = {}) {
  if (typeof systemRoot !== "string" || !/^[A-Za-z]:\\[A-Za-z0-9_ .-]{1,64}$/.test(systemRoot) || /^[A-Za-z]:\\\.+$/.test(systemRoot))
    throw new TypeError("systemRoot must look like C:\\Windows");
  if (typeof spawnFn !== "function") throw new TypeError("spawnFn must be a function");
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
  const encoded = encodeCommand(relaunchScript({ execPath, args }));
  if (encoded.length > MAX_ENCODED) return "failed";
  const psExe = systemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

  return new Promise(resolve => {
    let settled = false, timer = null, child;
    const done = r => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(r); };
    try {
      child = spawnFn(psExe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { shell: false, windowsHide: true, stdio: "ignore" });
    } catch { done("failed"); return; }
    if (!child || typeof child.once !== "function") { done("failed"); return; }
    // A UAC prompt left open is not waited on forever.
    timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done("timeout"); }, timeoutMs);
    child.once("error", () => done("failed"));   // the error text carries the command line: dropped
    child.once("exit", code => done(code === 0 ? "started" : code === UAC_CANCELLED ? "cancelled" : "failed"));
  });
}
