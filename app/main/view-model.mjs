// app/main/view-model.mjs
// Main-side view model for the results dialog. Pure: no I/O, no electron import.
// The renderer only ever receives sanitised display strings and finding ids, never raw paths.
//
// IDs: finding ids are 16 lowercase hex characters (lib/confidence.mjs findingId). They are NEVER passed
// through displayText (that would silently alter them and the renderer would send back an id main does not
// know). A row whose id (or companionOf) is not a valid id is dropped: fail closed.

// One plain line shown above the Browsers cleaner results.
export const BROWSERS_HELP = "Browser cache is safe to remove: your pages just load a little slower the first time afterwards. Browsing history is optional and is never ticked for you. Bookmarks, saved passwords and cookies are never listed.";
export const PERMANENT_NOTICE = "Deleting is permanent. A restore point does not bring back your own files.";

const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu; // control, format (bidi, zero-width), lone surrogates, line/paragraph separators
const ID_RE = /^[0-9a-f]{16}$/;

// Slice to at most n UTF-16 units without leaving half of a surrogate pair at the end.
function clip(s, n) {
  if (s.length <= n) return s;
  let end = n;
  const c = s.charCodeAt(end - 1);
  if (end > 0 && c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

/** One-line, capped, printable display text for untrusted strings. */
export function displayText(s, max = 200) {
  let str;
  try { str = String(s ?? ""); } catch { str = ""; }
  const cap = Number.isInteger(max) && max >= 0 ? max : 200;
  // Clip first so a multi-megabyte name costs little; the cap is applied again after collapsing.
  const clean = clip(str, cap * 4 + 64).replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  return clean.length > cap ? clip(clean, cap) + "..." : clean;
}

const nameText = (s, max) => displayText(s, max) || "(unnamed)";

const UNITS = ["KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

/** Human size. "unknown" for null / non-finite / negative / non-number. Keep identical to the copy in
 *  app/renderer/results.js (a test asserts both agree). */
export function fmtBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "unknown";
  let v = n;
  let i = -1; // -1 = bytes
  for (;;) {
    const r = i < 0 || v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
    if (r >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; continue; } // rounds up to the next unit
    if (i === UNITS.length - 1 && r >= 1000) return "over 1000 " + UNITS[i];
    return r + " " + (i < 0 ? "B" : UNITS[i]);
  }
}

// Names of the other programs that also use an item: sanitised, capped in count and length.
const sharedNames = (v) => (Array.isArray(v) ? v.slice(0, 10).map((s) => displayText(s, 80)).filter(Boolean) : []);
// Smart Scan findings use their own path as the label; the location category ("Temporary files") is the better name.
// Investigate findings carry slug categories, so their labels stay as they are.
const smartName = (f, kind) => (kind !== "investigate" && typeof f.category === "string" && f.category !== "" && f.label === f.path ? f.category : f.label);

const itemsOf = (r) => (r && Array.isArray(r.items) ? r.items : []);
const normBytes = (b) => (typeof b === "number" && Number.isFinite(b) && b >= 0 ? b : null);

/** Compare two scans by finding id. removed carries sanitised labels only. */
export function diffScans(prev, next) {
  const before = new Map(itemsOf(prev).map((f) => [f.id, f]));
  const after = new Map(itemsOf(next).map((f) => [f.id, f]));
  const added = [];
  const removed = [];
  const resized = [];
  for (const [id, f] of after) {
    const old = before.get(id);
    if (!old) added.push(id);
    else if (normBytes(old.bytes) !== normBytes(f.bytes)) resized.push({ id, before: normBytes(old.bytes), after: normBytes(f.bytes) });
  }
  for (const [id, f] of before) if (!after.has(id)) removed.push({ id, label: nameText(f.label) });
  return { added, removed, resized };
}

function titleFor(result) {
  if (result && result.kind === "investigate") {
    const t = result.target ? displayText(result.target, 80) : "";
    return t ? "Found for " + t : "Found for the item you picked";
  }
  if (result && result.kind === "startup") return "Programs that start with Windows";
  if (result && result.kind === "browsers") return "Browser leftovers";
  return "Smart Scan results";
}

export function toView(result, diff = null) {
  const items = itemsOf(result);
  const addedIds = new Set(diff && Array.isArray(diff.added) ? diff.added : []);
  const resizedIds = new Set(diff && Array.isArray(diff.resized) ? diff.resized.map((r) => r && r.id) : []);
  const rows = [];
  for (const f of items) {
    if (!f || typeof f.id !== "string" || !ID_RE.test(f.id)) continue;
    const hasParent = f.companionOf !== undefined;
    if (hasParent && (typeof f.companionOf !== "string" || !ID_RE.test(f.companionOf))) continue;
    const bytes = normBytes(f.bytes);
    const selectable = f.selectable === true;
    rows.push({
      id: f.id,
      label: nameText(smartName(f, result && result.kind)),
      reason: displayText(f.reason, 300),
      sharedWith: sharedNames(f.sharedWith),
      path: f.path == null ? "" : displayText(f.path, 260),
      size: fmtBytes(f.bytes),
      bytes,
      kind: displayText(f.kind, 16),
      group: displayText(f.group, 32),
      category: displayText(f.category, 40),
      confidence: f.confidence == null ? "" : displayText(f.confidence, 16),
      ticked: selectable && f.preTicked === true && f.confidence === "high",
      selectable,
      badge: addedIds.has(f.id) ? "new" : resizedIds.has(f.id) ? "resized" : "",
      companionOf: hasParent ? f.companionOf : "",
    });
  }
  let selectedBytes = 0;
  let count = 0;
  for (const r of rows) if (r.ticked) { count++; selectedBytes += r.bytes ?? 0; }
  const adminExtra = result && Number.isFinite(result.adminExtraBytes) && result.adminExtraBytes > 0
    ? fmtBytes(result.adminExtraBytes) : null;
  const notes = result && Array.isArray(result.notes) ? result.notes.map((n) => displayText(n, 300)) : [];
  if (result && result.partial === true) notes.unshift("Partial scan: some places were not fully checked, so they are not offered.");
  return {
    title: titleFor(result),
    scanKind: result && result.kind === "investigate" ? "investigate" : result && result.kind === "startup" ? "startup" : result && result.kind === "browsers" ? "browsers" : "smart",
    help: result && result.kind === "browsers" ? BROWSERS_HELP : "",
    rows,
    removed: diff && Array.isArray(diff.removed) ? diff.removed.map((r) => nameText(r && r.label)) : [],
    notes,
    totals: { selectedBytes, count },
    adminExtra,
    permanentNotice: PERMANENT_NOTICE,
  };
}
