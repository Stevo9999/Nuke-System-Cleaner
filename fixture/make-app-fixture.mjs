// fixture/make-app-fixture.mjs <dir> [sid]
// Builds a fake per-user profile for the Nuke-Uninstaller flow tests and the manual rehearsal:
//   <dir>\Local       (stands in for %LOCALAPPDATA%)   Temp junk, CrashDumps, a per-user program FakeApp and its leftovers
//   <dir>\Roaming     (stands in for %APPDATA%)        FakeApp leftovers, a shared publisher folder, a Start Menu shortcut
//   <dir>\victim      the target of a junction placed inside Local\Temp (must always survive)
//   <dir>\drive\$Recycle.Bin\<sid>   Recycle Bin $I/$R pairs (only reachable when SystemDrive is a drive letter mapped here)
// It never writes outside <dir>. A non-empty <dir> without this builder's marker file is refused.
//
// File ages: Windows cannot back-date a file's creation time from Node, and Smart Scan treats the newer of creation and
// modification time as the age. So after writing, ONE process is started to copy each item's (back-dated) modification
// time into its creation time:
//   %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>
// (argument array, shell:false, only items under <dir>, reparse points skipped). Nothing else is ever started.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MARKER = ".nuke-app-fixture";
const HOUR = 3600 * 1000;
export const FIXTURE_SID = "S-1-5-21-1000000001-1000000002-1000000003-1001";

