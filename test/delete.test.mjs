// test/delete.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { removeItem } from "../lib/delete.mjs";
import { removeTreeGuarded } from "../lib/delete-internal.mjs";

const WIN = process.platform === "win32";
const t = fs.mkdtempSync(path.join(os.tmpdir(), "del-"));
const root = path.join(t, "work"); const victim = path.join(t, "victim");
fs.mkdirSync(root); fs.mkdirSync(victim);
fs.writeFileSync(path.join(victim, "precious.txt"), "keep");
const check = { allowedRoots: [root] };
const file = (...p) => { const f = path.join(root, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(100)); return f; };
const link = (target, at) => WIN ? execFileSync("cmd", ["/c", "mklink", "/J", at, target], { stdio: "ignore" }) : fs.symlinkSync(target, at, "dir");
// R5: remove a link itself, never recursing through it.
const dropLink = at => { try { fs.unlinkSync(at); } catch { try { fs.rmdirSync(at); } catch { /* already gone */ } } };
const precious = () => fs.readFileSync(path.join(victim, "precious.txt"), "utf8");

test("deletes a file and reports its bytes", () => {
  const f = file("a.txt");
  assert.deepEqual(removeItem(f, check), { path: f, status: "deleted", bytes: 100 });
  assert.equal(fs.existsSync(f), false);
});
test("deletes a folder tree", () => {
  file("d", "x.txt"); file("d", "sub", "y.txt");
  const r = removeItem(path.join(root, "d"), check);
  assert.equal(r.status, "deleted"); assert.equal(r.bytes, 200);
  assert.equal(fs.existsSync(path.join(root, "d")), false);
});
test("a junction inside a folder is unlinked, never followed: the target survives", () => {
  file("j", "own.txt");
  const at = path.join(root, "j", "evil");
  link(victim, at);
  try {
    const r = removeItem(path.join(root, "j"), check);
    assert.equal(r.status, "deleted");
    assert.equal(fs.existsSync(path.join(root, "j")), false);
    assert.equal(precious(), "keep");
  } finally { dropLink(at); }
});
test("a nested junction two levels deep is unlinked, never followed", () => {
  file("j2", "a", "own.txt");
  const at = path.join(root, "j2", "a", "evil");
  link(victim, at);
  try {
    const r = removeItem(path.join(root, "j2"), check);
    assert.equal(r.status, "deleted");
    assert.equal(precious(), "keep");
  } finally { dropLink(at); }
});
test("a path that is itself a junction is refused and the target survives", () => {
  const at = path.join(root, "top-link");
  link(victim, at);
  try {
    const r = removeItem(at, check);
    assert.equal(r.status, "skipped");
    assert.ok(fs.existsSync(path.join(victim, "precious.txt")));
  } finally { dropLink(at); }
});
test("junction swapped in after the scan: a dir replaced by a link is refused, target survives", () => {
  const d = path.join(root, "swap");
  fs.mkdirSync(d);
  // scan saw a real folder; before delete it is replaced by a junction to victim
  fs.rmdirSync(d);
  link(victim, d);
  try {
    const r = removeItem(d, check);
    assert.equal(r.status, "skipped");
    assert.equal(precious(), "keep");
  } finally { dropLink(d); }
});
test("a file path whose parent was swapped for a junction is refused", () => {
  const parent = path.join(root, "swapparent");
  link(victim, parent);
  try {
    const r = removeItem(path.join(parent, "precious.txt"), check);
    assert.equal(r.status, "skipped");
    assert.equal(precious(), "keep");
  } finally { dropLink(parent); }
});
test("protected, live and outside-root paths are skipped with the reason", () => {
  const f = file("p.txt");
  assert.match(removeItem(f, { ...check, protectedPaths: [f] }).reason, /protected/);
  assert.match(removeItem(f, { ...check, livePaths: [f] }).reason, /live/);
  assert.match(removeItem(path.join(victim, "precious.txt"), check).reason, /outside/);
  assert.ok(fs.existsSync(f));
});
test("a folder containing a protected item is skipped whole", () => {
  const f = file("pd", "keep.txt"); file("pd", "other.txt");
  const r = removeItem(path.join(root, "pd"), { ...check, protectedPaths: [f] });
  assert.equal(r.status, "skipped"); assert.match(r.reason, /protected/);
  assert.ok(fs.existsSync(f));
});
test("drive root, allowed root itself, relative and traversal paths are skipped", () => {
  const driveRoot = path.parse(root).root;
  assert.equal(removeItem(driveRoot, { allowedRoots: [driveRoot] }).status, "skipped");
  assert.equal(removeItem(driveRoot, check).status, "skipped");
  for (const p of [root, "relative.txt", path.join(root, "..", "victim", "precious.txt"), ""]) {
    const r = removeItem(p, check);
    assert.equal(r.status, "skipped", String(p));
  }
  assert.ok(fs.existsSync(root));
  assert.equal(precious(), "keep");
});
test("bad options and non-string targets never throw", () => {
  for (const [p, c] of [[undefined, check], [null, check], [42, check], [file("q.txt"), undefined], [file("q2.txt"), {}], [file("q3.txt"), { allowedRoots: "x" }]]) {
    let r; assert.doesNotThrow(() => { r = removeItem(p, c); });
    assert.equal(r.status, "skipped"); assert.equal(r.bytes, 0);
  }
  assert.ok(fs.existsSync(path.join(root, "q.txt")));
});
test("duplicate or nested selections: the second is 'already gone', not an error", () => {
  const f = file("n", "deep.txt");
  assert.equal(removeItem(path.join(root, "n"), check).status, "deleted");
  const again = removeItem(f, check);
  assert.deepEqual([again.status, again.reason], ["skipped", "already gone"]);
});
// A child process that holds a file open with no sharing (Windows), so deletes genuinely fail.
function lockFile(f) {
  const ps = spawn("powershell", ["-NoProfile", "-Command",
    `$h=[IO.File]::Open('${f.replace(/'/g, "''")}','Open','ReadWrite','None'); Write-Host LOCKED; Start-Sleep 60`], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((res, rej) => {
    ps.stdout.on("data", d => { if (String(d).includes("LOCKED")) res(ps); });
    ps.on("exit", () => rej(new Error("lock helper exited")));
  });
}
const unlock = ps => new Promise(r => { ps.once("exit", r); ps.kill(); });
test("a locked file fails that item only and is not counted", { skip: !WIN }, async () => {
  const f = file("locked.txt");
  const ps = await lockFile(f);
  try {
    const r = removeItem(f, check);
    assert.equal(r.status, "failed"); assert.equal(r.bytes, 0);
    assert.ok(fs.existsSync(f));
  } finally { await unlock(ps); }
});
test("a failure partway through a folder is failed, never an exception, and nothing outside is touched", { skip: !WIN }, async () => {
  file("pf", "a.txt"); const z = file("pf", "z.txt");
  const ps = await lockFile(z);
  try {
    let r; assert.doesNotThrow(() => { r = removeItem(path.join(root, "pf"), check); });
    assert.equal(r.status, "failed"); assert.equal(r.bytes, 0);
    assert.equal(precious(), "keep");
  } finally { await unlock(ps); }
});
test("a junction via a volume-GUID path inside a folder is never descended (target is only the sandbox victim)", { skip: !WIN }, (tc) => {
  const drive = path.parse(t).root.slice(0, 2);
  let guid;
  try { guid = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Volume -DriveLetter ${drive[0]}).UniqueId`], { encoding: "utf8" }).trim(); } catch (e) { return tc.skip("cannot read volume GUID: " + e.message); }
  if (!/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i.test(guid)) return tc.skip("unexpected GUID form: " + guid);
  // Target is GUID + the sandbox victim folder (no drive letter): worst case is the victim, never a drive root.
  const target = guid + victim.slice(3);
  file("g", "own.txt");
  const at = path.join(root, "g", "vol");
  try { execFileSync("cmd", ["/c", "mklink", "/J", at, target], { stdio: "ignore" }); } catch (e) { return tc.skip("cannot create GUID junction: " + e.message); }
  try {
    const st = fs.lstatSync(at);
    tc.diagnostic(`junction lstat: isSymbolicLink=${st.isSymbolicLink()} isDirectory=${st.isDirectory()}`);
    const r = removeItem(path.join(root, "g"), check);
    tc.diagnostic(`observed: status=${r.status} reason=${r.reason}`);
    if (st.isSymbolicLink()) assert.equal(r.status, "deleted"); // Node sees it: unlinked as a link
    else { assert.equal(r.status, "failed"); assert.match(r.reason, /^(ALIAS|CROSS_VOLUME)$/); }
    assert.equal(precious(), "keep");
  } finally { dropLink(at); }
});
test("a child directory on another volume (dev mismatch) fails closed before anything is deleted", () => {
  const a = file("xv", "a.txt"); const b = file("xv", "sub", "b.txt");
  const sub = path.join(root, "xv", "sub");
  const lstat = p => { const st = fs.lstatSync(p); return p === sub ? new Proxy(st, { get: (o, k) => k === "dev" ? o.dev + 1 : (typeof o[k] === "function" ? o[k].bind(o) : o[k]) }) : st; };
  assert.throws(() => removeTreeGuarded(path.join(root, "xv"), check, { lstat }), { code: "CROSS_VOLUME" });
  assert.ok(fs.existsSync(a) && fs.existsSync(b), "nothing deleted");
});
test("a child directory whose realpath differs from its path (alias) fails closed", () => {
  const a = file("al", "a.txt"); file("al", "sub", "b.txt");
  const sub = path.join(root, "al", "sub");
  const realpath = p => p === sub ? victim : fs.realpathSync.native(p);
  assert.throws(() => removeTreeGuarded(path.join(root, "al"), check, { realpath }), { code: "ALIAS" });
  assert.ok(fs.existsSync(a));
});
test("a protected item nested in the tree aborts in the validation pass, before any delete (GUARDED)", () => {
  const a = file("gd", "a.txt"); const keep = file("gd", "sub", "keep.txt");
  assert.throws(() => removeTreeGuarded(path.join(root, "gd"), { ...check, protectedPaths: [keep] }), { code: "GUARDED" });
  assert.ok(fs.existsSync(a) && fs.existsSync(keep), "nothing deleted");
  assert.throws(() => removeTreeGuarded(path.join(root, "gd"), { ...check, livePaths: [path.join(root, "gd", "sub")] }), { code: "GUARDED" });
  assert.ok(fs.existsSync(a));
});
test("skipped items report the resolved path form like deleted ones", () => {
  const f = file("rp.txt");
  const r = removeItem(f.toUpperCase(), { ...check, protectedPaths: [f] });
  assert.equal(r.status, "skipped"); assert.equal(r.path, path.resolve(f.toUpperCase()));
});
test.after(() => {
  // never recurse through a link left behind by a failed test
  for (const n of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const p = path.join(root, n);
    try { if (fs.lstatSync(p).isSymbolicLink()) dropLink(p); } catch { /* ignore */ }
  }
  fs.rmSync(t, { recursive: true, force: true });
});
