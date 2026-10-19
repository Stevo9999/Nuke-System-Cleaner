// lib/uninstall-run.mjs: runs ONE program's own uninstaller (already parsed by lib/programs.mjs) as the normal user.
// The only process this module starts is that exe: absolute path, shell:false. The argument text is passed through unchanged
// (windowsVerbatimArguments) because uninstallers expect their own quoting. Waits for exit; a timeout reports failure.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export function runUninstaller({ exe, args, spawnFn = spawn, timeoutMs = 30 * 60 * 1000, exists = existsSync, signal = null } = {}) {
  if (typeof exe !== "string" || !/^[A-Za-z]:\\/.test(exe) || !/\.exe$/i.test(exe) || exe.includes("/")) return Promise.resolve({ ok: false, reason: "bad program" });
  if (typeof args !== "string" || args.length > 2000 || /[\u0000-\u001f]/.test(args)) return Promise.resolve({ ok: false, reason: "bad arguments" });
  if (!exists(exe)) return Promise.resolve({ ok: false, reason: "missing" });
  if (signal && signal.aborted) return Promise.resolve({ ok: false, reason: "stopped" });
  return new Promise(resolve => {
    let done = false;
    let timer = null;
    const finish = r => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); };
    let child;
    try {
      child = spawnFn(exe, args ? [args] : [], { shell: false, windowsHide: false, windowsVerbatimArguments: true, stdio: "ignore" });
    } catch { finish({ ok: false, reason: "could not start" }); return; }
    timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, reason: "timeout" }); }, timeoutMs);
    // "Stop waiting": only the waiting ends. The uninstaller is NOT killed (it may be half way through removing the program).
    if (signal) signal.addEventListener("abort", () => finish({ ok: false, reason: "stopped" }), { once: true });
    child.once("error",() => finish({ ok: false, reason: "could not start" }));
    child.once("exit", code => finish({ ok: true, code: typeof code === "number" ? code : null }));
  });
}
