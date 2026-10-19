// Results dialog. Receives a sanitised view from the main process (labels, display paths, ids) and
// sends back item ids only. Built with createElement/textContent; no HTML strings, no network.
// Pure helpers are exported and need no DOM; the dialog mounts itself only when a document and window.nuke exist.

// Copy of app/main/view-model.mjs fmtBytes (the renderer can only load app://ui/ files); a test asserts both agree.
const UNITS = ["KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
export function fmtBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "unknown";
  let v = n;
  let i = -1;
  for (;;) {
    const r = i < 0 || v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
    if (r >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; continue; }
    if (i === UNITS.length - 1 && r >= 1000) return "over 1000 " + UNITS[i];
    return r + " " + (i < 0 ? "B" : UNITS[i]);
  }
}

// Copy of IDENTITY_UNKNOWN_MESSAGE in app/main/controller.mjs (a test asserts both agree).
const IDENTITY_UNKNOWN_MESSAGE = "Could not tell whether this app is running as administrator, so deleting is turned off.";

// The delete request is limited to 5000 ids (app/main/ipc.mjs MAX_IDS). More ticks than that would be refused, so the
// dialog says so and keeps Delete off instead of ending in a generic failure.
export const MAX_TICKED = 5000;
export const TOO_MANY_MESSAGE = "You can tick at most 5000 items at a time; run the cleanup again for the rest";

const rowsOf = (view) => (view && Array.isArray(view.rows) ? view.rows : []);
const GROUP_TEXT = { exclusive: "Only used by this", shared: "Shared with other programs", protected: "Protected" };
const SURE_TEXT = { high: "Very sure", medium: "Fairly sure", low: "Not sure" };
const STARTUP_HELP = "View only: this app does not change start-up programs. To switch one off, press Ctrl+Shift+Esc, open Startup apps and turn it off.";
/**
 * Table order. key: "name" | "size" | "group" | "sure" | "change"; dir: "asc" | "desc". Rows without a size always go last for
 * "size"; ties are broken by name so the order is stable. Returns a new array (the view's own order is never changed).
 */
const SURE_RANK = { high: 3, medium: 2, low: 1 };
export const SORT_KEYS = ["name", "size", "group", "sure", "change"];
export function sortRows(rows, key, dir) {
  const sign = dir === "asc" ? 1 : -1;
  const text = (r) => String(r.label || "").toLowerCase();
  const byName = (a, b) => text(a).localeCompare(text(b), "en", { numeric: true });
  const groupOf = (r) => String(typeof r.category === "string" && r.category ? r.category : GROUP_TEXT[r.group] || r.group || "").toLowerCase();
  const changeOf = (r) => (r.badge === "new" ? 2 : r.badge === "resized" ? 1 : 0);
  const num = (r) => (typeof r.bytes === "number" && Number.isFinite(r.bytes) ? r.bytes : null);
  const cmp = (a, b) => {
    if (key === "size") {
      const x = num(a), y = num(b);
      if (x === null && y === null) return byName(a, b);
      if (x === null) return 1; // unknown sizes stay at the bottom in either direction
      if (y === null) return -1;
      return x === y ? byName(a, b) : sign * (x - y);
    }
    let d = 0;
    if (key === "name") d = byName(a, b);
    else if (key === "group") d = groupOf(a).localeCompare(groupOf(b), "en");
    else if (key === "sure") d = (SURE_RANK[a.confidence] || 0) - (SURE_RANK[b.confidence] || 0);
    else if (key === "change") d = changeOf(a) - changeOf(b);
    return d === 0 ? byName(a, b) : sign * d;
  };
  return rows.slice().sort(cmp);
}

const isReportOnly = (r) => r.group === "report-only";
const isCompanion = (r) => typeof r.companionOf === "string" && r.companionOf !== "";

/** Rows shown in the main table: not report-only, not companions (those follow their parent). */
export function mainRows(view) {
  return rowsOf(view).filter((r) => !isReportOnly(r) && !isCompanion(r));
}

export function reportRows(view) {
  return rowsOf(view).filter(isReportOnly);
}

/** Initial ticked ids: the view's own ticks, selectable main rows only. */
export function initialTicked(view) {
  return new Set(mainRows(view).filter((r) => r.ticked === true && r.selectable === true).map((r) => r.id));
}

