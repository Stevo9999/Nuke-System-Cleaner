// lib/restore.mjs: one Windows restore point before a delete, with an honest outcome.
//
// The only process this module ever starts is
//   <systemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>
// with an argument array and shell:false. Script text travels only as -EncodedCommand (UTF-16LE base64), because
// PowerShell 5.1 mangles numeric-looking tokens on a plain command line. Every value placed in script text is a
// single-quoted PowerShell literal with its quote characters doubled.
//
// Not elevated: the "outer" script asks for administrator approval with Start-Process -Verb RunAs -Wait -PassThru (the
// normal UAC prompt), runs the "inner" script elevated, and exits with the inner process's exit code. Elevated: the inner
// script runs directly. The inner script calls Checkpoint-Computer, then checks with Get-ComputerRestorePoint that a point
// with exactly our description and a higher sequence number now exists, and reports its outcome ONLY as its exit code
// (RESTORE_EXIT below). Nothing is written to any file: there is no result file in a user-writable folder to forge or to
// redirect an elevated write, and "made" is claimed only for the exact exit code 20 of a process we started.
//
// This module reads and changes no Windows setting. The 24-hour creation limit is reported, never worked around.
import path from "node:path";
import { spawn } from "node:child_process";

export const RESTORE_MESSAGES = Object.freeze({
  made: "A system restore point was created and verified.",
  "skipped-24h": "Windows did not create a new restore point because one was already created in the last 24 hours.",
  "needs-admin": "No restore point: administrator approval was not given.",
  disabled: "No restore point: System Restore is turned off on this PC.",
  failed: "No restore point: Windows reported an error.",
});
export const TIMEOUT_MESSAGE = "No restore point: the restore point step timed out.";

const UAC_CANCELLED = 1223; // ERROR_CANCELLED
// Distinct exit codes of the inner (elevated) script. Anything else (0, 1, crashes, a killed process) is "failed".
// "timeout" is never emitted by the scripts: the host reports it when its own clock runs out.
export const RESTORE_EXIT = Object.freeze({ made: 20, skipped24h: 21, disabled: 22, failed: 23, notAdmin: 24, timeout: 25 });
const RUN_ID_RE = /^[0-9a-f]{16}$/;
// C0, DEL, C1 controls and the Unicode line/paragraph separators.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// PowerShell treats all of these as single-quote characters inside a single-quoted string.
const PS_QUOTES_RE = /['\u2018\u2019\u201A\u201B]/g;
const MAX_ENCODED = 30000; // stays below the 32767-char Windows command-line limit

export function encodeCommand(script) {
  if (typeof script !== "string") throw new TypeError("script must be a string");
  return Buffer.from(script, "utf16le").toString("base64");
}

export function psLiteral(s) {
  return "'" + s.replace(PS_QUOTES_RE, q => q + q) + "'";
}

// An absolute local drive path ("C:\..."), no control characters, no forward slashes.
function isLocalAbsolute(p) {
  return typeof p === "string" && p.length > 3 && p.length < 1024 && /^[A-Za-z]:\\/.test(p)
    && !CONTROL_RE.test(p) && !p.includes("/") && path.win32.isAbsolute(p);
}

function checkRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) throw new TypeError("runId must be 16 lowercase hex characters");
}

