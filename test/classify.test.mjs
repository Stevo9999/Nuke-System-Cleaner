import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classify } from "../lib/classify.mjs";
import { dirSize } from "../lib/sizes.mjs";

test("live wins over everything", () => {
  assert.equal(classify({ safe: { ok: true }, isLive: true, sharedWith: ["B"] }).group, "live");
  assert.equal(classify({ safe: { ok: false, reason: "x" }, isLive: true, sharedWith: [] }).group, "live");
});
test("unsafe is protected with the safepath reason", () => {
  const r = classify({ safe: { ok: false, reason: "drive root" }, isLive: false, sharedWith: [] });
  assert.deepEqual(r, { group: "protected", reason: "drive root" });
});
test("shared names the other sessions; otherwise exclusive", () => {
  assert.deepEqual(classify({ safe: { ok: true }, isLive: false, sharedWith: ["B", "C"] }), { group: "shared", reason: "also used by B, C" });
  assert.equal(classify({ safe: { ok: true }, isLive: false, sharedWith: [] }).group, "exclusive");
});
test("missing or malformed input fails closed to protected", () => {
  assert.equal(classify({}).group, "protected");
  assert.equal(classify({ safe: { ok: true }, isLive: false, sharedWith: "oops" }).group, "protected");
});
test("missing or non-boolean isLive fails closed", () => {
  const r = { group: "protected", reason: "unknown liveness" };
  assert.deepEqual(classify({ safe: { ok: true }, sharedWith: [] }), r);
  for (const v of ["true", 1, null, undefined, {}]) {
    assert.deepEqual(classify({ safe: { ok: true }, isLive: v, sharedWith: [] }), r);
  }
});
test("malformed sharedWith elements fail closed without throwing", () => {
  const r = { group: "protected", reason: "unknown ties" };
  for (const arr of [[null], [""], [{}], ["B", 5], [Symbol("s")], ["B", Symbol("s")]]) {
    assert.deepEqual(classify({ safe: { ok: true }, isLive: false, sharedWith: arr }), r);
  }
});
test("dirSize counts files and does not follow links", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "sz-"));
  try {
  const real = path.join(t, "real"); fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, "a"), Buffer.alloc(1000));
  const dir = path.join(t, "d"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "b"), Buffer.alloc(500));
  try { fs.symlinkSync(real, path.join(dir, "ln"), "junction"); } catch {}
  if (process.platform === "win32") {
    assert.ok(fs.lstatSync(path.join(dir, "ln")).isSymbolicLink(), "junction was not created; link case untested");
  }
  assert.equal(dirSize(dir), 500);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
