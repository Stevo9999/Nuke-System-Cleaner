import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { smartScan, isLocked } from "../lib/smartscan.mjs";
import { LOCATIONS, EXCLUDED } from "../lib/junk-locations.mjs";

const WIN = process.platform === "win32";
const H = 3600 * 1000;
const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
// Files are created "now" (birthtime cannot be back-dated), so the scan clock runs 100h ahead and mtimes are set relative to it.
const NOW = Date.now() + 100 * H;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smartscan-"));
  const LOCALAPPDATA = path.join(root, "Local");
  const APPDATA = path.join(root, "Roaming");
  const temp = path.join(LOCALAPPDATA, "Temp");
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(APPDATA, { recursive: true });
  const env = { LOCALAPPDATA, APPDATA, ProgramData: path.join(root, "PD"), SystemRoot: path.join(root, "Win"), SystemDrive: "C:" };
  return { root, env, temp, LOCALAPPDATA };
}
const age = (p, hours) => { const t = (NOW - hours * H) / 1000; fs.utimesSync(p, t, t); };
const file = (p, hours, body = "x") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); age(p, hours); return p; };
const TEMP = { id: "t", label: "Temporary files", scope: "user", base: "%LOCALAPPDATA%\\Temp", minAgeHours: 24, reason: "Temporary files that programs leave behind." };
const scan = (env, extra = {}) => smartScan({ env, sid: SID, now: NOW, locations: [TEMP], ...extra });
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

test("old file offered high + pre-ticked with category and reason; 23h-old file not offered", async () => {
  const { root, env, temp } = setup();
  try {
    const old = file(path.join(temp, "old.tmp"), 30, "hello");
    const young = file(path.join(temp, "young.tmp"), 23);
    const r = await scan(env);
    assert.equal(r.kind, "smart");
    assert.equal(r.target, null);
    assert.equal(r.partial, false);
    assert.equal(r.items.length, 1);
    const f = r.items[0];
    assert.equal(f.path, old);
    assert.equal(f.kind, "file");
    assert.equal(f.bytes, 5);
    assert.equal(f.group, "exclusive");
    assert.equal(f.confidence, "high");
    assert.equal(f.preTicked, true);
    assert.equal(f.selectable, true);
    assert.equal(f.category, "Temporary files");
    assert.equal(f.reason, TEMP.reason);
    assert.ok(!r.items.some((i) => i.path === young));
    assert.deepEqual(r.allowedRoots, [temp]);
    assert.ok(r.protectedPaths.length > 0);
    assert.ok(r.notes.some((n) => /1 items skipped: in use, newer than 24 hours, links, or not fully checked/.test(n)));
    assert.equal(r.adminExtraBytes, null);
  } finally { rm(root); }
});

test("old folder offered as one dir finding; a folder holding one young file is not", async () => {
  const { root, env, temp } = setup();
  try {
    file(path.join(temp, "okdir", "a.bin"), 30, "abc");
    file(path.join(temp, "okdir", "deep", "b.bin"), 40, "de");
    file(path.join(temp, "mixed", "a.bin"), 30);
    file(path.join(temp, "mixed", "deep", "b.bin"), 2);
    const r = await scan(env);
    assert.deepEqual(r.items.map((i) => [i.kind, path.basename(i.path), i.bytes]), [["dir", "okdir", 5]]);
  } finally { rm(root); }
});

