// test/run.test.mjs
import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { buildSelection, resolveSession, summary, revalidate, launchNuke, bindToken, canonicalText, parseCli, UsageError } from "../run.mjs";
import { scanSession } from "../scan.mjs";
import { selectionHash, createCleanupServer } from "../server.mjs";
import { dirArgProblem } from "../lib/safepath.mjs";

const item = (id, group, extra = {}) => ({ id, path: `E:\\x\\${id}`, kind: "file", bytes: 10, drive: "E:\\", group, reason: "r", sharedWith: [], ...extra });
const map = {
  sessionId: "S", claudeDir: "E:\\c", allowedRoots: ["E:\\x"], protectedPaths: [], livePaths: [], protected: [], offDisk: [],
  drives: { "E:\\": { total: 100, free: 50 } },
  items: [item("aa", "exclusive"), item("bb", "shared", { sharedWith: ["B"] }), item("cc", "live"), item("dd", "protected")],
};

test("buildSelection takes exclusive items and hashes the result", () => {
  const sel = buildSelection(map, ["aa"]);
  assert.deepEqual(sel.paths, ["E:\\x\\aa"]);
  assert.equal(sel.sha256, selectionHash(sel));
});
test("shared items need an explicit allowShared; live, protected, unknown and empty are refused", () => {
  assert.throws(() => buildSelection(map, ["bb"]), /shared with "B"/);
  assert.deepEqual(buildSelection(map, ["bb"], { allowShared: ["bb"] }).paths, ["E:\\x\\bb"]);
  assert.throws(() => buildSelection(map, ["cc"]), /live/);
  assert.throws(() => buildSelection(map, ["cc"], { allowShared: ["cc"] }), /live/);
  assert.throws(() => buildSelection(map, ["dd"]), /protected/);
  assert.throws(() => buildSelection(map, ["zz"]), /unknown item/);
  assert.throws(() => buildSelection(map, []), /nothing selected/);
});
test("duplicate ids are collapsed", () => {
  assert.equal(buildSelection(map, ["aa", "aa"]).paths.length, 1);
});
test("resolveSession: exactly one top-level transcript holding the nonce; 0 or 2+ refuse; no newest-file fallback", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  const f = path.join(t, "projects", "E--Claude"), g = path.join(t, "projects", "other"); fs.mkdirSync(f, { recursive: true }); fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(f, "mine.jsonl"), "x\nrun.mjs scan --nonce Zk3pQ9wXy2\n");
  fs.writeFileSync(path.join(g, "newest.jsonl"), "unrelated"); // newest file anywhere must never be chosen
  fs.mkdirSync(path.join(f, "mine-sub")); fs.writeFileSync(path.join(f, "mine-sub", "agent.jsonl"), "Zk3pQ9wXy2"); // subagent transcript: not top level
  assert.equal(resolveSession(t, "Zk3pQ9wXy2"), "mine");
  assert.throws(() => resolveSession(t, "NoSuchWord99"), /no transcript contains/);
  fs.writeFileSync(path.join(g, "other.jsonl"), "again Zk3pQ9wXy2");
  assert.throws(() => resolveSession(t, "Zk3pQ9wXy2"), /more than one/);
  assert.throws(() => resolveSession(t, undefined), /nonce/);
  assert.throws(() => resolveSession(t, "short"), /nonce/);
  assert.throws(() => resolveSession(t, "a b c d e f g h"), /nonce/);
  fs.rmSync(t, { recursive: true, force: true });
});
test("resolveSession refuses ids that are not safe", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  fs.mkdirSync(path.join(t, "projects", "other"), { recursive: true });
  fs.writeFileSync(path.join(t, "projects", "other", "bad id;x.jsonl"), "Zk3pQ9wXy2");
  assert.throws(() => resolveSession(t, "Zk3pQ9wXy2"), /invalid session id/);
  fs.rmSync(t, { recursive: true, force: true });
});
test("resolveSession finds a nonce that straddles the read-chunk boundary", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  fs.mkdirSync(path.join(t, "projects", "p"), { recursive: true });
  fs.writeFileSync(path.join(t, "projects", "p", "big.jsonl"), "a".repeat((1 << 20) - 4) + "Zk3pQ9wXy2" + "b".repeat(100));
  assert.equal(resolveSession(t, "Zk3pQ9wXy2"), "big");
  fs.rmSync(t, { recursive: true, force: true });
});
test("summary lists groups, sizes, and the protected count", () => {
  const s = summary({ ...map, protected: [{ path: "x", reason: "drive root" }] });
  assert.match(s, /EXCLUSIVE/); assert.match(s, /SHARED/); assert.match(s, /aa/); assert.match(s, /1 refused/);
});
test("run.mjs never calls a delete primitive itself", () => {
  const src = fs.readFileSync(new URL("../run.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\b(rmSync|unlinkSync|rmdirSync|rm|unlink|rmdir|removeItem)\s*\(/);
  // the single permitted process spawn in non-test code is the default-browser opener (R24); nothing else may spawn or exec
  assert.doesNotMatch(src, /\bexec(Sync|File|FileSync)?\b|\bfork\b|shell:\s*true|spawnSync/);
  assert.equal((src.match(/\bspawnFn\(/g) || []).length, 1, "exactly one spawn call");
  assert.ok(/spawnFn\(exe, \["url\.dll,FileProtocolHandler", url\], \{ shell: false, detached: true, stdio: "ignore"/.test(src));
  assert.ok(/path\.join\(systemRoot, "System32", "rundll32\.exe"\)/.test(src), "rundll32 by full path");
  assert.equal((src.match(/from "node:child_process"/g) || []).length, 1);
  for (const f of ["scan.mjs", "server.mjs", "lib/safepath.mjs", "lib/delete.mjs", "lib/delete-internal.mjs", "lib/transcript.mjs", "lib/classify.mjs", "lib/sizes.mjs", "lib/lock.mjs"]) {
    assert.doesNotMatch(fs.readFileSync(new URL("../" + f, import.meta.url), "utf8"), /child_process/, f);
  }
});
test("openDefaultBrowser uses the fixed C:\\Windows root by default, never %SystemRoot% from the environment", { skip: process.platform !== "win32" }, async () => {
  const { openDefaultBrowser } = await import("../run.mjs");
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "odb-"));
  fs.mkdirSync(path.join(fakeRoot, "System32")); fs.writeFileSync(path.join(fakeRoot, "System32", "rundll32.exe"), "");
  const saved = process.env.SystemRoot;
  try {
    process.env.SystemRoot = fakeRoot;
    const calls = [];
    const sp = (exe, args, opts) => { calls.push({ exe, opts }); const c = new EventEmitter(); c.unref = () => {}; setImmediate(() => c.emit("spawn")); return c; };
    await openDefaultBrowser("http://127.0.0.1:1234/?t=" + "a".repeat(64), sp);
    assert.equal(calls[0].exe, "C:\\Windows\\System32\\rundll32.exe");
    assert.equal(calls[0].opts.shell, false);
  } finally {
    if (saved === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = saved;
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});

// ---- sandbox integration (fixture/sandbox only) ----
const sb = path.resolve("fixture", "sandbox");
const scanOpts = { claudeDir: path.join(sb, "claude"), sessionId: "dummy-session-A", roots: [path.join(sb, "work"), path.join(sb, "claude")], tmpDir: path.join(sb, "tmp") };
let outDir;
before(() => {
  execFileSync(process.execPath, ["fixture/make-fixture.mjs"], { stdio: "ignore" });
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-out-"));
});
const fake = () => ({ listen: async () => ({ url: "u" }), close() {} });
const bindFor = (over = {}) => { const live = (over.targetIsLive ?? true) === true; return bindToken(scanSession({ ...scanOpts, ...over, targetIsLive: live }), live); };
const listing = () => fs.readdirSync(path.join(sb, "work", "projA")).sort();

test("revalidate refuses an item outside the roots or a protected one, and a missing item", () => {
  const w = path.join(sb, "work");
  const sel = p => buildSelection({ ...map, allowedRoots: [w], items: [item("aa", "exclusive", { path: p })] }, ["aa"]);
  revalidate(sel(path.join(w, "projA", "notes.txt")));
  assert.throws(() => revalidate(sel(path.join(sb, "claude", "settings.json"))), /refused/);
  assert.throws(() => revalidate(sel(path.join(w, "nope.txt"))), /refused/);
});

test("the hash is SHA-256 of the exact canonical text of the five fields, equal to the server hash", () => {
  const sel = buildSelection(map, ["aa"]);
  assert.equal(sel.sha256, crypto.createHash("sha256").update(canonicalText(sel)).digest("hex"));
  assert.equal(canonicalText(sel), JSON.stringify({ sessionId: "S", paths: sel.paths, allowedRoots: sel.allowedRoots, protectedPaths: [], livePaths: [] }));
});

test("launchNuke rescans, writes the exact hashed selection, passes all four trusted options, deletes nothing", async () => {
  const was = listing();
  const scan = scanSession(scanOpts);
  const notes = scan.items.find(i => i.path.endsWith("notes.txt"));
  const seen = {};
  const r = await launchNuke({ ...scanOpts, ids: [notes.id], outDir, bind: bindFor(), createServer: o => { Object.assign(seen, o); return { listen: async () => ({ url: "http://127.0.0.1:1/?t=x" }), close() {} }; } });
  assert.equal(r.url, "http://127.0.0.1:1/?t=x");
  const sel = JSON.parse(fs.readFileSync(path.join(outDir, "selection.json")));
  assert.deepEqual(sel.paths, [notes.path]);
  assert.equal(sel.sha256, selectionHash(sel));
  assert.equal(seen.expectedSha256, sel.sha256);
  assert.deepEqual(seen.allowedRoots, scan.allowedRoots);
  assert.deepEqual(seen.protectedPaths, scan.protectedPaths);
  assert.deepEqual(seen.livePaths, sel.livePaths);
  assert.deepEqual(listing(), was);
});

test("live item paths are in the selection and in the server livePaths", async () => {
  const live = scanSession({ ...scanOpts, targetIsLive: true });
  const liveItems = live.items.filter(i => i.group === "live");
  assert.ok(liveItems.length > 0);
  const notes = live.items.find(i => i.path.endsWith("notes.txt"));
  const seen = {};
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "run-out-"));
  await launchNuke({ ...scanOpts, targetIsLive: true, ids: [notes.id], outDir: d, bind: bindFor(), createServer: o => { Object.assign(seen, o); return fake(); } });
  for (const i of liveItems) { assert.ok(seen.livePaths.includes(i.path), i.path); assert.ok(JSON.parse(fs.readFileSync(path.join(d, "selection.json"))).livePaths.includes(i.path)); }
  // and the real server refuses those paths even if a hand-made selection named them
  const own = liveItems[0];
  const sel = { sessionId: "dummy-session-A", paths: [own.path], allowedRoots: seen.allowedRoots, protectedPaths: seen.protectedPaths, livePaths: seen.livePaths };
  sel.sha256 = selectionHash(sel);
  const f = path.join(d, "hand.json"); fs.writeFileSync(f, JSON.stringify(sel));
  const s = createCleanupServer({ selectionFile: f, pageFile: f, soundsDir: d, auditFile: path.join(d, "a.log"), expectedSha256: sel.sha256, allowedRoots: seen.allowedRoots, protectedPaths: seen.protectedPaths, livePaths: seen.livePaths, ageCheckOffForTests: true });
  const { port, url } = await s.listen();
  const res = await fetch(`http://127.0.0.1:${port}/state?t=${new URL(url).searchParams.get("t")}`);
  const st = await res.json(); s.close();
  assert.equal(st.items[0].refused, true);
});

test("launchNuke refuses live and un-allowed shared items and writes nothing", async () => {
  const scan = scanSession({ ...scanOpts, targetIsLive: true });
  const own = scan.items.find(i => i.path.endsWith("dummy-session-A.jsonl"));
  assert.equal(own.group, "live");
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "run-out-"));
  const bind = bindFor();
  await assert.rejects(launchNuke({ ...scanOpts, ids: [own.id], outDir: dir2, bind, createServer: fake }), /live/);
  const shared = scan.items.find(i => i.group === "shared");
  await assert.rejects(launchNuke({ ...scanOpts, ids: [shared.id], outDir: dir2, bind, createServer: fake }), /shared/);
  assert.equal(fs.existsSync(path.join(dir2, "selection.json")), false);
});

test("binding: missing, wrong, or scan-changed (session, roots, live flag, group) tokens are refused and write nothing", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "run-out-"));
  const notes = scanSession(scanOpts).items.find(i => i.path.endsWith("notes.txt"));
  const go = (over, bind) => launchNuke({ ...scanOpts, ids: [notes.id], outDir: d, createServer: fake, ...over, bind });
  await assert.rejects(go({}, undefined), /binding mismatch/);
  await assert.rejects(go({}, "0".repeat(64)), /binding mismatch/);
  const good = bindFor();
  await assert.rejects(go({ sessionId: "dummy-session-B" }, good), /binding mismatch/);              // session changed
  await assert.rejects(go({ roots: [path.join(sb, "work", "projA")] }, good), /binding mismatch/);            // roots changed
  await assert.rejects(go({ targetIsLive: false }, good), /binding mismatch/);                       // live flag changed
  // a group change between scan and launch: bind computed over a map where notes.txt was shared
  const m = scanSession(scanOpts);
  m.items.find(i => i.id === notes.id).group = "shared";
  await assert.rejects(go({}, bindToken(m, true)), /binding mismatch/);
  assert.equal(fs.existsSync(path.join(d, "selection.json")), false);
});

