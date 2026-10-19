import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { groupFor, rate, findingId, makeFinding, BASES } from "../lib/confidence.mjs";

const OK = { ok: true };

test("only high is pre-ticked; shared is never high", () => {
  const groups = ["exclusive", "shared", "protected", "report-only"];
  const bases = ["vetted", "traced", "name", "fuzzy"];
  let n = 0;
  for (const group of groups) for (const basis of bases) {
    const r = rate({ group, basis, oldEnough: true, locked: false, entryGone: true, userPicked: true });
    n++;
    assert.equal(r.preTicked, r.confidence === "high", `${group}/${basis}`);
    if (group === "shared") {
      assert.notEqual(r.confidence, "high");
      assert.equal(r.confidence, basis === "fuzzy" ? "low" : "medium");
    }
    if (group === "exclusive") {
      const want = { vetted: "high", traced: "high", name: "medium", fuzzy: "low" }[basis];
      assert.equal(r.confidence, want);
    }
    assert.equal(r.selectable, group === "exclusive" || group === "shared");
  }
  assert.equal(n, 16);
  assert.equal(rate({ group: "exclusive", basis: "vetted", oldEnough: false, locked: false }).confidence, "medium");
  assert.equal(rate({ group: "exclusive", basis: "vetted", oldEnough: true, locked: true }).preTicked, false);
  assert.equal(rate({ group: "exclusive", basis: "traced", entryGone: false, userPicked: false }).confidence, "medium");
  assert.equal(rate({ group: "exclusive", basis: "traced", entryGone: false, userPicked: true }).confidence, "high");
});

test("vetted needs oldEnough===true and locked===false; 'true'/undefined fall to medium", () => {
  const base = { group: "exclusive", basis: "vetted" };
  for (const [oldEnough, locked] of [
    ["true", false], [true, "false"], [undefined, false], [true, undefined],
    [1, false], [true, 0], [null, false], [true, null],
  ]) {
    const r = rate({ ...base, oldEnough, locked });
    assert.equal(r.confidence, "medium", JSON.stringify([oldEnough, locked]));
    assert.equal(r.preTicked, false);
  }
  assert.equal(rate({ ...base, oldEnough: true, locked: false }).confidence, "high");
});

test("traced needs entryGone or userPicked", () => {
  const base = { group: "exclusive", basis: "traced" };
  assert.equal(rate({ ...base, entryGone: true }).confidence, "high");
  assert.equal(rate({ ...base, userPicked: true }).confidence, "high");
  assert.equal(rate({ ...base }).confidence, "medium");
  assert.equal(rate({ ...base, entryGone: "true", userPicked: 1 }).confidence, "medium");
  assert.equal(rate({ ...base, entryGone: false, userPicked: false }).confidence, "medium");
});

test("protected and report-only are never selectable, confidence null", () => {
  for (const group of ["protected", "report-only", "live", "bogus", undefined]) {
    const r = rate({ group, basis: "vetted", oldEnough: true, locked: false, entryGone: true, userPicked: true });
    assert.deepEqual(r, { confidence: null, preTicked: false, selectable: false });
  }
  assert.deepEqual(rate(undefined), { confidence: null, preTicked: false, selectable: false });
  const f = makeFinding({ kind: "service", label: "svc", reportOnly: true, safe: OK, basis: "vetted", oldEnough: true, locked: false });
  assert.equal(f.group, "report-only");
  assert.equal(f.confidence, null);
  assert.equal(f.selectable, false);
  assert.equal(f.preTicked, false);
});

test("groupFor: unknown input fails closed to protected", () => {
  assert.equal(groupFor({ safe: OK }), "exclusive");
  assert.equal(groupFor({ safe: OK, sharedWith: ["a"] }), "shared");
  assert.equal(groupFor({ safe: OK, reportOnly: true }), "report-only");
  assert.equal(groupFor({ safe: { ok: false, reason: "x" } }), "protected");
  assert.equal(groupFor({}), "protected");
  assert.equal(groupFor(undefined), "protected");
  assert.equal(groupFor({ safe: OK, sharedWith: "a" }), "protected");
  assert.equal(groupFor({ safe: OK, sharedWith: [""] }), "protected");
  assert.equal(groupFor({ safe: OK, sharedWith: [1] }), "protected");
  assert.equal(groupFor({ safe: { ok: "yes" } }), "protected");
  assert.equal(groupFor({ safe: OK, reportOnly: "true" }), "protected");
});

test("findingId is 16 hex, case-insensitive on the key, differs by kind, equals sha1(kind+':'+key.toLowerCase()).slice(0,16)", () => {
  const id = findingId("dir", "C:\\Users\\Bob\\AppData\\Local\\Temp");
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, findingId("dir", "c:\\users\\bob\\appdata\\local\\TEMP"));
  assert.notEqual(id, findingId("file", "C:\\Users\\Bob\\AppData\\Local\\Temp"));
  assert.notEqual(id, findingId("dir", "C:\\Users\\Bob\\AppData\\Local\\Temp2"));
  assert.equal(id, createHash("sha1").update("dir:c:\\users\\bob\\appdata\\local\\temp").digest("hex").slice(0, 16));
});