test("locked file and a folder containing one are not offered", { skip: !WIN }, async () => {
  const { root, env, temp } = setup();
  const lockedFile = file(path.join(temp, "locked.tmp"), 30);
  file(path.join(temp, "free.tmp"), 30);
  const inner = file(path.join(temp, "dir", "inner.tmp"), 30);
  file(path.join(temp, "dir", "other.tmp"), 30);
  const procs = [];
  try {
    for (const f of [lockedFile, inner]) {
      const ps = spawn("powershell", ["-NoProfile", "-Command",
        `$h=[IO.File]::Open('${f.replace(/'/g, "''")}','Open','ReadWrite','None'); Write-Host LOCKED; Start-Sleep 60`], { stdio: ["ignore", "pipe", "ignore"] });
      procs.push(ps);
      await new Promise((res, rej) => { ps.stdout.on("data", (d) => String(d).includes("LOCKED") && res()); ps.on("exit", () => rej(new Error("lock helper exited"))); });
    }
    assert.equal(isLocked(lockedFile), true);
    const r = await scan(env);
    assert.deepEqual(r.items.map((i) => path.basename(i.path)), ["free.tmp"]);
  } finally {
    for (const p of procs) await new Promise((res) => { p.once("exit", res); p.kill(); });
    rm(root);
  }
});

test("isLocked: free file false, missing file fails closed", () => {
  const { root, temp } = setup();
  try {
    const f = file(path.join(temp, "a"), 30);
    assert.equal(isLocked(f), false);
    assert.equal(fs.readFileSync(f, "utf8"), "x");
    assert.equal(isLocked(path.join(temp, "missing")), true);
    assert.equal(isLocked(temp), true);
  } finally { rm(root); }
});

function junction(target, link) { fs.symlinkSync(target, link, "junction"); }
function unlinkJunction(link) { try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* gone */ } } }

test("junction child and folder containing a junction are not offered; victim untouched", async () => {
  const { root, env, temp } = setup();
  const victim = path.join(root, "victim");
  file(path.join(victim, "precious.txt"), 500, "keep");
  const j1 = path.join(temp, "jlink");
  const j2 = path.join(temp, "holder", "inner-link");
  file(path.join(temp, "holder", "ok.tmp"), 30);
  file(path.join(temp, "plain.tmp"), 30);
  try {
    junction(victim, j1);
    junction(victim, j2);
    const r = await scan(env);
    assert.deepEqual(r.items.map((i) => path.basename(i.path)), ["plain.tmp"]);
    assert.equal(fs.readFileSync(path.join(victim, "precious.txt"), "utf8"), "keep");
  } finally { unlinkJunction(j1); unlinkJunction(j2); rm(root); }
});

test("budget exceeded: partial, unchecked children not offered", async () => {
  const { root, env, temp } = setup();
  try {
    for (let i = 0; i < 120; i++) file(path.join(temp, "f" + String(i).padStart(3, "0") + ".tmp"), 30);
    const r = await scan(env, { budget: { maxEntries: 50, maxMs: 60000 } });
    assert.equal(r.partial, true);
    assert.ok(r.items.length > 0 && r.items.length <= 50, String(r.items.length));
    assert.ok(r.notes.some((n) => /items skipped/.test(n)));
    const full = await scan(env);
    assert.equal(full.partial, false);
    assert.equal(full.items.length, 120);
  } finally { rm(root); }
});

function iRecord(original) {
  const b = Buffer.alloc(28 + (original.length + 1) * 2);
  b.writeBigInt64LE(2n, 0);
  b.writeBigInt64LE(1234n, 8);
  b.writeUInt32LE(original.length + 1, 24);
  b.write(original + "\0", 28, "utf16le");
  return b;
}
const RB = { id: "rb", label: "Recycle Bin", scope: "user", base: "%LOCALAPPDATA%\\RB", pairing: "recycle", minAgeHours: 24, reason: "Files you already deleted." };