const psQuote = s => "'" + String(s).replace(/['\u2018\u2019\u201A\u201B]/g, q => q + q) + "'";

// A minimal MS-SHLLINK file: header + LinkInfo with a Unicode local base path (what lib/lnk.mjs reads).
export function buildLnk(target) {
  const header = Buffer.alloc(0x4c);
  header.writeUInt32LE(0x4c, 0);
  Buffer.from("0114020000000000c000000000000046", "hex").copy(header, 4);
  header.writeUInt32LE(0x02 | 0x80, 20); // HasLinkInfo | IsUnicode
  const uni = Buffer.from(target + "\0", "utf16le");
  const uniSuffix = Buffer.from("\0", "utf16le");
  const ansi = Buffer.from(target.replace(/[^\x20-\x7e]/g, "_") + "\0", "latin1");
  const hdr = 0x24;
  const oUni = hdr, oUniSuffix = oUni + uni.length, oAnsi = oUniSuffix + uniSuffix.length, oAnsiSuffix = oAnsi + ansi.length;
  const size = oAnsiSuffix + 1;
  const li = Buffer.alloc(size);
  li.writeUInt32LE(size, 0);
  li.writeUInt32LE(hdr, 4);
  li.writeUInt32LE(1, 8);              // VolumeIDAndLocalBasePath
  li.writeUInt32LE(0, 0x0c);           // no VolumeID (never read)
  li.writeUInt32LE(oAnsi, 0x10);       // LocalBasePathOffset (ANSI)
  li.writeUInt32LE(0, 0x14);           // no network link
  li.writeUInt32LE(oAnsiSuffix, 0x18); // CommonPathSuffixOffset (ANSI, empty)
  li.writeUInt32LE(oUni, 0x1c);        // LocalBasePathOffsetUnicode
  li.writeUInt32LE(oUniSuffix, 0x20);  // CommonPathSuffixOffsetUnicode
  uni.copy(li, oUni); uniSuffix.copy(li, oUniSuffix); ansi.copy(li, oAnsi);
  return Buffer.concat([header, li]);
}

function removeTree(dir) {
  // Junctions first (unlink, then rmdir as a fallback), so nothing outside <dir> is ever followed.
  const walk = d => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      let st; try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* left */ } } }
      else if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function makeAppFixture(dirArg, { sid = FIXTURE_SID, now = Date.now(), setCreationTimes = true } = {}) {
  if (typeof dirArg !== "string" || !dirArg) throw new Error("usage: node fixture/make-app-fixture.mjs <dir> [sid]");
  const dir = path.resolve(dirArg);
  if (path.parse(dir).root === dir) throw new Error("refusing a drive root");
  if (!/^S-1-5-21(-\d+){4}$/.test(sid)) throw new Error("sid must look like S-1-5-21-a-b-c-d");
  let existing = [];
  try { existing = fs.readdirSync(dir); } catch { existing = []; }
  if (existing.length && !existing.includes(MARKER)) throw new Error("refusing: " + dir + " is not empty and was not made by this builder");
  if (existing.length) removeTree(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MARKER), "made by fixture/make-app-fixture.mjs\n");

  const at = (...p) => path.join(dir, ...p);
  const aged = []; // [path, ageMs] applied deepest-first after everything is written
  const write = (f, text, ageMs) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    if (ageMs !== undefined) aged.push([f, ageMs]);
    return f;
  };
  const mkdir = (d, ageMs) => { fs.mkdirSync(d, { recursive: true }); if (ageMs !== undefined) aged.push([d, ageMs]); return d; };
  const OLD = 72 * HOUR;
  const notes = [];

  // Smart Scan: Local\Temp
  const temp = mkdir(at("Local", "Temp"), OLD);
  const oldFiles = [write(at("Local", "Temp", "old-a.tmp"), "a".repeat(4096), OLD), write(at("Local", "Temp", "old-b.log"), "b".repeat(2048), OLD)];
  const oldDir = mkdir(at("Local", "Temp", "old-dir"), OLD);
  write(at("Local", "Temp", "old-dir", "inner.txt"), "inner", OLD);
  const youngFile = write(at("Local", "Temp", "young-1h.tmp"), "young", 1 * HOUR);
  const youngDir = mkdir(at("Local", "Temp", "young-dir"), OLD);
  write(at("Local", "Temp", "young-dir", "fresh.txt"), "fresh"); // created now: the folder holds a young file
  const hostile = [];
  for (const name of ["caf\u00e9-\u65e5\u672c.tmp", "evil\u202Etxt.exe", "zero\u200bwidth.tmp", "line\nbreak.tmp"]) {
    try { hostile.push(write(at("Local", "Temp", name), "h", OLD)); } catch { notes.push("could not create a file named " + JSON.stringify(name) + " on this file system"); }
  }
  const victim = mkdir(at("victim"), OLD);
  const precious = write(at("victim", "precious.txt"), "DO NOT DELETE ME", OLD);
  const junction = at("Local", "Temp", "link-to-victim");
  let junctionCreated = false;
  try { fs.symlinkSync(victim, junction, "junction"); junctionCreated = true; } catch { notes.push("could not create the junction in Local\\Temp"); }
  mkdir(at("Local", "CrashDumps"), OLD);
  const dump = write(at("Local", "CrashDumps", "x.dmp"), "dump".repeat(256), OLD);

  // Investigate: a per-user program and its leftovers
  const appDir = mkdir(at("Local", "Programs", "FakeApp"), OLD);
  const exe = write(at("Local", "Programs", "FakeApp", "fake.exe"), "MZ fake", OLD);
  write(at("Local", "Programs", "FakeApp", "data.bin"), "d".repeat(1000), OLD);
  const localLeft = mkdir(at("Local", "FakeApp"), OLD);
  write(at("Local", "FakeApp", "cache.bin"), "c".repeat(500), OLD);
  const roamingLeft = mkdir(at("Roaming", "FakeApp"), OLD);
  write(at("Roaming", "FakeApp", "settings.ini"), "[x]", OLD);
  const publisher = mkdir(at("Roaming", "FakePub"), OLD);
  const publisherProduct = mkdir(at("Roaming", "FakePub", "FakeApp"), OLD);
  write(at("Roaming", "FakePub", "FakeApp", "x.cfg"), "x", OLD);
  const publisherOther = mkdir(at("Roaming", "FakePub", "OtherTool"), OLD);
  write(at("Roaming", "FakePub", "OtherTool", "y.cfg"), "y", OLD);
  const startMenu = at("Roaming", "Microsoft", "Windows", "Start Menu", "Programs");
  fs.mkdirSync(startMenu, { recursive: true });
  const shortcut = at("Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "FakeApp.lnk");
  fs.writeFileSync(shortcut, buildLnk(exe));
  aged.push([shortcut, OLD]);
  mkdir(at("Documents"), OLD);
  write(at("Documents", "my-letter.txt"), "personal", OLD);

  // Recycle Bin pairs (only scanned when SystemDrive is a real drive letter mapped onto <dir>\drive)
  const rb = mkdir(at("drive", "$Recycle.Bin", sid), OLD);
  const rbI = at("drive", "$Recycle.Bin", sid, "$IABC123.txt");
  const orig = "C:\\Users\\someone\\old-note.txt";
  const ib = Buffer.alloc(28 + (orig.length + 1) * 2);
  ib.writeBigInt64LE(2n, 0); ib.writeBigInt64LE(5n, 8); ib.writeBigInt64LE(0n, 16); ib.writeUInt32LE(orig.length + 1, 24);
  ib.write(orig, 28, "utf16le");
  fs.writeFileSync(rbI, ib); aged.push([rbI, OLD]);
  const rbR = write(at("drive", "$Recycle.Bin", sid, "$RABC123.txt"), "old note", OLD);

  // Back-date modification times (deepest first, so writing a child never refreshes an already-dated parent).
  aged.sort((a, b) => b[0].length - a[0].length);
  for (const [p, age] of aged) { const t = new Date(now - age); try { fs.utimesSync(p, t, t); } catch { notes.push("could not back-date " + p); } }
  let creationTimesSet = false;
  if (setCreationTimes && process.platform === "win32") creationTimesSet = copyMtimeToCreation(dir, notes);

  const env = { LOCALAPPDATA: at("Local"), APPDATA: at("Roaming"), USERPROFILE: dir, SystemDrive: at("drive"),
    ProgramData: at("ProgramData"), SystemRoot: process.env.SystemRoot || "C:\\Windows" };
  return {
    dir, sid, env, notes, junctionCreated, creationTimesSet,
    paths: { temp, oldFiles, oldDir, youngFile, youngDir, hostile, junction, victim, precious, dump, appDir, exe, localLeft, roamingLeft,
      publisher, publisherProduct, publisherOther, shortcut, rb, rbI, rbR, documents: at("Documents") },
  };
}

