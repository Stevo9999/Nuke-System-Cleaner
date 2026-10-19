// Main window. Talks to the main process only through window.nuke. All text is set with textContent.
import { mountDetective } from "./detective.js";
import { phaseText } from "./phases.js";
import { CREDITS, LICENSE_TEXTS, LICENSE_LINKS, TRADEMARKS, GENERAL_NOTE } from "./credits.js";

const GENERIC = "Something went wrong. Please try again.";

function messageOf(e) { return e && typeof e.message === "string" ? e.message : ""; }
// Electron invoke rejections arrive as Error("Error invoking remote method '...': AbortError ...") with name "Error".
function isAbort(e) { return !!e && (e.name === "AbortError" || /\bAbortError\b/.test(messageOf(e))); }
// Always-visible button descriptions (the user approved this exact wording, ruling R53).
export const DESCRIPTIONS = Object.freeze({
  scan: "Smart Scan. Looks only in a fixed list of safe places (temp files, caches, crash dumps, thumbnails, your Recycle Bin) and lists what could be freed. Nothing is deleted yet.",
  investigateFile: "Pick a file, shortcut or program. The app follows it to the program it belongs to and lists the leftover files, folders and shortcuts that program made.",
  investigateFolder: "Pick a folder. If it belongs to an installed program, the app asks whether to run that program's own uninstaller first (you can say no), then lists the leftovers, and checks again after you delete them. If Windows must restart to finish, you are told. Nothing is deleted without your confirmation.",
  programs: "Pick an installed program and run its own uninstaller. Afterwards the app looks for the files it left behind and lets you delete them.",
  apps: "Lists the Windows (Microsoft Store) apps on this PC and removes the one you pick, for your account only.",
  startup: "Lists the programs that start by themselves when Windows starts (the apps that slow down your boot). View only: nothing is changed.",
  browsers: "Looks in the cache folders of your web browsers (Chrome, Edge, Brave, Opera, Firefox) and lists the temporary files they keep to load pages faster. It can also list your browsing history, which is never ticked for you. Nothing is deleted yet.",
  exclusions: "Folders on this list are skipped by every scan and can never be deleted by this app, even if they hold junk.",
  exclusionsAdd: "Pick a folder to protect. This app will never list or delete anything inside it.",
  exclusionsRemove: "Takes this folder off the list, so the app may offer files inside it again.",
  credits: "Honorable mentions: every program, sound and source this app is built with, with its license.",
  settings: "Choose whether Windows makes a restore point before deleting (on by default).",
  tools: "One-click shortcuts to handy Windows tools such as System Restore, Task Scheduler and Services. Nothing is changed by this app.",
  plainConfirm: "Off by default. When on, the final confirmation is a simple screen with an Unlock button and then a Delete permanently button. It is just as careful: the same steps and waiting time apply.",
  relaunch: "Restart with administrator rights to also clear a few Windows system folders. Only offered from a copy installed in C:\\Program Files.",
  cancelScan: "Stop the scan and go back.",
  stopWaitingUninstall: "Stop waiting for the uninstaller. It is not forced to close and may keep running on its own; this app then does not look for leftovers and deletes nothing.",
  stopWaiting: "Stop waiting for Windows to make the restore point. You are then asked whether to continue without one; nothing is deleted unless you say yes.",
  back: "Return to the start screen.",
});
export const FOLDER_HINT = DESCRIPTIONS.investigateFolder;
const BUSY = "Another operation is still running. Please wait.";
// The main process's exact fixed sentences (test/app/elevation.test.mjs checks they match controller.mjs). Only these
// survive Electron's invoke wrapper; any other wrapped error becomes the generic text.
export const FIXED_MESSAGES = Object.freeze({
  busy: BUSY,
  relaunchTimeout: "The administrator prompt did not finish.",
  relaunchCancelled: "Administrator mode was not started: the Windows prompt was cancelled.",
  adminNotOffered: "Administrator mode is only offered for a copy installed in C:\\Program Files",
  identityUnknown: "Could not tell whether this app is running as administrator, so deleting is turned off.",
});
const PASS_THROUGH = [FIXED_MESSAGES.busy, FIXED_MESSAGES.relaunchTimeout, FIXED_MESSAGES.identityUnknown];
function friendly(e) {
  const m = messageOf(e);
  const fixed = PASS_THROUGH.find(t => m.includes(t));
  if (fixed) return fixed;
  if (!m || /Error invoking remote method/i.test(m)) return GENERIC;
  return phaseText("error", m);
}