test("recycle pairing: $R finding + $I companion; young $I -> neither offered", async () => {
  const { root, env, LOCALAPPDATA } = setup();
  const rb = path.join(LOCALAPPDATA, "RB");
  try {
    file(path.join(rb, "$IAAAAAA.txt"), 30, iRecord("C:\\Users\\me\\Desktop\\old\u202Enote.txt"));
    file(path.join(rb, "$RAAAAAA.txt"), 1, "payload");   // $R is young: age is measured on $I only
    file(path.join(rb, "$IBBBBBB.txt"), 2, iRecord("C:\\x\\young.txt"));
    file(path.join(rb, "$RBBBBBB.txt"), 90, "zzz");
    file(path.join(rb, "$ICCCCCC"), 30, iRecord("C:\\x\\folder"));
    file(path.join(rb, "$RCCCCCC", "inner.bin"), 5, "123");
    file(path.join(rb, "$RORPHAN.txt"), 90, "orphan");
    file(path.join(rb, "desktop.ini"), 90, "ini");
    const r = await smartScan({ env, sid: SID, now: NOW, locations: [RB] });
    const byName = Object.fromEntries(r.items.map((i) => [path.basename(i.path), i]));
    assert.deepEqual(Object.keys(byName).sort(), ["$IAAAAAA.txt", "$ICCCCCC", "$RAAAAAA.txt", "$RCCCCCC"].sort());
    const R = byName["$RAAAAAA.txt"], I = byName["$IAAAAAA.txt"];
    assert.equal(R.label, "C:\\Users\\me\\Desktop\\old note.txt");
    assert.equal(R.bytes, 7);
    assert.equal(R.companionOf, undefined);
    assert.equal(I.companionOf, R.id);
    assert.ok(R.preTicked && I.preTicked);
    assert.equal(byName["$RCCCCCC"].kind, "dir");
    assert.equal(byName["$RCCCCCC"].label, "C:\\x\\folder");
    assert.equal(byName["$ICCCCCC"].companionOf, byName["$RCCCCCC"].id);
    assert.ok(!("$IBBBBBB.txt" in byName) && !("$RBBBBBB.txt" in byName));
  } finally { rm(root); }
});

test("recycle bin without a SID is not scanned and says so", async () => {
  const { root, env, LOCALAPPDATA } = setup();
  try {
    file(path.join(LOCALAPPDATA, "RB", "$IAAAAAA"), 30, iRecord("C:\\x"));
    const r = await smartScan({ env, sid: undefined, now: NOW, locations: [{ ...RB, base: "%LOCALAPPDATA%\\RB\\%SID%" }] });
    assert.equal(r.items.length, 0);
    assert.ok(r.notes.some((n) => /not scanned/.test(n)));
  } finally { rm(root); }
});

test("system locations are report-only with size or null and feed adminExtraBytes", async () => {
  const { root, env, LOCALAPPDATA } = setup();
  try {
    file(path.join(LOCALAPPDATA, "SysA", "a.bin"), 1, "12345");
    file(path.join(LOCALAPPDATA, "SysA", "sub", "b.bin"), 1, "123");
    file(path.join(LOCALAPPDATA, "SysB", "c.bin"), 1, "1234567");
    const sys = (id, dir, extra = {}) => ({ id, label: id, scope: "system", base: "%LOCALAPPDATA%\\" + dir, minAgeHours: 24, reason: "system place " + id + " report only", ...extra });
    const locations = [sys("a", "SysA", { adminCleanable: true }), sys("b", "SysB"), sys("missing", "Nope", { adminCleanable: true })];
    const r = await smartScan({ env, sid: SID, now: NOW, locations });
    assert.equal(r.items.length, 3);
    for (const i of r.items) { assert.equal(i.group, "report-only"); assert.equal(i.selectable, false); assert.equal(i.preTicked, false); assert.equal(i.confidence, null); }
    assert.deepEqual(r.items.map((i) => i.bytes), [8, 7, null]);
    assert.equal(r.adminExtraBytes, 8);
    assert.deepEqual(r.allowedRoots, []);
    assert.ok(fs.existsSync(path.join(LOCALAPPDATA, "SysA", "a.bin")));
  } finally { rm(root); }
});

