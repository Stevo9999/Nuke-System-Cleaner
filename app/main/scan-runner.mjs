// app/main/scan-runner.mjs
// Runs a scan in a worker thread so the window stays responsive and Cancel can stop it at once (worker.terminate()).
// Only a fixed, sanitised set of arguments ever reaches the worker (scanArgs): never `locations`, budgets or clocks.
import { Worker } from "node:worker_threads";
import path from "node:path";

const WORKER_URL = new URL("./scan-worker.mjs", import.meta.url);
const SID_USER = /^S-1-5-21(-\d+){4}$/;
const ENV_KEYS = ["LOCALAPPDATA", "APPDATA", "USERPROFILE", "SystemRoot", "SystemDrive", "ProgramData", "ProgramFiles",
  "ProgramFiles(x86)", "ProgramW6432", "windir", "OneDrive", "OneDriveCommercial", "OneDriveConsumer"];
const MAX_TEXT = 4096;
const okText = v => typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT && !v.includes("\0");
const okAbs = v => okText(v) && path.isAbsolute(v);

function cleanEnv(env) {
  const out = {};
  if (!env || typeof env !== "object") return out;
  for (const k of ENV_KEYS) {
    const d = Object.getOwnPropertyDescriptor(env, k);
    if (d && Object.hasOwn(d, "value") && okText(d.value)) out[k] = d.value;
  }
  return out;
}

// The only arguments a scan accepts. Unknown keys are dropped; a bad target throws (nothing starts).
//   smart:       { sid: "S-1-5-21-..." | null, elevated?: true, protectedPaths?: string[], env? }
//   browsers:    { protectedPaths?: string[], env? }   (the fixed browser table lives in lib/browsers.mjs; nothing else is accepted)
//   investigate: { target: string, protectedPaths?: string[], home?: absolute string, env? }
// env (only the listed keys) is for tests; the app passes none and the worker uses its own process environment.
export function scanArgs(kind, args) {
  const a = args && typeof args === "object" ? args : {};
  const out = {};
  if (kind === "smart") {
    out.sid = typeof a.sid === "string" && SID_USER.test(a.sid) ? a.sid : null;
    if (a.elevated === true) out.elevated = true; // Phase 1b: strict true only (from the controller's identity)
    if (Array.isArray(a.protectedPaths)) out.protectedPaths = a.protectedPaths.filter(okAbs); // folders the user excluded
  } else if (kind === "browsers") {
    if (Array.isArray(a.protectedPaths)) out.protectedPaths = a.protectedPaths.filter(okAbs);
  } else if (kind === "startup") {
    // no arguments: the fixed Run / RunOnce keys and Startup folders are read-only listed
  } else if (kind === "investigate") {
    if (!okText(a.target)) throw new Error("bad scan target");
    out.target = a.target;
    if (Array.isArray(a.protectedPaths)) out.protectedPaths = a.protectedPaths.filter(okAbs);
    if (okAbs(a.home)) out.home = a.home;
  } else {
    throw new Error("unknown scan kind");
  }
  if (a.env !== undefined) out.env = cleanEnv(a.env);
  return out;
}

function abortError() {
  const e = new Error("The scan was cancelled");
  e.name = "AbortError";
  e.code = "ABORT_ERR";
  return e;
}

export function runScan(kind, args, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    let clean;
    try { clean = scanArgs(kind, args); } catch (e) { reject(e); return; }
    if (signal && signal.aborted) { reject(abortError()); return; }
    let settled = false;
    let worker;
    const finish = (ok, v) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      try { worker.terminate(); } catch { /* already gone */ }
      if (ok) resolve(v); else reject(v);
    };
    const onAbort = () => finish(false, abortError());
    try {
      worker = new Worker(WORKER_URL, { workerData: { kind, args: clean } });
    } catch { reject(new Error("the scan could not be started")); return; }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    worker.on("message", m => {
      if (settled || !m || typeof m !== "object") return;
      if (m.type === "progress") {
        const fraction = typeof m.fraction === "number" && Number.isFinite(m.fraction) ? Math.min(1, Math.max(0, m.fraction)) : null;
        const label = typeof m.label === "string" ? m.label : "";
        try { if (typeof onProgress === "function") onProgress({ fraction, label }); } catch { /* progress is best effort */ }
      } else if (m.type === "result") {
        finish(true, m.result);
      } else if (m.type === "error") {
        finish(false, new Error("the scan failed"));
      }
    });
    worker.on("error", () => finish(false, new Error("the scan failed")));
    worker.on("exit", () => finish(false, new Error("the scan stopped unexpectedly")));
  });
}
