// lib/uninstall-run.mjs: runs ONE program's own uninstaller (already parsed by lib/programs.mjs) as the normal user.
//
// The only process this module starts is
//   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>
// with an argument array and shell:false (the same pattern as lib/restore.mjs). The fixed script (uninstallScript below)
// runs Start-Process on the program the user confirmed and waits for it. Why not spawn the exe directly: child_process.spawn
// cannot start an exe whose manifest requires administrator (EACCES / ERROR_ELEVATION_REQUIRED). Start-Process without -Verb
// uses ShellExecute, so such an uninstaller gets the normal Windows UAC prompt. This module never asks for elevation itself
// (no -Verb RunAs): whether a prompt appears is Windows' decision for that program.
//
// The exe and the argument text are exactly the values already validated here (absolute local drive path, .exe, no control
// characters, no wildcard characters) and are placed in the script only as single-quoted PowerShell literals (psLiteral).
// The argument text goes in as ONE string: Start-Process joins -ArgumentList strings as the command-line tail, so the
// uninstaller receives it verbatim (uninstallers expect their own quoting).
//
// Exit code: the uninstaller's own exit code is returned as { ok: true, code } (3010 / 1641 stay meaningful: restart needed).
// Failure to start the program makes the script exit 9009 (START_FAILED), mapped to { ok: false, reason: "could not start" }.
// A real uninstaller that exits with exactly 9009 is vanishingly unlikely; a plain 1 is NOT treated as a failure to start.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { encodeCommand, psLiteral } from "./restore.mjs";

export const START_FAILED = 9009;
// Start-Process -FilePath is a wildcard pattern: [ ] * ? (and the backtick escape) are refused before anything starts.
const WILDCARD_RE = /[\[\]*?`]/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function uninstallScript(exe, args) {
  const list = args ? " -ArgumentList " + psLiteral(args) : "";
  return `$ErrorActionPreference='Stop'; try { $p = Start-Process -FilePath ${psLiteral(exe)}${list} -Wait -PassThru; exit [int]$p.ExitCode } catch { exit ${START_FAILED} }`;
}

export function runUninstaller({ exe, args, spawnFn = spawn, timeoutMs = 30 * 60 * 1000, exists = existsSync, signal = null, systemRoot = "C:\\Windows" } = {}) {
  if (typeof exe !== "string" || !/^[A-Za-z]:\\/.test(exe) || !/\.exe$/i.test(exe) || exe.includes("/") || exe.length > 1024 || CONTROL_RE.test(exe) || WILDCARD_RE.test(exe)) return Promise.resolve({ ok: false, reason: "bad program" });
  if (typeof args !== "string" || args.length > 2000 || /[\u0000-\u001f]/.test(args)) return Promise.resolve({ ok: false, reason: "bad arguments" });
  if (!exists(exe)) return Promise.resolve({ ok: false, reason: "missing" });
  if (signal && signal.aborted) return Promise.resolve({ ok: false, reason: "stopped" });
  const psExe = systemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const encoded = encodeCommand(uninstallScript(exe, args));
  return new Promise(resolve => {
    let done = false;
    let timer = null;
    let child = null;
    // Ending the wait never kills anything: the uninstaller may be half way through removing the program. The waiting
    // PowerShell helper is only detached from our event loop, not killed.
    const finish = r => { if (done) return; done = true; if (timer) clearTimeout(timer); if (r.ok === false && r.reason !== "could not start") { try { child && child.unref && child.unref(); } catch { /* gone */ } } resolve(r); };
    try {
      child = spawnFn(psExe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { shell: false, windowsHide: true, stdio: "ignore" });
    } catch { finish({ ok: false, reason: "could not start" }); return; }
    timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    if (signal) signal.addEventListener("abort", () => finish({ ok: false, reason: "stopped" }), { once: true });
    child.once("error", () => finish({ ok: false, reason: "could not start" }));
    child.once("exit", code => {
      if (typeof code !== "number") finish({ ok: true, code: null });
      else if (code === START_FAILED) finish({ ok: false, reason: "could not start" });
      else finish({ ok: true, code });
    });
  });
}
