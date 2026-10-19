// test/safepath.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkPath } from "../lib/safepath.mjs";

const WIN = process.platform === "win32";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safepath-"));
const root = path.join(tmp, "work");
const victim = path.join(tmp, "victim");
fs.mkdirSync(root); fs.mkdirSync(victim);
fs.writeFileSync(path.join(root, "ok.txt"), "x");
fs.writeFileSync(path.join(victim, "precious.txt"), "keep");
fs.mkdirSync(path.join(root, "sub")); fs.writeFileSync(path.join(root, "sub", "a.txt"), "x");

function link(target, at) {
  if (WIN) execFileSync("cmd", ["/c", "mklink", "/J", at, target], { stdio: "ignore" });
  else fs.symlinkSync(target, at, "dir");
}
link(victim, path.join(root, "evil-link"));
// fixtures for C1/C2
fs.mkdirSync(path.join(root, "a")); fs.mkdirSync(path.join(root, "a", "..keep"));
fs.mkdirSync(path.join(root, "b")); fs.mkdirSync(path.join(root, "b", "precious"));
link(root, path.join(tmp, "alias"));
const opts = { allowedRoots: [root] };
const bad = (p, reason, o = opts) => { const r = checkPath(p, o); assert.equal(r.ok, false, `should refuse ${p}: ${JSON.stringify(r)}`); assert.ok(r.reason.includes(reason), `reason "${r.reason}" should include "${reason}" for ${p}`); return r.reason; };

test("accepts a normal file and folder inside a root", () => {
  assert.equal(checkPath(path.join(root, "ok.txt"), opts).ok, true);
  const d = checkPath(path.join(root, "sub"), opts);
  assert.equal(d.ok, true); assert.equal(d.isDir, true);
});
test("refuses non-strings, empty, NUL, relative", () => {
  bad(undefined, "not a path"); bad("", "not a path"); bad(path.join(root, "ok.txt") + "\0.png", "NUL"); bad("ok.txt", "not absolute");
});
test("refuses parent segments even if they resolve inside", () => {
  bad(root + path.sep + "sub" + path.sep + ".." + path.sep + "ok.txt", "parent segment"); // concatenated: path.join would normalize the ".." away
  bad(root + path.sep + ".." + path.sep + "victim" + path.sep + "precious.txt", "parent segment");
});
test("refuses the root itself, drive root, home folder, and outside roots", () => {
  bad(root, "outside allowed roots");
  bad(path.parse(root).root, "drive root");
  bad(os.homedir(), "home folder");
  bad(path.join(victim, "precious.txt"), "outside allowed roots");
});
test("refuses a junction/symlink and anything reached through one", () => {
  bad(path.join(root, "evil-link"), "symlink or junction");
  bad(path.join(root, "evil-link", "precious.txt"), "link or alias");
});
test("refuses protected and live paths, and folders that contain them", () => {
  bad(path.join(root, "ok.txt"), "protected", { ...opts, protectedPaths: [path.join(root, "ok.txt")] });
  bad(path.join(root, "ok.txt"), "live session", { ...opts, livePaths: [path.join(root, "ok.txt")] });
  bad(path.join(root, "sub"), "protected", { ...opts, protectedPaths: [path.join(root, "sub", "a.txt")] });
});
test("C1: a child named ..keep is still inside its parent", () => {
  bad(path.join(root, "a"), "protected", { ...opts, protectedPaths: [path.join(root, "a", "..keep")] });
  bad(path.join(root, "a"), "live session", { ...opts, livePaths: [path.join(root, "a", "..keep")] });
});
test("C2: protected/live entries are canonicalised through junctions", () => {
  const viaAlias = path.join(tmp, "alias", "b", "precious");
  bad(path.join(root, "b"), "protected", { ...opts, protectedPaths: [viaAlias] });
  bad(path.join(root, "b"), "live session", { ...opts, livePaths: [viaAlias] });
  // entry that does not exist yet: nearest existing parent is canonicalised
  bad(path.join(root, "b"), "protected", { ...opts, protectedPaths: [path.join(tmp, "alias", "b", "not-yet", "x")] });
  // an allowed root given through an alias still protects/refuses correctly
  bad(path.join(root, "b"), "protected", { allowedRoots: [path.join(tmp, "alias")], protectedPaths: [path.join(root, "b", "precious")] });
});
test("I3: allowedRoots must be non-empty absolute strings", () => {
  const f = path.join(root, "ok.txt");
  for (const ar of [[""], [], ["relative"], [5], undefined, "x"]) bad(f, "bad options", { allowedRoots: ar });
  bad(f, "bad options", { allowedRoots: [root, ""] });
});
test("I4: never throws on bad options", () => {
  const f = path.join(root, "ok.txt");
  for (const o of [null, {}, 5, { allowedRoots: [root], protectedPaths: [5] }, { allowedRoots: [root], livePaths: [null] },
    { allowedRoots: [root], protectedPaths: "str" }, { allowedRoots: [root], livePaths: [""] }])
    bad(f, "bad options", o);
  assert.deepEqual(checkPath(f), { ok: false, reason: "bad options" }); // opts omitted entirely
  assert.equal(checkPath(undefined, null).ok, false);
});
test("I5: system dirs refused even if env vars are missing", { skip: !WIN }, () => {
  const keys = ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    bad("C:\\Windows\\System32\\drivers\\etc\\hosts", "system folder", { allowedRoots: ["C:\\Windows"] });
    bad("C:\\Program Files\\Common Files", "system folder", { allowedRoots: ["C:\\Program Files"] });
  } finally { for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k]; }
});
test("refuses missing files, trailing dot or space", () => {
  bad(path.join(root, "nope.txt"), "does not exist");
  bad(path.join(root, "ok.txt") + ".", "trailing");
  bad(path.join(root, "ok.txt") + " ", "trailing");
});
test("windows-only: ADS, UNC, device paths", { skip: !WIN }, () => {
  bad(path.join(root, "ok.txt") + ":hidden", "alternate data stream");
  bad("\\\\server\\share\\x.txt", "UNC");
  bad("\\\\?\\" + path.join(root, "ok.txt"), "UNC");
  bad("//server/share/x.txt", "UNC");
  bad("//?/" + root.replace(/\\/g, "/") + "/ok.txt", "UNC");
});
test("refuses system folders", { skip: !WIN }, () => {
  bad(path.join(process.env.SystemRoot, "System32", "drivers", "etc", "hosts"), "system folder", { allowedRoots: [process.env.SystemRoot] });
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