test("serverOpts cannot override the trusted options or point the audit log outside out/", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "run-out-"));
  const notes = scanSession(scanOpts).items.find(i => i.path.endsWith("notes.txt"));
  const seen = {};
  const evil = { allowedRoots: ["C:\\"], protectedPaths: [], livePaths: [], expectedSha256: "0".repeat(64), selectionFile: "C:\\x", pageFile: "C:\\x", ttlMs: 5 };
  await launchNuke({ ...scanOpts, ids: [notes.id], outDir: d, bind: bindFor(), serverOpts: evil, createServer: o => { Object.assign(seen, o); return fake(); } });
  assert.deepEqual(seen.allowedRoots, scanSession(scanOpts).allowedRoots);
  assert.notEqual(seen.expectedSha256, "0".repeat(64));
  assert.equal(seen.selectionFile, path.join(d, "selection.json"));
  assert.equal(seen.ttlMs, 5); // whitelisted timing option passes through
  await assert.rejects(launchNuke({ ...scanOpts, ids: [notes.id], outDir: d, bind: bindFor(), serverOpts: { auditFile: "C:\\evil.log" }, createServer: fake }), /auditFile/);
});

// ---- strict CLI parsing: nothing here touches the disk beyond the sandbox ----
const sbCommon = ["--claude-dir", scanOpts.claudeDir, "--session", "dummy-session-A", "--roots", scanOpts.roots.join(";"), "--tmp-dir", scanOpts.tmpDir];
const cli = (args, opts = {}) => spawnSync(process.execPath, ["run.mjs", ...args], { encoding: "utf8", ...opts });