test("abort signal rejects with AbortError and returns no partial findings", async () => {
  const { root, env, temp } = setup();
  try {
    file(path.join(temp, "a.tmp"), 30);
    const pre = new AbortController(); pre.abort();
    await assert.rejects(scan(env, { signal: pre.signal }), (e) => e.name === "AbortError");
    const mid = new AbortController();
    await assert.rejects(scan(env, { signal: mid.signal, onProgress: () => mid.abort() }), (e) => e.name === "AbortError");
  } finally { rm(root); }
});

test("onProgress reports locations done over total", async () => {
  const { root, env } = setup();
  try {
    const seen = [];
    await smartScan({ env, sid: SID, now: NOW, locations: [TEMP, { ...TEMP, id: "u", label: "Other" }], onProgress: (p) => seen.push(p) });
    assert.deepEqual(seen.map((p) => p.fraction), [0.5, 1]);
    assert.equal(seen[0].label, "Temporary files");
  } finally { rm(root); }
});

test("R32: a candidate equal to, or containing, a protected root is never offered", async () => {
  const { root, env, temp } = setup();
  try {
    const roaming = path.join(temp, "RoamingInside");
    file(path.join(roaming, "x.tmp"), 30);
    file(path.join(temp, "safe.tmp"), 30);
    // control: protected roots elsewhere -> both offered
    let r = await scan(env);
    assert.deepEqual(r.items.map((i) => path.basename(i.path)).sort(), ["RoamingInside", "safe.tmp"]);
    // APPDATA equals a child of Temp, so the base (and that candidate) contains/equals a protected root: refuse, fail closed
    r = await scan({ ...env, APPDATA: roaming });
    assert.deepEqual(r.items, []);
    r = await scan({ ...env, APPDATA: path.join(roaming, "deeper") });
    assert.deepEqual(r.items, []);
  } finally { rm(root); }
});

test("R32: a base that is itself a protected root yields nothing", async () => {
  const { root, env, temp } = setup();
  try {
    file(path.join(temp, "a.tmp"), 30);
    const r = await smartScan({ env: { ...env, APPDATA: temp }, sid: SID, now: NOW, locations: [TEMP] });
    assert.equal(r.items.length, 0);
    const r2 = await smartScan({ env, sid: SID, now: NOW, locations: [{ ...TEMP, base: "%LOCALAPPDATA%" }] });
    assert.equal(r2.items.length, 0);
  } finally { rm(root); }
});

test("match locations only consider matching files", async () => {
  const { root, env, temp } = setup();
  try {
    const dir = path.join(temp, "CrashDumps");
    file(path.join(dir, "a.dmp"), 30);
    file(path.join(dir, "notes.txt"), 30);
    fs.mkdirSync(path.join(dir, "b.dmp"));
    const r = await smartScan({ env, sid: SID, now: NOW, locations: [{ ...TEMP, base: "%LOCALAPPDATA%\\Temp\\CrashDumps", match: /\.dmp$/ }] });
    assert.deepEqual(r.items.map((i) => path.basename(i.path)), ["a.dmp"]);
  } finally { rm(root); }
});


test("folder age floor: empty young folder, or old folder holding a young subfolder, is not offered; all-old folder is", async () => {
  const { root, env, temp } = setup();
  try {
    fs.mkdirSync(path.join(temp, "emptyyoung")); age(path.join(temp, "emptyyoung"), 2);
    fs.mkdirSync(path.join(temp, "emptyold")); age(path.join(temp, "emptyold"), 30);
    file(path.join(temp, "outer", "a.bin"), 30);
    fs.mkdirSync(path.join(temp, "outer", "younger")); age(path.join(temp, "outer", "younger"), 3);
    age(path.join(temp, "outer"), 30);
    file(path.join(temp, "allold", "sub", "b.bin"), 40, "12");
    age(path.join(temp, "allold", "sub"), 40); age(path.join(temp, "allold"), 40);
    file(path.join(temp, "youngroot", "a.bin"), 30);
    age(path.join(temp, "youngroot"), 1);
    const r = await scan(env);
    assert.deepEqual(r.items.map((i) => path.basename(i.path)).sort(), ["allold", "emptyold"]);
  } finally { rm(root); }
});

