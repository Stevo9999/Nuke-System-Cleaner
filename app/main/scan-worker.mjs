// app/main/scan-worker.mjs
// Worker thread body: one scan, then exit. READ-ONLY. Process starts happen only inside the read-only readers it calls:
// reg.exe query (fixed keys) and schtasks.exe /query (investigate only), via lib/sysread.mjs. Nothing here deletes.
// Messages to the parent: { type: "progress", fraction, label } ... then { type: "result", result } or { type: "error" }.
// The error message never carries details (they could contain paths).
import { parentPort, workerData } from "node:worker_threads";
import { smartScan } from "../../lib/smartscan.mjs";
import { BROWSER_LOCATIONS, BROWSER_FORBIDDEN, CLOSE_BROWSERS_NOTE } from "../../lib/browsers.mjs";
import { investigate } from "../../lib/investigate.mjs";
import { listStartupItems } from "../../lib/startup.mjs";
import { regQuery, listScheduledTasks } from "../../lib/sysread.mjs";
import { readLnk } from "../../lib/lnk.mjs";
import { makeFinding } from "../../lib/confidence.mjs";
import { scanArgs } from "./scan-runner.mjs";

const post = m => { try { parentPort.postMessage(m); } catch { /* parent gone */ } };
const progress = (fraction, label) => post({ type: "progress", fraction, label: String(label ?? "").slice(0, 200) });

// Startup items are shown for review only. Re-made through makeFinding so the group can only ever be report-only.
async function startupFindings(env) {
  const found = await listStartupItems({ regQuery, env, readLnk });
  const items = [];
  for (const s of found) {
    if (!s || typeof s.id !== "string") continue;
    items.push(makeFinding({ kind: "startup", path: typeof s.path === "string" ? s.path : null, label: String(s.label ?? ""),
      idKey: "startup-id:" + s.id, reason: String(s.reason ?? ""), category: "startup" }));
  }
  return { items, notes: Array.isArray(found.notes) ? found.notes.map(String) : [] };
}

async function main() {
  const { kind } = workerData || {};
  const args = scanArgs(kind, workerData && workerData.args);
  const env = args.env || process.env;
  if (kind === "smart") {
    const r = await smartScan({ env, sid: args.sid ?? undefined, elevated: args.elevated === true, extraProtected: args.protectedPaths || [],
      onProgress: p => progress(p && p.fraction, p && p.label) });
    return r;
  }
  if (kind === "browsers") {
    // Same read-only engine, the fixed browser table and its own never-touch list; the table is never taken from the caller.
    return smartScan({ env, locations: BROWSER_LOCATIONS, excluded: BROWSER_FORBIDDEN, resultKind: "browsers", lockedNote: CLOSE_BROWSERS_NOTE,
      extraProtected: args.protectedPaths || [], onProgress: p => progress(p && p.fraction, p && p.label) });
  }
  if (kind === "startup") {
    progress(null, "Reading start-up programs");
    const su = await startupFindings(env);
    return { kind: "startup", items: su.items, notes: su.notes };
  }
  return investigate(args.target, {
    regQuery, listScheduledTasks, readLnk, env, ...(args.home ? { home: args.home } : {}), protectedPaths: args.protectedPaths || [],
    onProgress: m => progress(null, m),
  });
}

if (parentPort) {
  main().then(result => post({ type: "result", result }), () => post({ type: "error" }));
}
