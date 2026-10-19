// scripts/dry-scan.mjs: read-only Smart Scan summary in the terminal. Nothing here deletes or writes anything.
// Usage: node scripts/dry-scan.mjs [--sid S-1-5-21-...]   (the SID is only needed to include your Recycle Bin)
// Process starts: only reg.exe queries on fixed Run keys, made by listStartupItems through lib/sysread.mjs.
import { smartScan, cleanText } from "../lib/smartscan.mjs";
import { listStartupItems } from "../lib/startup.mjs";
import { regQuery } from "../lib/sysread.mjs";

// Untrusted text: control/format/line-separator characters replaced, capped, JSON-quoted (same contract as run.mjs clean()).
const clean = (s, max = 300) => JSON.stringify(cleanText(s, max));

const fmt = (b) => {
  if (b === null || b === undefined) return "unknown";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${i === 0 || b >= 100 ? b.toFixed(0) : b.toFixed(1)} ${u[i]}`;
};

const args = process.argv.slice(2);
let sid;
const si = args.indexOf("--sid");
if (si !== -1) {
  sid = args[si + 1];
  if (!/^S-1-\d+(-\d+){1,15}$/.test(sid || "")) { console.error("--sid needs a SID like S-1-5-21-..."); process.exit(2); }
}

const res = await smartScan({ sid });
console.log("Smart Scan (read-only dry run)" + (res.partial ? " - PARTIAL" : ""));

const user = new Map();
const report = [];
for (const f of res.items) {
  if (f.group === "report-only") { report.push(f); continue; }
  const row = user.get(f.category) || { count: 0, bytes: 0 };
  row.count++;
  row.bytes += f.bytes ?? 0;
  user.set(f.category, row);
}
console.log("\nYour cleanable locations:");
if (user.size === 0) console.log("  (nothing offered)");
for (const [cat, row] of user) console.log(`  ${clean(cat, 60)}: ${row.count} items, ${fmt(row.bytes)}`);

console.log("\nSkipped:");
if (res.notes.length === 0) console.log("  (none)");
for (const n of res.notes) console.log("  " + clean(n, 200));

console.log("\nSystem locations (report only, never touched):");
for (const f of report) console.log(`  ${clean(f.category, 60)}: ${fmt(f.bytes)}  ${clean(f.path, 200)}`);
console.log(`  Extra an administrator run could clear: ${fmt(res.adminExtraBytes)}`);

console.log("\nStartup items (report only):");
try {
  const startup = await listStartupItems({ regQuery });
  if (startup.length === 0) console.log("  (none found)");
  for (const s of startup) console.log("  " + clean(s.label, 160));
  for (const n of startup.notes || []) console.log("  note: " + clean(n, 200));
} catch (e) {
  console.log("  could not be read: " + clean(e && e.message, 120));
}
