// scripts/bench-stall.mjs: synthetic benchmark for event-loop stalls in the main process during a big delete.
// Builds a temp fixture tree of OLD files (nothing outside os.tmpdir() is touched), runs the real controller delete flow
// (choose -> buildSelection -> revalidate -> age/lock loop -> startFrozenRun -> one-shot server -> removeItem) with a fake UI,
// a fake restore point and fake scan result, and reports the largest event-loop stall per stage.
//   node scripts/bench-stall.mjs [itemCount=4000]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createController } from "../app/main/controller.mjs";
import { saveExclusions } from "../app/main/appdata.mjs";

const N = Number(process.argv[2]) || 4000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-bench-"));
const dataRoot = path.join(root, "appdata");
const junk = path.join(root, "junk");
const other = path.join(root, "excluded-folder");
fs.mkdirSync(dataRoot, { recursive: true }); fs.mkdirSync(other, { recursive: true });
const old = new Date(Date.now() - 10 * 86400e3);
const items = [];
const dirs = Math.ceil(N / 100);
for (let d = 0; d < dirs; d++) {
  const dir = path.join(junk, "cache" + d);
  fs.mkdirSync(dir, { recursive: true });
  for (let k = 0; k < 100 && items.length < N; k++) {
    const p = path.join(dir, "f" + k + ".tmp");
    fs.writeFileSync(p, "x".repeat(64));
    fs.utimesSync(p, old, old);
    items.push({ id: crypto.createHash("sha1").update(p).digest("hex").slice(0, 16), kind: "file", path: p, group: "exclusive", confidence: "high",
      selectable: true, sharedWith: [], bytes: 64, label: p, category: "Temporary files" });
  }
  fs.utimesSync(dir, old, old);
}
fs.utimesSync(junk, old, old);
const settingsFile = path.join(dataRoot, "settings.json");
saveExclusions(settingsFile, [other]);

let stage = "start";
const stalls = new Map();
let lastTick = performance.now();
const probe = setInterval(() => {
  const now = performance.now();
  const lag = now - lastTick - 5;
  lastTick = now;
  if (lag > (stalls.get(stage) || 0)) stalls.set(stage, lag);
}, 5);
const mark = s => { stage = s; };
const marks = [];

const ui = {
  sendPhase: p => { marks.push([Math.round(performance.now()), p.phase, p.detail || ""]); mark("phase:" + p.phase); },
  sendProgress: () => {}, showResults: () => {}, closeResults: () => {},
  confirmPermanent: async () => true, askContinueWithoutRestore: async () => false,
  openRitual: url => { ritualUrl = url; return { close() {}, onClosed() {} }; },
};
let ritualUrl = null;
const result = { items, allowedRoots: [root], protectedPaths: [], kind: "smart" };
const ctrl = createController({
  ui, paths: { settingsFile, runDir: path.join(root, "run") }, identity: { elevated: false, sid: null },
  runScan: async () => result, restore: async () => ({ outcome: "made" }), pollMs: 20,
});

function post(url, route) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: u.port, path: route, method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:" + u.port, "x-nuke-token": u.searchParams.get("t"), "content-length": 2 } },
    res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end("{}");
  });
}

mark("scan results");
const t0 = performance.now();
await ctrl.scanSmart();
const scanMs = performance.now() - t0;
mark("choose+delete");
const tDel = performance.now();
const del = ctrl.delete({ ids: items.map(i => i.id) });
while (!ritualUrl) await new Promise(r => setTimeout(r, 10));
const prepMs = performance.now() - tDel;
mark("unlock wait");
await post(ritualUrl, "/unlock");
await new Promise(r => setTimeout(r, 2200));
mark("server deleting");
const tRun = performance.now();
await post(ritualUrl, "/confirm");
const out = await del;
const runMs = performance.now() - tRun;
clearInterval(probe);
const left = fs.readdirSync(junk).reduce((n, d) => n + fs.readdirSync(path.join(junk, d)).length, 0);
console.log(JSON.stringify({ items: N, scanMs: Math.round(scanMs), prepareBeforeRitualMs: Math.round(prepMs), deleteRunMs: Math.round(runMs), ok: out.ok, deleted: out.deleted, filesLeft: left }));
console.log("max event-loop stall per stage (ms):");
let max = 0;
for (const [s, v] of stalls) { console.log("  " + s.padEnd(22) + Math.round(v)); max = Math.max(max, v); }
console.log("MAX_STALL_MS=" + Math.round(max));
fs.rmSync(root, { recursive: true, force: true });