/** Ids to delete: ticked selectable main rows plus the selectable companions of ticked parents. */
export function idsToDelete(view, ticked) {
  const ids = [];
  const parents = new Set();
  for (const r of mainRows(view)) {
    if (r.selectable === true && ticked.has(r.id)) { ids.push(r.id); parents.add(r.id); }
  }
  for (const r of rowsOf(view)) {
    if (isCompanion(r) && !isReportOnly(r) && r.selectable === true && parents.has(r.companionOf)) ids.push(r.id);
  }
  return ids;
}

export function summarize(view, ticked) {
  const chosen = new Set(idsToDelete(view, ticked));
  let bytes = 0;
  for (const r of rowsOf(view)) if (chosen.has(r.id) && typeof r.bytes === "number" && Number.isFinite(r.bytes)) bytes += r.bytes;
  const text = chosen.size === 0 ? "Nothing ticked." : chosen.size + " selected, " + fmtBytes(bytes) + " to free";
  const tooMany = chosen.size > MAX_TICKED;
  return { count: chosen.size, bytes, tooMany, text: tooMany ? text + ". " + TOO_MANY_MESSAGE : text };
}

export function toggle(view, ticked, id, on) {
  const row = mainRows(view).find((r) => r.id === id);
  if (!row || row.selectable !== true) return ticked;
  const next = new Set(ticked);
  if (on) next.add(id); else next.delete(id);
  return next;
}