test("parseCli: --live must be exactly true or false", () => {
  for (const bad of [[], ["TRUE"], ["1"], ["yes"], [""], ["--roots", "x"]]) {
    const argv = ["scan", "--live", ...bad];
    assert.throws(() => parseCli(argv), UsageError, JSON.stringify(argv));
  }
  assert.throws(() => parseCli(["scan", "--live"]), /needs a value/);       // bare flag at the end
  assert.throws(() => parseCli(["scan", "--live", "--session", "x"]), /needs a value/); // swallows the next flag? no
  assert.equal(parseCli(["scan"]).targetIsLive, true);
  assert.equal(parseCli(["scan", "--live", "true"]).targetIsLive, true);
  assert.equal(parseCli(["scan", "--claude-dir", scanOpts.claudeDir, "--live", "false"]).targetIsLive, false);
});
test("parseCli: --live false needs an explicit sandbox claude dir, never the real one", () => {
  assert.throws(() => parseCli(["scan", "--live", "false"]), /explicit --claude-dir/);
  const real = path.join(os.homedir(), ".claude");
  assert.throws(() => parseCli(["scan", "--claude-dir", real, "--live", "false"]), /not the real/);
  assert.throws(() => parseCli(["scan", "--claude-dir", real + path.sep, "--live", "false"]), /not the real/);
});
test("parseCli: dangerous roots, claude dir and tmp dir are refused before any scan", () => {
  const home = os.homedir();
  const cases = [
    ["--roots", path.parse(home).root], ["--roots", "C:\\"], ["--roots", "E:/"], ["--roots", home], ["--roots", path.dirname(home)],
    ["--roots", "\\\\server\\share\\x"], ["--roots", "//server/share"], ["--roots", "\\\\?\\C:\\x"], ["--roots", "//./C:/x"],
    ["--roots", sb + "/work/../.."], ["--roots", `${path.join(sb, "work")};..`], ["--roots", "C:\\Windows\\Temp"],
    ["--roots", `${path.join(sb, "work")};${home}`],
    ["--claude-dir", home], ["--claude-dir", "\\\\host\\share"], ["--claude-dir", path.parse(home).root],
    ["--tmp-dir", home], ["--tmp-dir", "//?/C:/x"], ["--tmp-dir", "C:\\Windows"],
  ];
  for (const c of cases) assert.throws(() => parseCli(["scan", ...c]), UsageError, JSON.stringify(c));
  parseCli(["scan", "--claude-dir", scanOpts.claudeDir, "--roots", path.join(sb, "work")]); // a normal root is fine in the sandbox
  assert.throws(() => parseCli(["scan", "--roots", path.join(sb, "work")]), /sandbox-only/);   // L2: never on the real folder
});
test("parseCli: launch needs an explicit session and a bind; ids are trimmed; --out is confined", () => {
  const base = ["launch", "--claude-dir", scanOpts.claudeDir, "--ids", " aa , bb ,", "--bind", "x"];
  assert.throws(() => parseCli(base), /explicit --session/);
  assert.throws(() => parseCli([...base, "--session", "auto"]), /explicit --session/);
  assert.throws(() => parseCli(["launch", "--session", "s", "--ids", "a"]), /--bind/);
  assert.throws(() => parseCli([...base, "--session", "s"]), /--nonce/);
  assert.deepEqual(parseCli([...base, "--session", "s", "--nonce", "Zk3pQ9wXy2"]).ids, ["aa", "bb"]);
  assert.throws(() => parseCli(["scan", "--out", path.join(os.tmpdir(), "m.json")]), /out\//);
  parseCli(["scan", "--out", path.join(os.tmpdir(), "m.json"), "--claude-dir", scanOpts.claudeDir]); // sandbox: allowed
});

test("CLI: bad or missing command exits 2 with usage on stderr and touches nothing", () => {
  for (const args of [[], ["frobnicate"], ["scan", "--bogus", "1"], ["scan", "--live"]]) {
    const r = cli(args, { env: { ...process.env, USERPROFILE: "Z:\\does-not-exist", HOME: "Z:\\does-not-exist" } });
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /usage:/);
    assert.equal(r.stdout, "");
  }
});
test("CLI: --live false with the default claude dir exits 2", () => {
  const r = cli(["scan", "--live", "false", "--session", "dummy-session-A"]);
  assert.equal(r.status, 2); assert.match(r.stderr, /explicit --claude-dir/);
});
test("CLI: dangerous --roots exit 2 before scanning", () => {
  for (const roots of [path.parse(sb).root, "\\\\server\\share", os.homedir(), `${sb}\\work\\..\\..`]) {
    const r = cli(["scan", ...sbCommon.filter((_, i, a) => a[i - 1] !== "--roots" && a[i] !== "--roots"), "--roots", roots]);
    assert.equal(r.status, 2, roots); assert.match(r.stderr, /--roots/);
  }
});

