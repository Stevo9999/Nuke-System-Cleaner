import { createHash } from "node:crypto";
import { classify } from "./classify.mjs";

// Group mapping, confidence rating, pre-tick rule and finding ids.
// Pure: no I/O, no process spawns. Unknown input fails closed to "protected".

const GROUPS = new Set(["exclusive", "shared", "protected", "report-only"]);
const KINDS = new Set(["file", "dir", "entry", "service", "task", "startup"]);
const REPORT_ONLY_KINDS = new Set(["entry", "service", "task", "startup"]);

// Known evidence bases. vetted/traced can reach high; name -> medium; fuzzy -> low.
// Any other value (including undefined) fails closed to protected.
export const BASES = Object.freeze(["vetted", "traced", "name", "fuzzy"]);

export function groupFor(input) {
  const { safe, reportOnly } = input || {};
  const sharedWith = input && input.sharedWith === undefined ? [] : input?.sharedWith;
  if (reportOnly === true) return "report-only";
  if (reportOnly !== undefined && reportOnly !== false) return "protected";
  const g = classify({ safe, isLive: false, sharedWith }).group;
  return GROUPS.has(g) ? g : "protected";
}

export function rate(input) {
  const { group, basis, oldEnough, locked, entryGone, userPicked } = input || {};
  if ((group === "exclusive" || group === "shared") && BASES.includes(basis)) {
    let confidence;
    if (group === "shared") {
      confidence = basis === "fuzzy" ? "low" : "medium";
    } else if (basis === "fuzzy") {
      confidence = "low";
    } else if (basis === "vetted") {
      confidence = oldEnough === true && locked === false ? "high" : "medium";
    } else if (basis === "traced") {
      confidence = entryGone === true || userPicked === true ? "high" : "medium";
    } else {
      confidence = "medium"; // name
    }
    return { confidence, preTicked: confidence === "high", selectable: true };
  }
  // protected, report-only, unknown basis, and anything unrecognised: never selectable
  return { confidence: null, preTicked: false, selectable: false };
}

export function findingId(kind, key) {
  return createHash("sha1")
    .update(String(kind) + ":" + (key == null ? "" : String(key)).toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

// fields.idKey: stable identity for findings without a path (e.g. "HKCU-Run:Foo").
// Pathless kinds (entry/service/task/startup) should always supply it; otherwise the label is used.
export function makeFinding(fields) {
  const f = fields || {};
  const kindKnown = KINDS.has(f.kind);
  const kind = kindKnown ? f.kind : "entry";
  const path = typeof f.path === "string" && f.path.length > 0 ? f.path : null;
  const label = typeof f.label === "string" ? f.label : path ?? "";

  let group;
  if (!kindKnown) group = "protected";
  else if (REPORT_ONLY_KINDS.has(kind)) group = "report-only";
  else if (path === null) group = "protected";
  else group = groupFor({ safe: f.safe, sharedWith: f.sharedWith, reportOnly: f.reportOnly });
  if ((group === "exclusive" || group === "shared") && !BASES.includes(f.basis)) group = "protected";

  const r = rate({
    group,
    basis: f.basis,
    oldEnough: f.oldEnough,
    locked: f.locked,
    entryGone: f.entryGone,
    userPicked: f.userPicked,
  });
  const sharedWith = Array.isArray(f.sharedWith) ? f.sharedWith.filter((x) => typeof x === "string") : [];
  const idKey = typeof f.idKey === "string" && f.idKey.length > 0 ? f.idKey : path ?? label;
  const finding = {
    id: findingId(kind, idKey),
    kind,
    path,
    label,
    bytes: Number.isFinite(f.bytes) && f.bytes >= 0 ? f.bytes : null,
    group,
    sharedWith: Object.freeze(sharedWith),
    confidence: r.confidence,
    preTicked: r.preTicked,
    selectable: r.selectable,
    reason: typeof f.reason === "string" ? f.reason : "",
    category: typeof f.category === "string" ? f.category : "",
  };
  if (typeof f.companionOf === "string") finding.companionOf = f.companionOf;
  return Object.freeze(finding);
}