export function diffLine(view) {
  const rows = rowsOf(view);
  const n = rows.filter((r) => r.badge === "new").length;
  const k = rows.filter((r) => r.badge === "resized").length;
  const m = Array.isArray(view && view.removed) ? view.removed.length : 0;
  return n + " new, " + m + " gone, " + k + " resized";
}

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.setAttribute("class", cls);
  if (text !== undefined) e.textContent = text;
  return e;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(doc, api) {
  const $ = (id) => doc.getElementById(id);
  const tbody = $("rows");
  const deleteBtn = $("delete");
  let view = null;
  let ticked = new Set();
  let manual = new Map(); // id -> true/false, only for boxes the user toggled by hand
  let busy = false;
  let identityUnknown = false;
  let sortKey = "size"; // biggest items first until the user clicks a column heading
  let sortDir = "desc";
  let canRelaunchAdmin = false; // R46: the "more in administrator mode" nudge only shows when relaunch is really offered

  function refreshSummary() {
    if (view && view.scanKind === "startup") { $("summary").textContent = STARTUP_HELP; deleteBtn.disabled = true; return; }
    const s = summarize(view, ticked);
    $("summary").textContent = s.text;
    deleteBtn.disabled = busy || s.count === 0 || s.tooMany || identityUnknown;
    refreshAdmin();
  }

  function refreshAdmin() {
    const admin = $("admin");
    if (view && canRelaunchAdmin && typeof view.adminExtra === "string" && view.adminExtra) {
      admin.textContent = "Could free " + view.adminExtra + " more in administrator mode";
      admin.hidden = false;
    } else {
      admin.textContent = "";
      admin.hidden = true;
    }
  }

  function showError(msg) {
    const e = $("error");
    if (!e) return;
    e.textContent = msg;
    e.hidden = msg === "";
  }

  function render(next, showDiff) {
    if (!next || !Array.isArray(next.rows)) return;
    // Keep the user's manual ticks for ids that were already shown; new ids get their default.
    // Only choices the user made by hand are carried over; everything else follows the new default
    // (so a downgraded or newly protected row never stays ticked on its own).
    view = next;
    ticked = initialTicked(view);
    const keep = new Map();
    for (const r of mainRows(view)) {
      if (r.selectable === true && manual.has(r.id)) {
        keep.set(r.id, manual.get(r.id));
        if (manual.get(r.id)) ticked.add(r.id); else ticked.delete(r.id);
      }
    }
    manual = keep;
    showError(identityUnknown ? IDENTITY_UNKNOWN_MESSAGE : "");
    $("title").textContent = typeof view.title === "string" ? view.title : "Results";
    if (typeof view.permanentNotice === "string" && view.permanentNotice) $("notice").textContent = view.permanentNotice;
    // The Browsers cleaner adds one plain sentence about what is safe (text from the main process, shown as text only).
    const help = $("help");
    if (help) { help.textContent = typeof view.help === "string" ? view.help : ""; help.hidden = help.textContent === ""; }

    const notes = $("notes");
    clear(notes);
    for (const n of Array.isArray(view.notes) ? view.notes : []) notes.appendChild(el(doc, "li", "", String(n)));

    $("diff").textContent = showDiff ? diffLine(view) : "";
    if (showDiff && Array.isArray(view.removed) && view.removed.length > 0) {
      $("diff").textContent = diffLine(view) + " (gone: " + view.removed.join(", ") + ")";
    }

    clear(tbody);
    for (const r of sortRows(mainRows(view), sortKey, sortDir)) {
      const tr = el(doc, "tr", "item");
      const c1 = el(doc, "td");
      const box = doc.createElement("input");
      box.setAttribute("type", "checkbox");
      box.setAttribute("aria-label", "Delete " + r.label);
      box.checked = ticked.has(r.id);
      box.disabled = r.selectable !== true;
      box.addEventListener("change", () => {
        ticked = toggle(view, ticked, r.id, box.checked);
        box.checked = ticked.has(r.id);
        if (r.selectable === true) manual.set(r.id, ticked.has(r.id));
        refreshSummary();
      });
      c1.appendChild(box);
      const c2 = el(doc, "td");
      c2.appendChild(el(doc, "span", "name", r.label));
      if (r.path) c2.appendChild(el(doc, "span", "path", r.path));
      if (Array.isArray(r.sharedWith) && r.sharedWith.length > 0) c2.appendChild(el(doc, "span", "note", "Also used by: " + r.sharedWith.join(", ")));
      if (r.group === "protected" && typeof r.reason === "string" && r.reason) c2.appendChild(el(doc, "span", "note", "Protected: " + r.reason));
      const c3 = el(doc, "td", "size", r.size);
      const c4 = el(doc, "td");
      // Browser findings are named by what they are ("Browser cache" / "Browsing history") instead of who else uses them.
      const groupText = view.scanKind === "browsers" && typeof r.category === "string" && r.category ? r.category : GROUP_TEXT[r.group] || r.group;
      c4.appendChild(el(doc, "span", "badge group", groupText));
      const c5 = el(doc, "td");
      c5.appendChild(el(doc, "span", "badge " + (["high", "medium", "low"].includes(r.confidence) ? r.confidence : "none"), SURE_TEXT[r.confidence] || "Not sure"));
      const c6 = el(doc, "td");
      if (r.badge === "new" || r.badge === "resized") c6.appendChild(el(doc, "span", "badge " + r.badge, r.badge === "resized" ? "Size changed" : "New"));
      for (const c of [c1, c2, c3, c4, c5, c6]) tr.appendChild(c);
      tbody.appendChild(tr);
    }

    // A picked file/folder shows only its files, leftovers and registry entries; services, tasks and start-up items are left out.
    const rep = reportRows(view).filter((r) => view.scanKind !== "investigate" || r.kind === "entry");
    const list = $("report-list");
    clear(list);
    // Say what the list is: group the shown-only rows and head each group with a plain-language label.
    const groups = [
      ["startup", "Programs that start automatically with Windows (listed for your information)"],
      ["dir", "Windows system folders this app can only clean in administrator mode (size shown if readable)"],
      ["outside", "Picked item is outside your user folder, so this app will not delete it (shown only)"],
      ["registry", "Registry entries that belong to this program (shown only for now: this version does not change the registry)"],
      ["other", "Other things related to what you picked: services and scheduled tasks"],
    ];
    const bucket = (r) => (r.kind === "entry" ? "registry" : r.kind === "startup" ? "startup" : view.scanKind === "investigate" && (r.kind === "file" || r.kind === "dir") ? "outside" : r.kind === "dir" ? "dir" : "other");
    for (const [key, heading] of groups) {
      const part = rep.filter((r) => bucket(r) === key);
      if (part.length === 0) continue;
      list.appendChild(el(doc, "li", "grp", heading));
      for (const r of part) list.appendChild(el(doc, "li", "", r.label + (r.size !== "unknown" ? " (" + r.size + ")" : "")));
    }
    const sum = $("report-sum");
    if (sum) sum.textContent = view.scanKind === "investigate"
      ? "Registry entries for what you picked - shown only for now. Click to show."
      : "Also found on this PC - shown only, this app never changes these (programs that start with Windows, system folders). Click to show.";
    const none = $("report-none"), det = $("report-details");
    if (none) { none.textContent = view.scanKind === "investigate" ? "No registry entries found." : "No other items found."; none.hidden = rep.length > 0; }
    if (det) det.hidden = rep.length === 0;
    $("report").hidden = false;

    paintSortHeads();
    refreshSummary();
    if (view.scanKind === "startup") showStartupOnly(rep.length);
  }

  // Start-up programs are view-only: no table, no Delete, and a plain pointer to where Windows lets you switch them off.
  function showStartupOnly(count) {
    const hide = (id, on) => { const n = $(id); if (n) n.hidden = on; };
    hide("found", true); hide("notice", true); hide("d-delete", true);
    const del = $("delete"); if (del && del.parentNode) del.parentNode.hidden = true;
    const sum = $("report-sum"); if (sum) sum.textContent = "Programs that start by themselves when Windows starts (" + count + "). Click to show.";
    const det = $("report-details"); if (det) det.open = true;
    const none = $("report-none"); if (none) { none.textContent = "No start-up programs were found."; none.hidden = count > 0; }
    $("summary").textContent = STARTUP_HELP;
  }

  // Click a column heading to sort by it; click it again to reverse. Size starts biggest-first, the others A to Z.
  const ARROW = { asc: " \u25B2", desc: " \u25BC" };
  const HEAD_TEXT = { name: "Name", size: "Size", group: "Used by", sure: "How sure", change: "Change" };
  function paintSortHeads() {
    for (const k of SORT_KEYS) {
      const b = $("sort-" + k), th = $("th-" + k);
      if (b) b.textContent = HEAD_TEXT[k] + (k === sortKey ? ARROW[sortDir] : "");
      if (th && typeof th.setAttribute === "function") th.setAttribute("aria-sort", k === sortKey ? (sortDir === "asc" ? "ascending" : "descending") : "none");
    }
  }
  for (const k of SORT_KEYS) {
    const b = $("sort-" + k);
    if (!b || typeof b.addEventListener !== "function") continue;
    b.addEventListener("click", () => {
      if (sortKey === k) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortKey = k; sortDir = k === "size" ? "desc" : "asc"; }
      if (view) render(view, false);
    });
  }

  $("cancel").addEventListener("click", () => { api.closeResults(); });
  $("again").addEventListener("click", async () => {
    busy = true;
    refreshSummary();
    try {
      const next = await api.scanAgain();
      if (next && Array.isArray(next.rows)) render(next, true);
    } catch {
      showError("Scan again did not work. Please try again.");
    } finally {
      busy = false;
      if (view) refreshSummary();
    }
  });
  deleteBtn.addEventListener("click", async () => {
    if (busy || !view || identityUnknown) return;
    const ids = idsToDelete(view, ticked);
    if (ids.length === 0 || ids.length > MAX_TICKED) return;
    busy = true;
    refreshSummary();
    try {
      showError("");
      await api.deleteSelected(ids);
    } catch {
      showError("Delete did not complete. Please try again.");
    } finally {
      busy = false;
      refreshSummary();
    }
  });
  // Ruling R44: when the main process could not tell whether this app is an administrator, it refuses every delete. Say so
  // here and keep Delete off instead of letting the refusal surface as a generic failure. A missing getStatus (older
  // bridge) changes nothing; a failing or unreadable status counts as unknown.
  if (typeof api.getStatus === "function") {
    Promise.resolve().then(() => api.getStatus()).then(
      (s) => { identityUnknown = !(s && typeof s.elevated === "boolean"); canRelaunchAdmin = !!s && s.elevated === false && s.canRelaunchAdmin === true; },
      () => { identityUnknown = true; },
    ).then(() => {
      if (identityUnknown) showError(IDENTITY_UNKNOWN_MESSAGE);
      if (view) refreshSummary();
    });
  }
  Promise.resolve(api.getResults()).then((v) => render(v, false), () => {});
  return { render };
}

if (typeof document !== "undefined" && typeof window !== "undefined" && window.nuke) {
  mount(document, window.nuke);
}