test("makeFinding fills fields, is frozen, ids stable and path-derived", () => {
  const mk = (p) => makeFinding({ kind: "dir", path: p, label: "Temp", bytes: 5, safe: OK, basis: "vetted", oldEnough: true, locked: false, reason: "r", category: "temp" });
  const a = mk("C:\\X\\Temp");
  assert.deepEqual(Object.keys(a).sort(), ["bytes", "category", "confidence", "group", "id", "kind", "label", "path", "preTicked", "reason", "selectable", "sharedWith"]);
  assert.equal(a.confidence, "high");
  assert.equal(a.preTicked, true);
  assert.equal(a.id, mk("c:\\x\\TEMP").id);
  assert.notEqual(a.id, mk("C:\\X\\Temp2").id);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.sharedWith));
  assert.throws(() => { a.preTicked = false; }, TypeError);
  const c = makeFinding({ kind: "file", path: "C:\\a", companionOf: "abc", safe: OK, sharedWith: ["P"], basis: "vetted", oldEnough: true, locked: false });
  assert.equal(c.group, "shared");
  assert.equal(c.confidence, "medium");
  assert.equal(c.companionOf, "abc");
  const bad = makeFinding({});
  assert.equal(bad.group, "protected");
  assert.equal(bad.selectable, false);
  assert.match(bad.id, /^[0-9a-f]{16}$/);
});

test("fix1: makeFinding fails closed on garbage sharedWith / reportOnly", () => {
  const base = { kind: "dir", path: "C:\\x", safe: OK, basis: "vetted", oldEnough: true, locked: false };
  for (const sharedWith of [null, "a", {}, 5, [""], [1]]) {
    const f = makeFinding({ ...base, sharedWith });
    assert.equal(f.group, "protected", JSON.stringify(sharedWith));
    assert.equal(f.selectable, false);
    assert.equal(f.preTicked, false);
    assert.equal(f.confidence, null);
  }
  assert.equal(makeFinding(base).group, "exclusive");
  for (const reportOnly of ["true", 1, null, {}, "false"]) {
    const f = makeFinding({ ...base, reportOnly });
    assert.equal(f.group, "protected", String(reportOnly));
    assert.equal(f.selectable, false);
  }
  assert.equal(makeFinding({ ...base, reportOnly: false }).group, "exclusive");
});

test("fix1: report-only kinds are never selectable; unknown kind and empty path are protected", () => {
  for (const kind of ["service", "task", "startup", "entry"]) {
    const f = makeFinding({ kind, label: "x", safe: OK, basis: "vetted", oldEnough: true, locked: false, entryGone: true, reportOnly: false });
    assert.equal(f.group, "report-only", kind);
    assert.equal(f.selectable, false);
    assert.equal(f.preTicked, false);
    assert.equal(f.confidence, null);
  }
  const mk = (o) => makeFinding({ safe: OK, basis: "vetted", oldEnough: true, locked: false, ...o });
  for (const kind of ["bogus", undefined, null, 5]) {
    const f = mk({ kind, path: "C:\\x" });
    assert.equal(f.group, "protected");
    assert.equal(f.selectable, false);
  }
  for (const kind of ["file", "dir"]) for (const path of ["", null, undefined, 5]) {
    const f = mk({ kind, path, label: "l" });
    assert.equal(f.group, "protected", `${kind}/${path}`);
    assert.equal(f.selectable, false);
    assert.equal(f.path, null);
  }
});

test("fix1: unknown basis is protected; known low basis stays selectable", () => {
  const base = { kind: "dir", path: "C:\\x", safe: OK };
  for (const basis of ["vettted", "", undefined, null, 1, "FUZZY"]) {
    const f = makeFinding({ ...base, basis, oldEnough: true, locked: false });
    assert.equal(f.group, "protected", String(basis));
    assert.equal(f.selectable, false);
    assert.equal(f.confidence, null);
  }
  assert.deepEqual(rate({ group: "exclusive", basis: "nope" }), { confidence: null, preTicked: false, selectable: false });
  const low = makeFinding({ ...base, basis: "fuzzy" });
  assert.equal(low.confidence, "low");
  assert.equal(low.selectable, true);
  assert.deepEqual([...BASES], ["vetted", "traced", "name", "fuzzy"]);
});

test("fix1: ids - empty path is missing, idKey separates pathless collisions, no 'undefined'", () => {
  const a = makeFinding({ kind: "startup", label: "Updater", idKey: "HKCU-Run:Updater" });
  const b = makeFinding({ kind: "startup", label: "Updater", idKey: "HKLM-Run:Updater" });
  const c = makeFinding({ kind: "startup", label: "Updater" });
  const d = makeFinding({ kind: "startup", label: "Updater" });
  assert.notEqual(a.id, b.id);
  assert.equal(c.id, d.id);
  assert.equal(c.id, findingId("startup", "Updater"));
  assert.equal(makeFinding({ kind: "entry", label: "L", path: "" }).path, null);
  assert.equal(makeFinding({ kind: "entry", label: "L", path: "" }).id, findingId("entry", "L"));
  assert.notEqual(makeFinding({}).id, findingId("entry", "undefined"));
  assert.equal(findingId("dir", undefined), findingId("dir", ""));
});

test("fix1: bytes must be finite and >= 0 else null", () => {
  const mk = (bytes) => makeFinding({ kind: "dir", path: "C:\\x", safe: OK, basis: "name", bytes }).bytes;
  assert.equal(mk(-1), null);
  assert.equal(mk(NaN), null);
  assert.equal(mk(Infinity), null);
  assert.equal(mk("5"), null);
  assert.equal(mk(0), 0);
  assert.equal(mk(12), 12);
});