test("R37: INetCache\\Content.Outlook is never offered, nor anything containing it; siblings still are", async () => {
  const { root, env, LOCALAPPDATA } = setup();
  try {
    const inet = path.join(LOCALAPPDATA, "Microsoft", "Windows", "INetCache");
    const outlook = path.join(inet, "Content.Outlook");
    file(path.join(outlook, "ABCD1234", "edited.docx"), 90, "only copy");
    file(path.join(inet, "IE", "x.bin"), 90);
    file(path.join(inet, "plain.tmp"), 90);
    const loc = LOCATIONS.find((l) => l.id === "inet-cache");
    let r = await smartScan({ env, sid: SID, now: NOW, locations: [loc] });
    assert.deepEqual(r.items.map((i) => path.basename(i.path)).sort(), ["IE", "plain.tmp"]);
    assert.ok(fs.existsSync(path.join(outlook, "ABCD1234", "edited.docx")));
    // a candidate that merely CONTAINS the excluded folder is refused too
    r = await smartScan({ env, sid: SID, now: NOW, locations: [{ ...loc, base: "%LOCALAPPDATA%\\Microsoft\\Windows" }] });
    assert.ok(!r.items.some((i) => path.basename(i.path) === "INetCache"));
    assert.ok(EXCLUDED.some((x) => /Content\.Outlook$/.test(x.base) && x.reason.length >= 20));
  } finally { rm(root); }
});

test("report-only size is null (not 0) when anything under the folder is unreadable", { skip: !WIN }, async () => {
  const { root, env, LOCALAPPDATA } = setup();
  const locked = path.join(LOCALAPPDATA, "SysU", "denied");
  file(path.join(locked, "a.bin"), 1, "12345");
  file(path.join(LOCALAPPDATA, "SysU", "ok.bin"), 1, "123");
  const who = os.userInfo().username;
  try {
    try { execFileSync("icacls", [locked, "/deny", who + ":(OI)(CI)(RD,S)"], { stdio: "ignore" }); }
    catch { return; }
    let readable = true;
    try { fs.readdirSync(locked); } catch { readable = false; }
    if (!readable) {
      const r = await smartScan({ env, sid: SID, now: NOW, locations: [{ id: "u", label: "u", scope: "system", base: "%LOCALAPPDATA%\\SysU", minAgeHours: 24, adminCleanable: true, reason: "system place report only" }] });
      assert.equal(r.items[0].bytes, null);
      assert.equal(r.adminExtraBytes, 0);
    }
  } finally {
    try { execFileSync("icacls", [locked, "/remove:d", who], { stdio: "ignore" }); } catch { /* best effort */ }
    rm(root);
  }
});

test("a refused base (junction, junction partway up, junction profile folder) says so and is never read", async () => {
  const { root, env, LOCALAPPDATA, temp } = setup();
  const victim = path.join(root, "victim");
  file(path.join(victim, "Cache", "old.bin"), 90, "keep");
  file(path.join(victim, "precious.txt"), 90, "keep");
  const links = [];
  try {
    fs.rmSync(temp, { recursive: true, force: true });
    junction(victim, temp); links.push(temp);
    let r = await scan(env);
    assert.deepEqual(r.items, []);
    assert.ok(r.notes.some((n) => /not scanned/.test(n) && /Temporary files/.test(n)), r.notes.join("|"));

    const mid = path.join(LOCALAPPDATA, "mid");
    junction(victim, mid); links.push(mid);
    r = await smartScan({ env, sid: SID, now: NOW, locations: [{ ...TEMP, base: "%LOCALAPPDATA%\\mid\\Cache" }] });
    assert.deepEqual(r.items, []);
    assert.ok(r.notes.some((n) => /not scanned/.test(n)));

    const prof = path.join(LOCALAPPDATA, "Google", "Chrome", "User Data", "Default");
    fs.mkdirSync(path.dirname(prof), { recursive: true });
    junction(victim, prof); links.push(prof);
    fs.mkdirSync(path.join(path.dirname(prof), "Profile 1", "Cache", "Cache_Data"), { recursive: true });
    file(path.join(path.dirname(prof), "Profile 1", "Cache", "Cache_Data", "f_1"), 90);
    r = await smartScan({ env, sid: SID, now: NOW, locations: [LOCATIONS.find((l) => l.id === "chrome-cache")] });
    assert.deepEqual(r.items.map((i) => path.basename(i.path)), ["f_1"]);
    assert.equal(fs.readFileSync(path.join(victim, "Cache", "old.bin"), "utf8"), "keep");
    assert.equal(fs.readFileSync(path.join(victim, "precious.txt"), "utf8"), "keep");
  } finally { for (const l of links) unlinkJunction(l); rm(root); }
});