// The one process this builder starts (see the header). Returns true when PowerShell reported success.
function copyMtimeToCreation(dir, notes) {
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const ps = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(ps)) { notes.push("powershell.exe not found: creation times not back-dated"); return false; }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$root = ${psQuote(dir)}`,
    // Manual walk: a reparse point (junction, symlink) is neither touched nor entered.
    "function Walk([string]$p) {",
    "  foreach ($c in @(Get-ChildItem -LiteralPath $p -Force)) {",
    "    if ($c.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }",
    "    $c.CreationTime = $c.LastWriteTime",
    "    if ($c.PSIsContainer) { Walk $c.FullName }",
    "  }",
    "}",
    "$r = Get-Item -LiteralPath $root -Force",
    "$r.CreationTime = $r.LastWriteTime",
    "Walk $root",
    "Write-Output 'OK'",
  ].join("\r\n");
  const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { shell: false, windowsHide: true, encoding: "utf8", timeout: 60000 });
  const ok = r.status === 0 && /OK/.test(r.stdout || "");
  if (!ok) notes.push("creation times could not be back-dated; Smart Scan will treat the fixture files as new");
  return ok;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const fx = makeAppFixture(process.argv[2], process.argv[3] ? { sid: process.argv[3] } : {});
    console.log("Fixture built in " + fx.dir);
    for (const n of fx.notes) console.log("note: " + n);
    console.log("\nStart the app with this environment (PowerShell):");
    for (const k of ["LOCALAPPDATA", "APPDATA", "USERPROFILE", "SystemDrive"]) console.log(`$env:${k} = ${psQuote(fx.env[k])}`);
    console.log("\nSystemDrive is deliberately NOT a drive letter, so the real Recycle Bin is never scanned (the app notes it as not scanned).");
    console.log("To exercise the fixture Recycle Bin, build with your own SID as the second argument, map a spare drive letter onto");
    console.log(fx.env.SystemDrive + " (for example with subst) and set SystemDrive to that letter instead.");
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
