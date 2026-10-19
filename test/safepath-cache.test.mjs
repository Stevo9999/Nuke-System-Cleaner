// Regression: checkPath must not re-resolve every option path (allowed roots, protected, live) on disk for every item.
// (In the real app that was tens of thousands of realpath calls: 4000 items took minutes and froze the window.)
// The candidate itself is still examined fresh on every call, and a changed option folder is noticed after the short TTL.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPath, OPTION_FORMS_TTL_MS } from "../lib/safepath.mjs";

function setup() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nuke-spc-")));
  const files = [];
  for (let i = 0; i < 30; i++) { const p = path.join(root, "junk", "f" + i); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x"); files.push(p); }
  const prot = [];
  for (let i = 0; i < 6; i++) { const d = path.join(root, "prot" + i + "-" + Math.random().toString(36).slice(2)); fs.mkdirSync(d); prot.push(d); }
  return { root, files, prot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("option paths are resolved on disk about once, not once per checked item; candidates are still checked every time", t => {
  const s = setup();
  try {
    const opts = { allowedRoots: [path.join(s.root, "junk")], protectedPaths: s.prot, livePaths: [] };
    checkPath(s.files[0], opts); // warm-up (also lets the cache expire from earlier tests' identical paths: these are unique)
    const optionSet = new Set([...opts.allowedRoots, ...s.prot].map(p => p.toLowerCase()));
    let optionCalls = 0, candidateCalls = 0;
    const real = fs.realpathSync.native;
    t.mock.method(fs.realpathSync, "native", (p, ...rest) => {
      if (optionSet.has(String(p).toLowerCase())) optionCalls++; else candidateCalls++;
      return real(p, ...rest);
    });
    for (const f of s.files) assert.equal(checkPath(f, opts).ok, true);
    assert.ok(optionCalls <= optionSet.size, "option paths resolved at most once each over 30 checks, saw " + optionCalls);
    assert.ok(candidateCalls >= s.files.length, "every candidate still gets its own realpath check (" + candidateCalls + ")");
    // a protected folder is still enforced
    assert.equal(checkPath(s.prot[0], opts).ok, false);
  } finally { s.cleanup(); }
});

test("after the short TTL the option paths are looked at again", t => {
  const s = setup();
  try {
    const opts = { allowedRoots: [path.join(s.root, "junk")], protectedPaths: s.prot, livePaths: [] };
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    checkPath(s.files[0], opts);
    const real = fs.realpathSync.native;
    let optionCalls = 0;
    t.mock.method(fs.realpathSync, "native", (p, ...rest) => { if (String(p).toLowerCase() === s.prot[1].toLowerCase()) optionCalls++; return real(p, ...rest); });
    checkPath(s.files[1], opts);
    assert.equal(optionCalls, 0, "within the TTL: remembered");
    t.mock.timers.tick(OPTION_FORMS_TTL_MS + 1);
    checkPath(s.files[2], opts);
    assert.ok(optionCalls >= 1, "after the TTL: resolved again");
  } finally { t.mock.timers.reset(); s.cleanup(); }
});