test("CLI: scan prints the map and a bind token; launch needs it; a tampered map.json has no effect", async () => {
  const NONCE = "Rn4TestNonce77";
  fs.appendFileSync(path.join(sb, "claude", "projects", "SBX-project", "dummy-session-A.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: `node run.mjs scan --nonce ${NONCE}` } }) + "\n");
  const common = [...sbCommon, "--live", "false", "--nonce", NONCE];
  const cliDir = path.join(outDir, "cli"); fs.mkdirSync(cliDir); const mapFile = path.join(cliDir, "cli-map.json");
  const out = cli(["scan", ...common, "--out", mapFile]).stdout;
  assert.match(out, /EXCLUSIVE \(11 items/); assert.match(out, /SHARED \(9 items/);
  const meta = out.split(/\r?\n/).filter(l => l.startsWith("NUKE_META="));
  assert.equal(meta.length, 1, "exactly one machine-readable line");
  const bind = JSON.parse(meta[0].slice(10)).bind; assert.match(bind, /^[0-9a-f]{64}$/);
  const m = JSON.parse(fs.readFileSync(mapFile, "utf8"));
  assert.ok(m.protected.length >= 5);
  const notes = m.items.find(i => i.path.endsWith("notes.txt"));
  // tamper: the saved map now claims a different item/path under the id the user picked
  const tampered = { ...m, allowedRoots: [path.parse(sb).root], items: m.items.map(i => i.id === notes.id ? { ...i, path: path.join(sb, "claude", "settings.json") } : i) };
  fs.writeFileSync(mapFile, JSON.stringify(tampered));
  const bad = cli(["launch", ...common, "--out", mapFile, "--ids", notes.id, "--bind", "0".repeat(64)]);
  assert.equal(bad.status, 2); assert.match(bad.stderr, /binding mismatch/);
  assert.equal(fs.existsSync(path.join(path.dirname(mapFile), "selection.json")), false);
  const child = spawn(process.execPath, ["run.mjs", "launch", ...common, "--print-url", "true", "--out", mapFile, "--ids", notes.id, "--bind", bind], { stdio: ["ignore", "pipe", "pipe"] });
  const line = await new Promise((resolve, reject) => {
    let buf = ""; child.stdout.on("data", d => { buf += d; const l = buf.split(/\r?\n/).find(x => x.startsWith("NUKE_URL=")); if (l) resolve(l); });
    child.on("exit", c => reject(new Error("exited " + c))); setTimeout(() => reject(new Error("timeout")), 15000).unref();
  });
  child.kill();
  assert.match(line, /^NUKE_URL=http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}$/);
  const sel = JSON.parse(fs.readFileSync(path.join(path.dirname(mapFile), "selection.json")));
  assert.deepEqual(sel.paths, [notes.path]);                       // the real path, not the tampered one
  assert.ok(!sel.allowedRoots.some(r => r === path.parse(sb).root));
  assert.equal(fs.existsSync(path.join(sb, "work", "projA", "notes.txt")), true);
  assert.ok(!fs.readFileSync(path.join(path.dirname(mapFile), "selection.json"), "utf8").includes(line.split("t=")[1])); // token never written
});

// ---- Fix round 2: directory arguments are judged on their canonical form (real junctions, injected home) ----
function withAliases(fn) {
  const T = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "alias-")));
  const home = path.join(T, "home"); fs.mkdirSync(path.join(home, "proj"), { recursive: true });
  const alias = path.join(T, "alias"), up = path.join(T, "up");
  fs.symlinkSync(home, alias, "junction"); fs.symlinkSync(T, up, "junction");
  try { return fn({ T, home, alias, up }); } finally {
    for (const l of [alias, up]) { try { fs.unlinkSync(l); } catch { try { fs.rmdirSync(l); } catch { /* gone */ } } }
    fs.rmSync(T, { recursive: true, force: true });
  }
}
test("dirArgProblem: junction aliases of the home folder or of a parent of it are refused", () => {
  withAliases(({ T, home, alias, up }) => {
    const h = { home };
    assert.match(dirArgProblem(alias, h), /home/);
    assert.match(dirArgProblem(up, h), /home/);
    assert.match(dirArgProblem(path.join(up, "home"), h), /home/);
    assert.match(dirArgProblem(home, h), /home/);
    assert.equal(dirArgProblem(path.join(alias, "proj"), h), null);      // a child of home through an alias is fine
    assert.equal(dirArgProblem(path.join(home, "not-yet-created"), h), null);
  });
});
test("dirArgProblem: relative, trailing dot/space and alternate data streams are refused", () => {
  withAliases(({ home }) => {
    const h = { home };
    for (const bad of ["work", ".", "", "proj", "C:work"]) assert.match(dirArgProblem(bad, h) || "", /not absolute|not a path/, bad);
    assert.match(dirArgProblem(path.join(home, "proj") + ".", h), /trailing/);
    assert.match(dirArgProblem(path.join(home, "proj") + " ", h), /trailing/);
    assert.match(dirArgProblem(path.join(home, "proj" + ". ", "x"), h), /trailing/);
    assert.match(dirArgProblem(path.join(home, "proj") + ":stream", h), /alternate data stream/);
  });
});
test("real system aliases (read-only probes): 8.3 names, Documents and Settings, All Users", { skip: process.platform !== "win32" }, () => {
  const probes = ["C:\\PROGRA~1", "C:\\Documents and Settings", "C:\\Users\\All Users", "C:\\Documents and Settings\\" + path.basename(os.homedir())];
  for (const p of probes) {
    if (!fs.existsSync(p)) continue;
    assert.notEqual(dirArgProblem(p), null, p);
    const r = cli(["scan", "--roots", p, "--session", "x"]);
    assert.equal(r.status, 2, p); assert.match(r.stderr, /--roots/); assert.equal(r.stdout, "");
  }
});
test("CLI: relative, ADS and trailing-dot roots exit 2 with no scan output", () => {
  for (const p of ["work", ".", path.join(sb, "work") + ".", path.join(sb, "work") + " ", path.join(sb, "work") + ":s"]) {
    const r = cli(["scan", "--roots", p, "--session", "x"]);
    assert.equal(r.status, 2, p); assert.equal(r.stdout, "");
  }
});
test("parseCli: --tmp-dir is test-only and --out is pinned unless the claude dir is an explicit sandbox", () => {
  const real = path.join(os.homedir(), ".claude");
  assert.throws(() => parseCli(["scan", "--tmp-dir", scanOpts.tmpDir]), /test-only/);
  assert.throws(() => parseCli(["scan", "--claude-dir", real, "--tmp-dir", scanOpts.tmpDir]), /test-only/);
  assert.throws(() => parseCli(["scan", "--claude-dir", real, "--out", path.join(os.tmpdir(), "m.json")]), /out\//);
  parseCli(["scan", "--claude-dir", scanOpts.claudeDir, "--tmp-dir", scanOpts.tmpDir]);
  parseCli(["scan", "--claude-dir", scanOpts.claudeDir, "--out", path.join(os.tmpdir(), "m.json")]);
  const r = cli(["scan", "--tmp-dir", scanOpts.tmpDir, "--session", "x"]);
  assert.equal(r.status, 2); assert.equal(r.stdout, "");
});