export function createApp(doc, nuke, mount = mountDetective) {
  const root = doc.getElementById("app");
  const make = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.setAttribute("class", cls);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const button = (label, onClick, cls) => {
    const b = make("button", cls || "btn", label);
    b.setAttribute("type", "button");
    b.addEventListener("click", onClick);
    return b;
  };
  const alertLine = () => {
    const p = make("p", "error");
    p.setAttribute("role", "alert");
    p.hidden = true;
    return p;
  };
  const showMsg = (el, text) => { el.textContent = text; el.hidden = false; };

  // Restart notice: set by the main process (fixed wording, app name sanitised there); stays for the whole session.
  const noticeEls = [];
  const noticeEl = () => { const p = make("p", "notice", ""); p.setAttribute("role", "status"); p.hidden = true; noticeEls.push(p); return p; };
  let restartNotice = "";
  const showNotice = text => {
    restartNotice = phaseText("done", text);
    for (const p of noticeEls) { p.textContent = restartNotice; p.hidden = false; }
    ritualNotice.textContent = restartNotice; ritualNotice.setAttribute("title", restartNotice); ritualNotice.hidden = false;
  };

  let current = "home";
  let busy = false;
  const scanButtons = [];

  // Home
  const home = make("section", "screen");
  home.appendChild(make("h1", "title", "Nuke - System Cleaner"));
  home.appendChild(make("p", "lead", "Find leftovers and clear them out safely."));
  home.appendChild(noticeEl());
  const homeError = alertLine();
  const setBusy = v => { busy = v; for (const b of scanButtons) b.disabled = v; };
  const run = fn => async () => {
    if (busy) return;
    setBusy(true);
    homeError.hidden = true;
    let failure = null;
    try { await fn(); } catch (e) { failure = e; }
    setBusy(false);
    if (failure) { showError(failure); return; }
    // Resolved while still on the Scanning screen with no further phase event: the scan is over.
    if (current === "scanning") onPhase({ phase: "results" });
  };
  // Every button sits in an action row: the button on the left, a short always-visible description on its right
  // (also announced by screen readers through aria-describedby). Texts are the wording the user approved (R53).
  let descSeq = 0;
  const act = (btn, text) => {
    const row = make("div", "action");
    const d = make("p", "desc", text);
    const id = "desc-" + (++descSeq);
    d.setAttribute("id", id);
    btn.setAttribute("aria-describedby", id);
    row.appendChild(btn);
    row.appendChild(d);
    return row;
  };
  const scanBtn = (label, fn, cls, desc) => {
    const b = button(label, run(fn), cls);
    scanButtons.push(b);
    const row = act(b, desc);
    home.appendChild(row);
    return row;
  };
  scanBtn("Scan", () => nuke.scanSmart(), "btn primary", DESCRIPTIONS.scan);
  // Hidden in administrator mode (the main process does not investigate the user's own folders when elevated).
  const userOnly = [
    scanBtn("Manually find a file to investigate", () => nuke.scanInvestigate(), undefined, DESCRIPTIONS.investigateFile),
    scanBtn("Pick a folder to investigate", () => nuke.scanFolder(), undefined, DESCRIPTIONS.investigateFolder),
  ];
  for (const [label, name, d] of [["Installed programs", "programs", DESCRIPTIONS.programs], ["Windows apps", "apps", DESCRIPTIONS.apps]]) {
    const r = act(button(label, () => show(name)), d);
    home.appendChild(r);
    userOnly.push(r);
  }
  { const r = act(button("Windows tools", () => show("tools")), DESCRIPTIONS.tools); home.appendChild(r); userOnly.push(r); }
  userOnly.push(scanBtn("Browsers cleaner", () => nuke.scanBrowsers(), undefined, DESCRIPTIONS.browsers));
  userOnly.push(scanBtn("Startup programs", () => nuke.scanStartup(), undefined, DESCRIPTIONS.startup));
  home.appendChild(act(button("Settings", () => show("settings")), DESCRIPTIONS.settings));
  home.appendChild(act(button("Credits and licenses", () => show("credits")), DESCRIPTIONS.credits));
  home.appendChild(homeError);

  // Scanning
  const scanning = make("section", "screen");
  const detHost = make("div", "det-host");
  scanning.appendChild(detHost);
  const scanError = alertLine();
  scanning.appendChild(act(button("Cancel", async () => {
    scanError.hidden = true;
    try { await nuke.cancelScan(); } catch (e) { if (!isAbort(e)) showMsg(scanError, friendly(e)); }
  }), DESCRIPTIONS.cancelScan));
  scanning.appendChild(scanError);
  let det = null;
  let pendingProgress = null;

  // Phase
  const phaseScreen = make("section", "screen");
  const phaseLine = make("p", "phase-text");
  phaseLine.setAttribute("role", "status");
  phaseLine.setAttribute("aria-live", "polite");
  phaseScreen.appendChild(phaseLine);
  // Restore point progress. Windows gives no percentage, so this is an honest moving bar plus the seconds so far.
  const restoreBar = make("div", "restore-bar");
  restoreBar.setAttribute("role", "progressbar");
  restoreBar.setAttribute("aria-label", "Creating the restore point");
  restoreBar.appendChild(make("div", "restore-fill"));
  const restoreTime = make("p", "desc restore-time", "");
  restoreBar.hidden = true; restoreTime.hidden = true;
  phaseScreen.appendChild(restoreBar);
  phaseScreen.appendChild(restoreTime);
  let restoreTimer = null;
  let restoreStart = 0;
  function stopRestoreBar() {
    if (restoreTimer !== null) { clearInterval(restoreTimer); restoreTimer = null; }
    restoreBar.hidden = true; restoreTime.hidden = true;
  }
  function startRestoreBar() {
    if (restoreTimer !== null) return;
    restoreStart = Date.now();
    restoreBar.hidden = false; restoreTime.hidden = false;
    const tick = () => { restoreTime.textContent = "Working... " + Math.floor((Date.now() - restoreStart) / 1000) + " s (usually about 10-20 seconds)"; };
    tick();
    restoreTimer = setInterval(tick, 1000);
  }
  // "Stop waiting": ends the restore point step (same channel as the scan Cancel). The main process then asks whether to
  // continue without a restore point (the default answer is Stop, nothing is deleted without a yes).
  const stopWaitError = alertLine();
  const stopWait = button("Stop waiting", async () => {
    stopWaitError.hidden = true;
    stopWait.disabled = true;
    try { await nuke.cancelScan(); } catch (e) { if (!isAbort(e)) showMsg(stopWaitError, friendly(e)); stopWait.disabled = false; }
  });
  const stopWaitRow = act(stopWait, DESCRIPTIONS.stopWaiting);
  stopWaitRow.hidden = true;
  phaseScreen.appendChild(stopWaitRow);
  phaseScreen.appendChild(stopWaitError);
  // "Stop waiting" for a running uninstaller (same channel; the uninstaller itself is never killed).
  const stopUninstall = button("Stop waiting for the uninstaller", async () => {
    stopWaitError.hidden = true;
    stopUninstall.disabled = true;
    try { await nuke.cancelScan(); } catch (e) { if (!isAbort(e)) showMsg(stopWaitError, friendly(e)); stopUninstall.disabled = false; }
  });
  const stopUninstallRow = act(stopUninstall, DESCRIPTIONS.stopWaitingUninstall);
  stopUninstallRow.hidden = true;
  phaseScreen.appendChild(stopUninstallRow);
  phaseScreen.appendChild(noticeEl());
  const phaseBack = button("Back", () => show("home"));
  const phaseBackRow = act(phaseBack, DESCRIPTIONS.back);
  phaseScreen.appendChild(phaseBackRow);

  // Ritual: only a slim bar (the final-confirmation page is a view of this same window, below the bar).
  const ritualScreen = make("section", "screen ritual-bar");
  const ritualText = make("p", "ritual-text", phaseText("ritual"));
  ritualText.setAttribute("role", "status");
  const ritualLines = make("div", "ritual-lines");
  ritualLines.appendChild(ritualText);
  const ritualNotice = make("p", "ritual-notice", "");
  ritualNotice.hidden = true;
  ritualLines.appendChild(ritualNotice);
  ritualScreen.appendChild(ritualLines);
  const ritualError = alertLine();
  const ritualCancel = button("Cancel - nothing will be deleted", async () => {
    ritualError.hidden = true;
    ritualCancel.disabled = true;
    try { await nuke.cancelRitual(); } catch (e) { if (!isAbort(e)) showMsg(ritualError, friendly(e)); }
    ritualCancel.disabled = false;
  }, "btn ritual-cancel");
  ritualScreen.appendChild(ritualCancel);
  // After the run finished the page below stays (blast + disk map); this button replaces Cancel and returns to the start.
  const ritualDone = button("Done - back to start", async () => {
    ritualError.hidden = true;
    ritualDone.disabled = true;
    try { await nuke.closeRitual(); } catch (e) { if (!isAbort(e)) showMsg(ritualError, friendly(e)); }
    ritualDone.disabled = false;
  }, "btn ritual-done");
  ritualDone.hidden = true;
  ritualScreen.appendChild(ritualDone);
  ritualScreen.appendChild(ritualError);

  // Question: in-window replacement for the native message boxes. Focus starts on the safe answer; nothing accepts by default.
  const questionScreen = make("section", "screen");
  const questionText = make("p", "phase-text");
  questionScreen.setAttribute("role", "alertdialog");
  questionScreen.appendChild(questionText);
  const questionError = alertLine();
  let questionBefore = "home";
  let questionOpen = false;
  const answerWith = async value => {
    if (!questionOpen) return;
    questionOpen = false;
    questionYes.disabled = true; questionNo.disabled = true;
    questionError.hidden = true;
    try { await nuke.answerQuestion(value); } catch (e) { if (!isAbort(e)) showMsg(questionError, friendly(e)); }
    // No phase arrived meanwhile (e.g. the answer was "no"): go back to what was on screen before the question.
    if (current === "question") show(questionBefore);
  };
  const questionYes = button("Continue", () => answerWith(true));
  const questionNo = button("Cancel", () => answerWith(false));
  questionScreen.appendChild(questionYes);
  questionScreen.appendChild(questionNo);
  questionScreen.appendChild(questionError);
  function onQuestion(q) {
    if (!q || typeof q !== "object" || !["permanent", "restore", "action", "folderapp", "restart"].includes(q.kind) || typeof q.message !== "string") return;
    if (current !== "question") questionBefore = current;
    questionOpen = true;
    questionText.textContent = phaseText("done", q.message);
    const labels = { restore: ["Continue without a restore point", "Stop"], action: ["Yes, go ahead", "Cancel"],
      folderapp: ["Yes, run the uninstaller first", "No, only look for leftovers"], restart: ["Yes, keep cleaning leftovers", "No, stop here"] }[q.kind] || ["Continue", "Cancel"];
    questionYes.textContent = labels[0];
    questionNo.textContent = labels[1];
    questionYes.disabled = false; questionNo.disabled = false;
    questionError.hidden = true;
    show("question");
    if (typeof questionNo.focus === "function") questionNo.focus();
  }

  // Settings
  const settings = make("section", "screen");
  settings.appendChild(make("h2", "title", "Settings"));
  const row = make("label", "switch-row");
  const sw = make("input", "switch");
  sw.setAttribute("type", "checkbox");
  sw.setAttribute("role", "switch");
  sw.checked = false;
  sw.disabled = true;
  row.appendChild(sw);
  row.appendChild(make("span", "switch-label", "Create a system restore point before deleting"));
  const swState = make("span", "switch-state", "Loading…");
  row.appendChild(swState);
  settings.appendChild(row);
  // Second switch: the simple confirm screen instead of the 3D room (off by default).
  const row2 = make("label", "switch-row");
  const sw2 = make("input", "switch");
  sw2.setAttribute("type", "checkbox");
  sw2.setAttribute("role", "switch");
  sw2.checked = false;
  sw2.disabled = true;
  row2.appendChild(sw2);
  row2.appendChild(make("span", "switch-label", "Turn off the nuke-key animation (use a simple confirm screen instead)"));
  const sw2State = make("span", "switch-state", "Loading…");
  row2.appendChild(sw2State);
  settings.appendChild(row2);
  settings.appendChild(make("p", "desc", DESCRIPTIONS.plainConfirm));
  const settingsError = alertLine();
  // Exclusions: folders this app must never touch. The window only shows what main sends and returns ids to remove one.
  settings.appendChild(make("h3", "title", "Folders this app must never touch"));
  settings.appendChild(make("p", "desc", DESCRIPTIONS.exclusions));
  const exclStatus = make("p", "excl-status", "Loading...");
  exclStatus.setAttribute("role", "status");
  settings.appendChild(exclStatus);
  const exclList = make("div", "excl-list");
  settings.appendChild(exclList);
  const exclError = alertLine();
  const EXCL_REASONS = Object.freeze({
    invalid: "That folder cannot be added. Pick a normal folder on a drive (not a whole drive or a network location).",
    duplicate: "That folder is already on the list.",
    full: "The list is full (50 folders). Remove one first.",
    gone: "That folder was already off the list.",
    failed: "The list could not be saved. Nothing was changed.",
  });
  function renderExclusions(rows) {
    while (exclList.firstChild) exclList.removeChild(exclList.firstChild);
    const list = Array.isArray(rows) ? rows.filter(r => r && typeof r.id === "string" && typeof r.path === "string") : [];
    exclStatus.textContent = list.length === 0 ? "No folders on the list yet." : list.length + (list.length === 1 ? " folder is" : " folders are") + " protected.";
    for (const r of list) {
      const item = make("div", "excl-row");
      item.appendChild(make("p", "excl-path", r.path));
      item.appendChild(act(button("Remove", () => changeExclusions(() => nuke.exclusionsRemove(r.id))), DESCRIPTIONS.exclusionsRemove));
      exclList.appendChild(item);
    }
  }
  async function changeExclusions(call) {
    exclError.hidden = true;
    try {
      const r = await call();
      if (r && Array.isArray(r.rows)) renderExclusions(r.rows);
      if (r && r.ok !== true && typeof r.reason === "string" && Object.hasOwn(EXCL_REASONS, r.reason)) showMsg(exclError, EXCL_REASONS[r.reason]);
    } catch (e) { if (!isAbort(e)) showMsg(exclError, friendly(e)); }
  }
  settings.appendChild(act(button("Add folder...", () => changeExclusions(() => nuke.exclusionsAdd())), DESCRIPTIONS.exclusionsAdd));
  settings.appendChild(exclError);
  const modeLine = make("p", "mode", "Checking mode…");
  settings.appendChild(modeLine);
  const relaunch = button("Relaunch as administrator", async () => {
    settingsError.hidden = true;
    try {
      const r = await nuke.relaunchAdmin();
      if (r && r.cancelled === true) showMsg(settingsError, FIXED_MESSAGES.relaunchCancelled);
    } catch (e) { if (!isAbort(e)) showMsg(settingsError, friendly(e)); }
  });
  const relaunchRow = act(relaunch, DESCRIPTIONS.relaunch);
  relaunchRow.hidden = true;
  settings.appendChild(relaunchRow);
  // R46: administrator mode is only offered for a packaged copy in C:\Program Files.
  const adminNote = make("p", "mode", FIXED_MESSAGES.adminNotOffered);
  adminNote.hidden = true;
  settings.appendChild(adminNote);
  settings.appendChild(settingsError);
  settings.appendChild(act(button("Back", () => show("home")), DESCRIPTIONS.back));

  let settingsSeq = 0;
  let statusSeq = 0;
  // Both settings travel together (the main process stores exactly { restorePoint, plainConfirm }).
  let prefs = { restorePoint: true, plainConfirm: false };
  const known = next => {
    prefs = { restorePoint: next.restorePoint === true, plainConfirm: next.plainConfirm === true };
    sw.disabled = false; sw.checked = prefs.restorePoint; swState.textContent = prefs.restorePoint ? "On" : "Off";
    sw2.disabled = false; sw2.checked = prefs.plainConfirm; sw2State.textContent = prefs.plainConfirm ? "On" : "Off";
  };
  const wire = (box, stateEl, key) => box.addEventListener("change", async () => {
    const wanted = box.checked === true;
    const before = prefs;
    const seq = ++settingsSeq; // invalidates any pending load and older saves
    settingsError.hidden = true;
    stateEl.textContent = "Saving…";
    sw.disabled = true; sw2.disabled = true;
    try {
      const saved = await nuke.setSettings({ restorePoint: key === "restorePoint" ? wanted : before.restorePoint, plainConfirm: key === "plainConfirm" ? wanted : before.plainConfirm });
      if (seq !== settingsSeq) return;
      const mine = { restorePoint: key === "restorePoint" ? wanted : before.restorePoint, plainConfirm: key === "plainConfirm" ? wanted : before.plainConfirm };
      known({ restorePoint: saved && typeof saved.restorePoint === "boolean" ? saved.restorePoint : mine.restorePoint, plainConfirm: saved && typeof saved.plainConfirm === "boolean" ? saved.plainConfirm : mine.plainConfirm });
    } catch (e) {
      if (seq !== settingsSeq) return;
      known(before);
      showMsg(settingsError, friendly(e));
    }
  });
  wire(sw, swState, "restorePoint");
  wire(sw2, sw2State, "plainConfirm");

  // Windows tools: a fixed list of built-in Windows programs. The window only holds the key; the main process knows the program.
  const toolsScreen = make("section", "screen");
  toolsScreen.appendChild(make("h2", "title", "Windows tools"));
  toolsScreen.appendChild(make("p", "lead", "Handy tools that come with Windows. Press one to open it. Some will ask Windows for permission first. Nothing is changed by this app."));
  const toolsStatus = make("p", "mode", "Loading...");
  toolsStatus.setAttribute("role", "status");
  toolsScreen.appendChild(toolsStatus);
  const toolsList = make("div", "tool-list");
  toolsScreen.appendChild(toolsList);
  const toolsError = alertLine();
  toolsScreen.appendChild(toolsError);
  toolsScreen.appendChild(act(button("Back", () => show("home")), DESCRIPTIONS.back));
  let toolsSeq = 0;
  async function openTools() {
    const mine = ++toolsSeq;
    toolsError.hidden = true;
    toolsStatus.textContent = "Loading...";
    while (toolsList.firstChild) toolsList.removeChild(toolsList.firstChild);
    try {
      const rows = await nuke.toolsList();
      if (mine !== toolsSeq) return;
      const list = Array.isArray(rows) ? rows.filter(r => r && typeof r.key === "string" && typeof r.label === "string") : [];
      toolsStatus.textContent = list.length === 0 ? "Nothing to show." : "";
      for (const r of list) {
        toolsList.appendChild(act(button(r.label, async () => {
          toolsError.hidden = true;
          toolsStatus.textContent = "";
          try {
            const out = await nuke.toolsOpen(r.key);
            if (out && out.ok === true) toolsStatus.textContent = "Opened " + r.label + ".";
            else showMsg(toolsError, "That tool could not be opened.");
          } catch (e) { if (!isAbort(e)) showMsg(toolsError, friendly(e)); }
        }), typeof r.description === "string" ? r.description : ""));
      }
    } catch (e) {
      if (mine !== toolsSeq) return;
      toolsStatus.textContent = "";
      showMsg(toolsError, friendly(e));
    }
  }

  // A pick-one list screen (installed programs, Windows apps). Rows come from the main process as { id, name, ... }; only the id goes back.
  function listScreen({ title, intro, load, describe, pickable, actionLabel, actionDesc, act: doAct }) {
    const sec = make("section", "screen");
    sec.appendChild(make("h2", "title", title));
    sec.appendChild(make("p", "lead", intro));
    const filter = make("input", "filter");
    filter.setAttribute("type", "search");
    filter.setAttribute("placeholder", "Type to filter the list");
    filter.setAttribute("aria-label", "Filter the list");
    sec.appendChild(filter);
    const status = make("p", "mode", "Loading...");
    status.setAttribute("role", "status");
    sec.appendChild(status);
    const list = make("div", "pick-list");
    list.setAttribute("role", "radiogroup");
    sec.appendChild(list);
    const err = alertLine();
    let rows = [];
    let chosen = null;
    let seq = 0;
    const doBtn = button(actionLabel, async () => {
      if (!chosen || busy) return;
      setBusy(true);
      err.hidden = true;
      let failure = null;
      try { await doAct(chosen); } catch (e) { failure = e; }
      setBusy(false);
      if (failure && !isAbort(failure)) { showMsg(err, friendly(failure)); }
      
    });
    doBtn.disabled = true;
    scanButtons.push(doBtn);
    sec.appendChild(act(doBtn, actionDesc));
    sec.appendChild(err);
    sec.appendChild(act(button("Back", () => show("home")), DESCRIPTIONS.back));
    function render() {
      const q = filter.value.trim().toLowerCase();
      while (list.firstChild) list.removeChild(list.firstChild);
      let shown = 0;
      for (const r of rows) {
        const text = describe(r);
        if (q && !text.toLowerCase().includes(q)) continue;
        shown++;
        const lab = make("label", "pick-row");
        const rb = make("input", "pick");
        rb.setAttribute("type", "radio");
        rb.setAttribute("name", "pick");
        rb.disabled = !pickable(r);
        rb.checked = chosen === r;
        rb.addEventListener("change", () => { chosen = r; doBtn.disabled = busy; });
        lab.appendChild(rb);
        lab.appendChild(make("span", "pick-text", text + (pickable(r) ? "" : " (cannot be removed from here)")));
        list.appendChild(lab);
      }
      status.textContent = rows.length === 0 ? "Nothing to show." : shown + " of " + rows.length + " shown.";
    }
    filter.addEventListener("input", render);
    async function open() {
      const mine = ++seq;
      chosen = null; doBtn.disabled = true; err.hidden = true; filter.value = "";
      status.textContent = "Loading...";
      while (list.firstChild) list.removeChild(list.firstChild);
      try {
        const r = await load();
        if (mine !== seq) return;
        rows = r && Array.isArray(r.rows) ? r.rows : [];
        if (!r || r.ok !== true) showMsg(err, "The list could not be read completely.");
        render();
      } catch (e) {
        if (mine !== seq) return;
        rows = [];
        status.textContent = "";
        showMsg(err, friendly(e));
      }
    }
    return { sec, open };
  }
  const bytesText = kb => (typeof kb === "number" && kb > 0 ? (kb >= 1048576 ? (kb / 1048576).toFixed(1) + " GB" : kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB") : "");
  const programsScreen = listScreen({
    title: "Installed programs", intro: "Pick a program, then press Uninstall. Its own uninstaller runs first; then the app looks for leftovers.",
    load: () => nuke.programsList(),
    describe: r => [r.name, r.publisher, r.version, bytesText(r.sizeKb)].filter(Boolean).join("  -  "),
    pickable: r => r.canUninstall === true,
    actionLabel: "Uninstall", actionDesc: "Asks you first, then runs the program's own uninstaller and looks for leftover files, folders and shortcuts.",
    act: r => nuke.programsUninstall(r.id),
  });
  const appsScreen = listScreen({
    title: "Windows apps", intro: "Microsoft Store apps installed for your account. Pick one, then press Remove.",
    load: () => nuke.appsList(),
    describe: r => [r.name, r.version].filter(Boolean).join("  -  "),
    pickable: () => true,
    actionLabel: "Remove", actionDesc: "Asks you first, then removes the selected Windows app for your account only. You can reinstall it from the Microsoft Store.",
    act: r => nuke.appsRemove(r.id),
  });

  // Credits and licenses: static text from credits.js. URLs are shown as plain text (this window never navigates away).
  const creditsScreen = make("section", "screen credits");
  creditsScreen.appendChild(make("h2", "title", "Credits and licenses"));
  creditsScreen.appendChild(make("p", "lead", GENERAL_NOTE));
  const GROUPS = [["included", "Inside this app"], ["sound", "Sounds"], ["build", "Used to build the installer (not inside the app)"], ["reference", "Read for reference (nothing copied)"]];
  for (const [kind, heading] of GROUPS) {
    creditsScreen.appendChild(make("h3", "credit-head", heading));
    for (const c of CREDITS.filter(x => x.kind === kind)) {
      const box = make("div", "credit");
      box.appendChild(make("p", "credit-name", c.name));
      box.appendChild(make("p", "desc", c.what));
      box.appendChild(make("p", "desc", c.by + " - License: " + c.license));
      box.appendChild(make("p", "desc credit-url", c.url));
      creditsScreen.appendChild(box);
    }
  }
  creditsScreen.appendChild(make("h3", "credit-head", "License texts"));
  for (const [name, paras] of Object.entries(LICENSE_TEXTS)) {
    const d = make("details", "credit");
    d.appendChild(make("summary", "credit-name", name));
    for (const p of paras) d.appendChild(make("p", "desc", p));
    creditsScreen.appendChild(d);
  }
  for (const [name, url] of Object.entries(LICENSE_LINKS)) {
    const box = make("div", "credit");
    box.appendChild(make("p", "credit-name", name));
    box.appendChild(make("p", "desc", "Full text: " + url));
    creditsScreen.appendChild(box);
  }
  creditsScreen.appendChild(make("p", "desc", TRADEMARKS));
  creditsScreen.appendChild(act(button("Back", () => show("home")), DESCRIPTIONS.back));

  const screens = { credits: creditsScreen, home, scanning, phase: phaseScreen, ritual: ritualScreen, question: questionScreen, settings, programs: programsScreen.sec, apps: appsScreen.sec, tools: toolsScreen };
  for (const k of Object.keys(screens)) { screens[k].hidden = true; root.appendChild(screens[k]); }

  function show(name) {
    current = name;
    root.setAttribute("data-mode", name === "ritual" ? "ritual" : "normal"); // the ritual bar is a fixed-height strip above the embedded page
    if (name === "ritual") { ritualCancel.disabled = false; ritualError.hidden = true; }
    if (name !== "question") questionOpen = false;
    for (const k of Object.keys(screens)) screens[k].hidden = k !== name;
    if (name !== "phase") stopRestoreBar();
    if (name !== "scanning" && det) { det.destroy(); det = null; }
    if (name === "scanning" && !det) {
      scanError.hidden = true;
      det = mount(detHost, { label: "Scanning" });
      if (pendingProgress) { det.set(pendingProgress.f, pendingProgress.l); }
    }
    if (name === "settings") { loadSettings(); loadStatus(); }
    if (name === "programs") programsScreen.open();
    if (name === "apps") appsScreen.open();
    if (name === "tools") openTools();
  }
  function showError(e) {
    show("home");
    if (isAbort(e)) return;
    showMsg(homeError, friendly(e));
  }
  async function loadSettings() {
    const seq = ++settingsSeq;
    settingsError.hidden = true;
    sw.disabled = true; sw2.disabled = true;
    swState.textContent = "Loading…"; sw2State.textContent = "Loading…";
    try {
      const s = await nuke.getSettings();
      if (seq !== settingsSeq) return;
      known({ restorePoint: !(s && s.restorePoint === false), plainConfirm: !!s && s.plainConfirm === true });
      renderExclusions(s && s.exclusions);
    } catch (e) {
      if (seq !== settingsSeq) return;
      sw.checked = false; sw2.checked = false;
      sw.disabled = true; sw2.disabled = true;
      swState.textContent = "Unknown"; sw2State.textContent = "Unknown";
      exclStatus.textContent = "Unknown";
      showMsg(settingsError, friendly(e));
    }
  }
  async function loadStatus() {
    const seq = ++statusSeq;
    try {
      const st = await nuke.getStatus();
      if (seq !== statusSeq) return;
      const mode = st && (st.elevated === true || st.elevated === false) ? st.elevated : null;
      modeLine.textContent = mode === true ? "Administrator mode" : mode === false ? "Standard mode" : FIXED_MESSAGES.identityUnknown;
      const canAdmin = st && st.canRelaunchAdmin === true;
      relaunchRow.hidden = mode !== false || !canAdmin;
      adminNote.hidden = mode !== false || canAdmin;
      for (const b of userOnly) b.hidden = mode === true;
    } catch (e) {
      if (seq !== statusSeq) return;
      modeLine.textContent = "Mode unknown";
      relaunchRow.hidden = true;
      adminNote.hidden = true;
    }
  }

  function ritualMode(mode, text) {
    ritualText.textContent = text;
    ritualText.setAttribute("title", text);
    show("ritual");
    ritualCancel.hidden = mode !== "confirm"; // "busy" (deleting) shows neither button
    ritualDone.hidden = mode !== "done";
    ritualDone.disabled = false;
  }
  function onPhase(p) {
    const phase = p && typeof p === "object" ? p.phase : p;
    const detail = p && typeof p === "object" ? p.detail : undefined;
    homeError.hidden = true;
    if (p && typeof p === "object" && typeof p.notice === "string" && p.notice) showNotice(p.notice);
    if (phase === "scanning") { show("scanning"); return; }
    pendingProgress = null;
    if (phase === "idle") { show("home"); return; }
    if (phase === "ritual") { ritualMode("confirm", phaseText("ritual")); return; }
    // A finished run keeps its page (blast, disk map); the bar shows the outcome and the way back.
    if (phase === "done" && p && typeof p === "object" && p.keepView === true) { ritualMode("done", phaseText("done", detail)); return; }
    if (phase !== "uninstalling") stopUninstallRow.hidden = true;
    phaseLine.textContent = phaseText(phase, detail);
    // "deleting" keeps the confirmation page below the bar; only the live count changes (no Cancel once it started).
    if (phase === "deleting") { ritualMode("busy", phaseText("deleting", detail)); return; }
    phaseBack.hidden = phase === "restore" || phase === "checking" || phase === "uninstalling";
    phaseBackRow.hidden = phase === "restore" || phase === "checking" || phase === "uninstalling";
    stopUninstallRow.hidden = phase !== "uninstalling";
    stopUninstall.disabled = false;
    const waiting = phase === "restore" && (!detail || detail === "");
    stopWaitRow.hidden = !waiting;
    stopWaitError.hidden = true;
    stopWait.disabled = false;
    if (waiting) startRestoreBar(); else stopRestoreBar();
    show("phase");
  }
  function onProgress(p) {
    if (!p || typeof p !== "object") return;
    const f = typeof p.fraction === "number" ? p.fraction : null;
    const l = typeof p.label === "string" ? p.label : undefined;
    pendingProgress = { f, l }; // kept so progress that beats the scanning phase is not lost
    if (det) det.set(f, l);
  }

  const unsubs = [nuke.onPhase(onPhase), nuke.onProgress(onProgress)];
  if (typeof nuke.onQuestion === "function") unsubs.push(nuke.onQuestion(onQuestion));
  show("home");
  loadStatus(); // early, so the home screen hides the investigate buttons in administrator mode
  return { show, onPhase, onProgress, onQuestion, destroy() { stopRestoreBar(); for (const u of unsubs) if (typeof u === "function") u(); } };
}

export function bootstrap(doc, nuke) {
  if (!nuke) {
    const host = doc.getElementById("app");
    const p = doc.createElement("p");
    p.setAttribute("role", "alert");
    p.textContent = "The app bridge is unavailable, so this window cannot work. Please restart Nuke - System Cleaner.";
    host.appendChild(p);
    return null;
  }
  return createApp(doc, nuke);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  bootstrap(document, window.nuke);
}