test("recycle: a folder-shaped $I record is not trusted; neither half is offered", async () => {
  const { root, env, LOCALAPPDATA } = setup();
  const rb = path.join(LOCALAPPDATA, "RB");
  try {
    file(path.join(rb, "$IDDDDDD", "inner"), 30, "x");
    age(path.join(rb, "$IDDDDDD"), 30);
    file(path.join(rb, "$RDDDDDD"), 90, "payload");
    const r = await smartScan({ env, sid: SID, now: NOW, locations: [RB] });
    assert.deepEqual(r.items, []);
    assert.ok(r.notes.some((n) => /2 items skipped/.test(n)));
  } finally { rm(root); }
});

const importsOf = (src) => [...src.replace(/\/\/.*$/gm, "").matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
function graph(entry, seen = new Map()) {
  if (seen.has(entry)) return seen;
  const specs = importsOf(fs.readFileSync(entry, "utf8"));
  seen.set(entry, specs);
  for (const s of specs) if (s.startsWith(".")) graph(path.resolve(path.dirname(entry), s), seen);
  return seen;
}

test("dry-scan's whole import graph has no run/server/delete module; child_process only inside lib/sysread.mjs", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const g = graph(path.resolve(here, "../scripts/dry-scan.mjs"));
  const files = [...g.keys()].map((f) => path.basename(f));
  for (const bad of ["run.mjs", "server.mjs", "delete.mjs", "delete-internal.mjs", "restore.mjs"]) assert.ok(!files.includes(bad), "graph includes " + bad);
  for (const [f, specs] of g) {
    if (specs.some((s) => /child_process/.test(s))) assert.equal(path.basename(f), "sysread.mjs", f + " imports child_process");
  }
  const gs = graph(path.resolve(here, "../lib/smartscan.mjs"));
  for (const [f, specs] of gs) assert.ok(!specs.some((s) => /child_process/.test(s)) && !/(run|server|delete|delete-internal)\.mjs$/.test(f), f);
});

test("smartscan/junk-locations/dry-scan contain no delete, move, truncate, copy or write calls", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ["../lib/smartscan.mjs", "../lib/junk-locations.mjs", "../scripts/dry-scan.mjs"]) {
    const src = fs.readFileSync(path.join(here, f), "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(!/\b(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|writeFile|writeFileSync|appendFile|appendFileSync|truncate|truncateSync|ftruncate|ftruncateSync|copyFile|copyFileSync|cp|cpSync|writeSync|createWriteStream|mkdir|mkdirSync|symlink|utimes|spawn|exec|execFile|execSync)\s*\(/.test(src), f);
    // the only non-read open is isLocked's "r+" probe, which never writes
    const opens = [...src.matchAll(/openSync\s*\([^)]*\)/g)].map((m) => m[0]);
    for (const o of opens) assert.ok(/["']r\+["']/.test(o) && f.endsWith("smartscan.mjs"), f + " " + o);
    assert.ok(opens.length <= 1, f);
  }
});