export function restoreScripts({ runId, psExe } = {}) {
  checkRunId(runId);
  if (!isLocalAbsolute(psExe) || !/\\powershell\.exe$/i.test(psExe)) throw new TypeError("psExe must be an absolute path to powershell.exe");

  const desc = psLiteral("Nuke-Uninstaller " + runId);
  const X = RESTORE_EXIT;
  const inner = [
    "$ErrorActionPreference = 'Stop'",
    `$code = ${X.failed}`,
    "$w = $null",
    "try {",
    "  $before = [long]0",
    "  $pts = @(Get-ComputerRestorePoint -ErrorAction SilentlyContinue)",
    "  if ($pts.Count -gt 0) { $before = [long](($pts | Measure-Object -Property SequenceNumber -Maximum).Maximum) }",
    `  Checkpoint-Computer -Description ${desc} -RestorePointType MODIFY_SETTINGS -WarningVariable w -ErrorAction Stop`,
    `  $mine = @(Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Where-Object { $_.Description -ceq ${desc} -and [long]$_.SequenceNumber -gt $before })`,
    `  if ($mine.Count -gt 0) { $code = ${X.made} }`,
    "} catch {",
    "  $m = [string]$_.Exception.Message",
    `  if ($m -match 'access is denied|requires elevation') { $code = ${X.notAdmin} }`,
    `  elseif ($m -match 'disabled|turned off|polic(y|ies)') { $code = ${X.disabled} }`,
    "}",
    `if ($code -ne ${X.made} -and $w -and (((@($w) | ForEach-Object { [string]$_ }) -join ' ') -match '1440|already been created')) { $code = ${X.skipped24h} }`,
    "exit $code",
  ].join("\r\n");

  const outer = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $p = Start-Process -FilePath ${psLiteral(psExe)} -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',${psLiteral(encodeCommand(inner))} -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
    "  exit [int]$p.ExitCode",
    "} catch {",
    "  $code = 1",
    "  $e = $_.Exception",
    `  while ($e) { if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq ${UAC_CANCELLED}) { $code = ${UAC_CANCELLED} }; $e = $e.InnerException }`,
    `  if ([string]$_.Exception.Message -match 'cancell?ed by the user') { $code = ${UAC_CANCELLED} }`,
    "  exit $code",
    "}",
  ].join("\r\n");

  return { inner, outer };
}

// Exit code -> finer reason (for logs and the controller) and the one of five outcomes. Unknown codes are failures.
const DETAIL_OF_CODE = new Map([
  [RESTORE_EXIT.made, "made"], [RESTORE_EXIT.skipped24h, "skipped-24h"], [RESTORE_EXIT.disabled, "disabled"],
  [RESTORE_EXIT.notAdmin, "not-admin"], [UAC_CANCELLED, "uac-cancelled"],
  // no entry for RESTORE_EXIT.timeout: "timeout" is reported only by the host's own clock, never by a script exit code
  [RESTORE_EXIT.failed, "error"],
]);
const OUTCOME_OF = {
  made: "made", "uac-cancelled": "needs-admin", "not-admin": "needs-admin", "skipped-24h": "skipped-24h",
  disabled: "disabled", timeout: "failed", error: "failed", "no-result": "failed",
};

function detailOf(exitCode) {
  if (typeof exitCode !== "number") return "no-result";
  return DETAIL_OF_CODE.get(exitCode) ?? "error";
}

export function classifyRestore(exitCode) {
  return OUTCOME_OF[detailOf(exitCode)];
}

function finish(outcome, detail) {
  const message = detail === "timeout" ? TIMEOUT_MESSAGE : RESTORE_MESSAGES[outcome];
  return { outcome, message, sequence: null, detail };
}

export async function createRestorePoint({ runId, elevated, spawnFn = spawn, systemRoot = "C:\\Windows", timeoutMs = 600000 } = {}) {
  // Everything is checked before any process starts.
  checkRunId(runId);
  if (typeof systemRoot !== "string" || !/^[A-Za-z]:\\[A-Za-z0-9_ .-]{1,64}$/.test(systemRoot) || /^[A-Za-z]:\\\.+$/.test(systemRoot))
    throw new TypeError("systemRoot must look like C:\\Windows");
  if (typeof elevated !== "boolean") throw new TypeError("elevated must be a boolean");
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
  if (typeof spawnFn !== "function") throw new TypeError("spawnFn must be a function");

  const psExe = systemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const { inner, outer } = restoreScripts({ runId, psExe });
  const encoded = encodeCommand(elevated ? inner : outer);
  if (encoded.length > MAX_ENCODED) return finish("failed", "error");

  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const done = r => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(r); };

    let child;
    try {
      child = spawnFn(psExe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { shell: false, windowsHide: true, stdio: "ignore" });
    } catch { done(finish("failed", "spawn-error")); return; }

    // Hard timeout. Killing the outer process cannot reach an already-elevated child; the outcome is still
    // reported as failed/timed out.
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done(finish("failed", "timeout"));
    }, timeoutMs);

    child.once("error", () => done(finish("failed", "spawn-error")));
    child.once("exit", code => {
      if (settled) return;
      const detail = detailOf(typeof code === "number" ? code : null);
      done(finish(OUTCOME_OF[detail], detail));
    });
  });
}
