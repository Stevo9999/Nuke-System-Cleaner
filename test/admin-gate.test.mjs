// test/admin-gate.test.mjs
// Phase 1b: the administrator content exception in checkPath. Probes on real system paths are
// read-only (the probe names do not exist and nothing is created there). Everything that needs
// real files, junctions or deletions uses temp-folder stand-ins through adminGateForTests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkPath, adminContentDirs, adminGateForTests } from "../lib/safepath.mjs";
import { removeItem } from "../lib/delete.mjs";
import { createCleanupServer, selectionHash } from "../server.mjs";

const WIN = process.platform === "win32";
const skip = !WIN;
const here = path.dirname(fileURLToPath(import.meta.url));
const rnd = () => crypto.randomBytes(6).toString("hex");

// ---- read-only probes on the real system folders ----
const T = "C:\\Windows\\Temp\\nuke-probe-" + rnd();   // does not exist
const opts = a => ({ allowedRoots: ["C:\\Windows\\Temp"], adminContents: a });

test("adminContentDirs returns exactly the four fixed folders", { skip }, () => {
  assert.deepEqual(adminContentDirs(), ["C:\\Windows\\Temp", "C:\\Windows\\Minidump",
    "C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive", "C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportQueue"]);
});
test("adminContentDirs returns a fresh array each call (callers cannot widen it)", { skip }, () => {
  const a = adminContentDirs(); a.push("C:\\Windows\\System32");
  assert.equal(adminContentDirs().length, 4);
  assert.equal(checkPath("C:\\Windows\\System32\\nuke-probe-" + rnd(), { allowedRoots: ["C:\\Windows\\System32"], adminContents: true }).reason, "system folder");
});
test("without the flag a path inside Windows\\Temp is a system folder", { skip }, () => {
  assert.equal(checkPath(T, opts(false)).reason, "system folder");
  assert.equal(checkPath(T, { allowedRoots: ["C:\\Windows\\Temp"] }).reason, "system folder");
});
test("with the flag the system refusal is lifted only there (reason becomes 'does not exist')", { skip }, () => {
  assert.equal(checkPath(T, opts(true)).reason, "does not exist");
  for (const d of adminContentDirs()) {
    const p = d + "\\nuke-probe-" + rnd();
    // Not elevated, some folders answer EPERM instead of ENOENT for a missing child (Minidump, ReportArchive).
    let readable = false;
    try { fs.realpathSync.native(d); try { fs.realpathSync.native(p); } catch (e) { readable = e.code === "ENOENT"; } } catch { readable = false; }
    const r = checkPath(p, { allowedRoots: [d], adminContents: true });
    if (readable) assert.equal(r.reason, "does not exist", p); else assert.equal(r.ok, false, p); // unreadable: fails closed
    assert.equal(checkPath(p, { allowedRoots: [d] }).reason, "system folder", p);
  }
});
test("the flag must be boolean true", { skip }, () => {
  for (const v of ["true", 1, {}, [true], new Boolean(true), "yes", null]) assert.equal(checkPath(T, opts(v)).reason, "system folder", String(v));
});
test("adversarial: the folder itself, a prefix twin, a parent segment, other system folders, ADS, trailing dot", { skip }, () => {
  for (const p of ["C:\\Windows\\Temp", "C:\\Windows\\Temp\\", "C:\\Windows\\TempX\\a", "C:\\Windows\\Temp2\\a", "C:\\Windows\\Temp" + ".\\a",
                   "C:\\Windows\\Temp\\" + ".." + "\\System32\\a", "C:\\Windows\\Temp\\a\\" + ".." + "\\" + ".." + "\\System32",
                   "C:\\Windows\\System32\\a", "C:\\Windows\\a", "C:\\Windows", "C:\\Windows\\Temp\\a:b", "C:\\Windows\\Temp\\a::$DATA",
                   "C:\\Windows\\Temp\\a.", "C:\\Windows\\Temp\\a ", "C:\\ProgramData\\x\\a", "C:\\ProgramData\\Microsoft\\Windows\\WER\\a",
                   "C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportQueue", "C:\\Windows\\Minidump", "C:\\Program Files\\a",
                   "\\\\?\\C:\\Windows\\Temp\\a", "\\\\.\\C:\\Windows\\Temp\\a", "//?/C:/Windows/Temp/a", "\\\\localhost\\C$\\Windows\\Temp\\a",
                   "\\\\127.0.0.1\\C$\\Windows\\Temp\\a"])
    assert.equal(checkPath(p, { allowedRoots: ["C:\\Windows"], adminContents: true }).ok, false, p);
});
test("case and slash variants are the same folder, not a bypass and not a new refusal", { skip }, () => {
  for (const p of [T.toUpperCase(), T.toLowerCase(), T.replaceAll("\\", "/")])
    assert.equal(checkPath(p, opts(true)).reason, "does not exist", p);
});
test("8.3 short alias of ProgramData never gets the exception", { skip }, t => {
  let short = null;
  for (const n of ["PROGRA~1", "PROGRA~2", "PROGRA~3", "PROGRA~4"]) {
    try { if (fs.realpathSync.native("C:\\" + n).toLowerCase() === "c:\\programdata") short = "C:\\" + n; } catch { /* absent */ }
  }
  if (!short) return t.skip("no 8.3 alias for C:\\ProgramData on this machine");
  const q = short + "\\Microsoft\\Windows\\WER\\ReportQueue";
  for (const roots of [[q], ["C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportQueue"]])
    assert.equal(checkPath(q + "\\nuke-probe-" + rnd(), { allowedRoots: roots, adminContents: true }).ok, false, roots[0]);
});
test("exception never widens protected or live lists", { skip }, () => {
  const p = T;
  assert.equal(checkPath(p, { ...opts(true), protectedPaths: [p] }).reason, "protected (or contains a protected item)");
  assert.equal(checkPath(p, { ...opts(true), livePaths: [p] }).reason, "live session");
  assert.equal(checkPath(p, { ...opts(true), protectedPaths: ["C:\\Windows\\Temp"] }).reason, "protected (or contains a protected item)");
  const other = checkPath(p, { allowedRoots: ["C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportQueue"], adminContents: true });
  assert.equal(other.ok, false); assert.notEqual(other.reason, "does not exist"); // listed folder A never vouches for listed folder B
  assert.equal(checkPath(p, { allowedRoots: [], adminContents: true }).reason, "bad options");
});
test("adminContentDirs is empty when SystemRoot or ProgramData points elsewhere", { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-env-"));
  const saved = { SystemRoot: process.env.SystemRoot, ProgramData: process.env.ProgramData };
  const cases = [{ SystemRoot: tmp }, { ProgramData: tmp }, { SystemRoot: undefined }, { ProgramData: undefined }, { SystemRoot: "" },
    { SystemRoot: "Windows" }, { SystemRoot: "\\\\localhost\\C$\\Windows" }, { ProgramData: "\\\\?\\C:\\ProgramData" }, { SystemRoot: "C:\\Windows\\" + ".." + "\\Users" },
    { SystemRoot: "C:\\Windows\\System32" }, { ProgramData: "C:\\ProgramData\\Microsoft" }];
  try {
    for (const c of cases) {
      Object.assign(process.env, saved);
      for (const [k, v] of Object.entries(c)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      assert.deepEqual(adminContentDirs(), [], JSON.stringify(c));
      assert.equal(checkPath(T, opts(true)).ok, false, JSON.stringify(c));
      assert.notEqual(checkPath(T, opts(true)).reason, "does not exist", JSON.stringify(c));
    }
    Object.assign(process.env, saved);
    process.env.SystemRoot = "c:\\WINDOWS"; // a case difference is still the same folder
    assert.equal(adminContentDirs().length, 4);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- temp-folder stand-ins: real files, junctions and deletions ----
function standIn() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "admin-gate-"));
  const W = path.join(t, "Win"), P = path.join(t, "PD");
  const dirs = [path.join(W, "Temp"), path.join(W, "Minidump"), path.join(P, "Microsoft", "Windows", "WER", "ReportArchive"), path.join(P, "Microsoft", "Windows", "WER", "ReportQueue")];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  const mk = (f, s = "x") => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
  for (const d of dirs) { mk(path.join(d, "junk.tmp")); mk(path.join(d, "sub", "deep.dmp")); }
  mk(path.join(W, "System32", "kernel.dll")); mk(path.join(W, "Temp2", "twin.txt")); mk(path.join(W, "TempX", "twin.txt"));
  mk(path.join(P, "Microsoft", "Windows", "WER", "Other", "a.txt"));
  const victim = path.join(t, "victim"); const precious = mk(path.join(victim, "precious.txt"), "keep");
  const gate = adminGateForTests({ windowsDir: W, programDataDir: P });
  return { t, W, P, dirs, victim, precious, gate, mk };
}
// SystemRoot/ProgramData point at the stand-ins only inside fn (synchronous), always restored.
function withEnv(env, fn) {
  const saved = { SystemRoot: process.env.SystemRoot, ProgramData: process.env.ProgramData };
  try { Object.assign(process.env, env); return fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const cleanup = s => fs.rmSync(s.t, { recursive: true, force: true });
const junction = (target, at) => fs.symlinkSync(target, at, "junction");
const unJunction = at => { try { fs.unlinkSync(at); } catch { try { fs.rmdirSync(at); } catch { /* gone */ } } };

test("stand-in: adminGateForTests needs the env to match too, and lists the same four shapes", { skip }, () => {
  const s = standIn();
  try {
    assert.deepEqual(s.gate.adminContentDirs(), [], "real SystemRoot does not match the stand-in");
    withEnv({ SystemRoot: s.W, ProgramData: s.P }, () => assert.deepEqual(s.gate.adminContentDirs(), s.dirs));
    withEnv({ SystemRoot: s.W.toUpperCase(), ProgramData: s.P }, () => assert.deepEqual(s.gate.adminContentDirs(), s.dirs));
    withEnv({ SystemRoot: s.W }, () => assert.deepEqual(s.gate.adminContentDirs(), [], "ProgramData mismatch"));
    withEnv({ ProgramData: s.P }, () => assert.deepEqual(s.gate.adminContentDirs(), [], "SystemRoot mismatch"));
  } finally { cleanup(s); }
});
test("stand-in: off by default, on only with true, only strictly inside a listed folder", { skip }, () => {
  const s = standIn();
  try {
    withEnv({ SystemRoot: s.W, ProgramData: s.P }, () => {
      for (const d of s.dirs) {
        for (const p of [path.join(d, "junk.tmp"), path.join(d, "sub"), path.join(d, "sub", "deep.dmp")]) {
          assert.equal(s.gate.checkPath(p, { allowedRoots: [d] }).reason, "system folder", p);
          assert.equal(s.gate.checkPath(p, { allowedRoots: [d], adminContents: false }).reason, "system folder", p);
          assert.equal(s.gate.checkPath(p, { allowedRoots: [d], adminContents: "true" }).reason, "system folder", p);
          const ok = s.gate.checkPath(p, { allowedRoots: [d], adminContents: true });
          assert.equal(ok.ok, true, p + " " + JSON.stringify(ok));
        }
        assert.equal(s.gate.checkPath(d, { allowedRoots: [path.dirname(d)], adminContents: true }).reason, "system folder", "folder itself");
      }
      const wide = { allowedRoots: [s.W, s.P], adminContents: true };
      for (const p of [path.join(s.W, "System32", "kernel.dll"), path.join(s.W, "System32"), path.join(s.W, "Temp2", "twin.txt"),
                       path.join(s.W, "TempX", "twin.txt"), path.join(s.W, "Temp2"), path.join(s.P, "Microsoft", "Windows", "WER", "Other", "a.txt"),
                       path.join(s.P, "Microsoft", "Windows", "WER"), path.join(s.P, "Microsoft"), s.dirs[0], s.dirs[3],
                       s.dirs[0] + "\\" + ".." + "\\System32\\kernel.dll", s.dirs[0] + "\\junk.tmp:evil", s.dirs[0] + "\\junk.tmp.", s.dirs[0] + "\\junk.tmp ",
                       "\\\\?\\" + path.join(s.dirs[0], "junk.tmp"), "\\\\localhost\\" + s.dirs[0].replace(":", "$") + "\\junk.tmp"])
        assert.equal(s.gate.checkPath(p, wide).ok, false, p);
    });
  } finally { cleanup(s); }
});
test("stand-in: env mismatch disables the exception even with the flag", { skip }, () => {
  const s = standIn();
  try {
    const p = path.join(s.dirs[0], "junk.tmp");
    withEnv({ SystemRoot: s.W, ProgramData: s.victim }, () => assert.equal(s.gate.checkPath(p, { allowedRoots: [s.dirs[0]], adminContents: true }).reason, "system folder"));
    withEnv({ SystemRoot: s.W, ProgramData: s.P }, () => assert.equal(s.gate.checkPath(p, { allowedRoots: [s.dirs[0]], adminContents: true }).ok, true));
  } finally { cleanup(s); }
});
test("stand-in: a junction inside a listed folder never carries the exception elsewhere", { skip }, () => {
  const s = standIn();
  const j = path.join(s.dirs[0], "evil"), j2 = path.join(s.dirs[0], "toSys");
  try {
    junction(s.victim, j); junction(path.join(s.W, "System32"), j2);
    withEnv({ SystemRoot: s.W, ProgramData: s.P }, () => {
      const o = { allowedRoots: [s.dirs[0]], adminContents: true };
      // the junction's canonical form is outside the listed folder, so the system refusal stands
      assert.equal(s.gate.checkPath(j, o).reason, "system folder");
      assert.equal(s.gate.checkPath(path.join(j, "precious.txt"), o).ok, false);
      assert.equal(s.gate.checkPath(path.join(j2, "kernel.dll"), o).reason, "system folder");
    });
    assert.equal(fs.readFileSync(s.precious, "utf8"), "keep");
  } finally { unJunction(j); unJunction(j2); cleanup(s); }
});
test("stand-in: a listed folder that is itself a junction loses the exception", { skip }, () => {
  const s = standIn();
  const mini = s.dirs[1];
  try {
    fs.rmSync(mini, { recursive: true }); junction(s.victim, mini);
    withEnv({ SystemRoot: s.W, ProgramData: s.P }, () => {
      const r = s.gate.checkPath(path.join(mini, "precious.txt"), { allowedRoots: [mini], adminContents: true });
      assert.equal(r.ok, false); assert.equal(r.reason, "system folder");
    });
    assert.equal(fs.readFileSync(s.precious, "utf8"), "keep");
  } finally { unJunction(mini); cleanup(s); }
});
test("stand-in: SystemRoot reached through a junction alias still has to be the same canonical folder", { skip }, () => {
  const s = standIn();
  const alias = path.join(s.t, "WinAlias");
  try {
    junction(s.W, alias);
    // env points at an alias of the stand-in: canonical forms are equal, so the list is on
    withEnv({ SystemRoot: alias, ProgramData: s.P }, () => assert.deepEqual(s.gate.adminContentDirs(), s.dirs));
    // but a path written through the alias is not lexically inside the listed folder
    withEnv({ SystemRoot: s.W, ProgramData: s.P }, () =>
      assert.equal(s.gate.checkPath(path.join(alias, "Temp", "junk.tmp"), { allowedRoots: [path.join(alias, "Temp")], adminContents: true }).ok, false));
  } finally { unJunction(alias); cleanup(s); }
});
test("stand-in: protected and live still refuse inside a listed folder", { skip }, () => {
  const s = standIn();
  try {
    withEnv({ SystemRoot: s.W, ProgramData: s.P }, () => {
      const d = s.dirs[0], f = path.join(d, "sub", "deep.dmp");
      const o = { allowedRoots: [d], adminContents: true };
      assert.equal(s.gate.checkPath(f, { ...o, protectedPaths: [f] }).reason, "protected (or contains a protected item)");
      assert.equal(s.gate.checkPath(path.join(d, "sub"), { ...o, protectedPaths: [f] }).reason, "protected (or contains a protected item)");
      assert.equal(s.gate.checkPath(f, { ...o, livePaths: [path.join(d, "sub")] }).reason, "live session");
    });
  } finally { cleanup(s); }
});

// ---- deleter and server forward the option ----
test("removeItem forwards adminContents to checkPath (read-only probe)", { skip }, () => {
  assert.equal(removeItem(T, { allowedRoots: ["C:\\Windows\\Temp"] }).reason, "system folder");
  assert.equal(removeItem(T, { allowedRoots: ["C:\\Windows\\Temp"], adminContents: true }).reason, "already gone");
  assert.equal(removeItem(T, { allowedRoots: ["C:\\Windows\\Temp"], adminContents: "true" }).reason, "system folder");
});

function serverSetup(extraSel = {}) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "admin-srv-"));
  const sel = { sessionId: "S", allowedRoots: ["C:\\Windows\\Temp"], protectedPaths: [], livePaths: [], paths: [T], ...extraSel };
  sel.sha256 = selectionHash(sel);
  const selectionFile = path.join(t, "selection.json"); fs.writeFileSync(selectionFile, JSON.stringify(sel));
  const pageFile = path.join(t, "page.html"); fs.writeFileSync(pageFile, "<html>page</html>");
  const soundsDir = path.join(t, "sounds"); fs.mkdirSync(soundsDir);
  return { t, selectionFile, pageFile, soundsDir, auditFile: path.join(t, "audit.log") };
}
async function shownReason(o) {
  const srv = createCleanupServer({ ageCheckOffForTests: true, ...o });
  try {
    const { port } = await srv.listen();
    const res = await fetch(`http://127.0.0.1:${port}/state?t=${srv.token}`);
    return (await res.json()).items[0].reason;
  } finally { srv.close(); }
}
test("server: adminContents is a trusted option, strict boolean, absent from selection.json influence", { skip }, async () => {
  const s = serverSetup({ adminContents: true }); // an extra field in the file: ignored, not hashed
  const base = { selectionFile: s.selectionFile, pageFile: s.pageFile, soundsDir: s.soundsDir, auditFile: s.auditFile };
  try {
    assert.equal(await shownReason(base), "system folder");
    assert.equal(await shownReason({ ...base, adminContents: false }), "system folder");
    assert.equal(await shownReason({ ...base, adminContents: true }), "does not exist");
    for (const v of ["true", 1, {}, null, [true]]) assert.throws(() => createCleanupServer({ ...base, adminContents: v }), /bad option adminContents/, String(v));
  } finally { fs.rmSync(s.t, { recursive: true, force: true }); }
});
test("only safepath itself (and tests) reference the test-only gate: every non-test .mjs/.cjs/.js is scanned", () => {
  const root = path.join(here, "..");
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if ([".git", "node_modules", "test", "docs", ".claude", ".superpowers", "release", "dist"].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(mjs|cjs|js)$/i.test(e.name)) files.push(p);
    }
  };
  walk(root);
  const rel = f => path.relative(root, f).replaceAll("\\", "/");
  for (const must of ["server.mjs", "run.mjs", "lib/delete.mjs", "lib/delete-internal.mjs", "lib/smartscan.mjs", "app/main/controller.mjs", "app/main/elevation.mjs"])
    assert.ok(files.some(f => rel(f) === must), must);
  for (const f of files) {
    if (rel(f) === "lib/safepath.mjs") continue;
    assert.ok(!fs.readFileSync(f, "utf8").includes("adminGateForTests"), rel(f));
  }
});
