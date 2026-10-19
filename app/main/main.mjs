// app/main/main.mjs
// Electron entry. Hardened shell: app:// protocol (default session only), validated IPC, deny-all navigation/permissions.
// Wiring: identity read once at startup, the controller, native dialogs (parented to the main window). ONE window: the
// results page (app://ui/results.html, same preload) and the ritual page (no preload, its own in-memory "ritual" session
// that may only reach the current run's http://127.0.0.1:<port>/ and never serves app://) are WebContentsViews attached to
// the main window, one at a time (embedded-view.mjs). The one-time url goes straight to the ritual view.
import { app, BrowserWindow, WebContentsView, protocol, ipcMain, session, Menu, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { appDataPaths, ensureAppData, buildProtection } from "./appdata.mjs";
import { windowOptions, viewOptions, hardenContents, hardenSession, MAIN_MINIMUM } from "./windows.mjs";
import { createViewHost } from "./embedded-view.mjs";
import { createQuestionBroker } from "./question.mjs";
import { UI_CSP, resolveUi } from "./protocol.mjs";
import { registerIpc, trustedSender } from "./ipc.mjs";
import { createController, guardController } from "./controller.mjs";
import { runScan } from "./scan-runner.mjs";
import { readIdentity, regQuery } from "../../lib/sysread.mjs";
import { listPrograms } from "../../lib/programs.mjs";
import { makeRelaunchElevated } from "./elevation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(here, "..", "renderer");
const PRELOAD = path.resolve(here, "..", "preload", "preload.cjs");
const isUiUrl = url => typeof url === "string" && url.startsWith("app://ui/");
const RITUAL_URL_RE = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/\?t=[0-9a-f]{64}$/;
const FATAL_TEXT = "Nuke-Uninstaller could not start. Nothing was changed. Please close it and try again.";
const INTERNAL_TEXT = "Nuke-Uninstaller hit an internal error and will close. Please start it again.";
const PERMANENT_WARNING = "Deleting is permanent: these items do not go to the Recycle Bin. A system restore point protects Windows settings and installed programs, but it does NOT bring back your own files (documents, pictures and so on).";

let paths;
try {
  paths = appDataPaths(process.env);
  ensureAppData(paths);
} catch {
  // Fixed text only (the error text can hold paths); the user sees why nothing opened, then the app ends.
  try { dialog.showErrorBox("Nuke-Uninstaller", FATAL_TEXT); } catch { /* no UI */ }
  app.exit(1);
}

if (paths) {
  // Everything Electron writes (cache, storage) lives under %LOCALAPPDATA%\Nuke-Uninstaller\electron.
  app.setPath("userData", paths.electronDir);
  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true } }]);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    start();
  }
}

function start() {
  const trustedIds = new Set();
  let mainWindow = null;
  let viewHost = null; // attaches the results / ritual WebContentsView to mainWindow (created with the window)
  let ritualSession = null;
  // Origin of the current run's server ("http://127.0.0.1:<port>"), or null when no ritual view is attached.
  let ritualOrigin = null;
  let controller = null;
  const questions = createQuestionBroker({ send: p => { if (!live(mainWindow)) throw new Error("no window"); mainWindow.webContents.send("nuke:question", p); } });
  let closingResults = false;
  const isRitualUrl = url => typeof url === "string" && ritualOrigin !== null && url.startsWith(ritualOrigin + "/");

  app.on("web-contents-created", (_e, contents) => {
    // deny-all default: app://ui/ only; this hook also fires for WebContentsView contents (results, ritual). The ritual
    // view (its own session) may only stay on the current run's origin
    const ritual = ritualSession !== null && contents.session === ritualSession;
    hardenContents(contents, { allowUrl: ritual ? isRitualUrl : isUiUrl });
  });

  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on("window-all-closed", () => app.quit());

  function serveUi(ses) {
    ses.protocol.handle("app", async request => {
      const headers = { "Content-Security-Policy": UI_CSP, "X-Content-Type-Options": "nosniff" };
      const r = resolveUi(request.url, UI_DIR);
      if (!r) return new Response("Not found", { status: 404, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
      try {
        const body = await fs.promises.readFile(r.file);
        return new Response(body, { status: 200, headers: { ...headers, "Content-Type": r.type } });
      } catch {
        return new Response("Not found", { status: 404, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
      }
    });
  }

  const live = w => w && !w.isDestroyed();
  const send = (channel, payload) => { if (live(mainWindow)) mainWindow.webContents.send(channel, payload); };
  const dialogParent = () => (live(mainWindow) ? mainWindow : undefined);
  async function pick(options) {
    const r = await dialog.showOpenDialog(dialogParent(), options);
    return r && !r.canceled && Array.isArray(r.filePaths) && typeof r.filePaths[0] === "string" ? r.filePaths[0] : null;
  }

  // The facade the controller talks to. Nothing here logs or forwards the ritual url.
  const ui = {
    pickFile: () => pick({ properties: ["openFile"] }),
    pickFolder: () => pick({ properties: ["openDirectory"] }),
    sendProgress: p => send("nuke:progress", p),
    sendPhase: p => send("nuke:phase", p),
    showResults() {
      if (!viewHost || !live(mainWindow) || viewHost.current() !== null) return; // one view at a time
      const h = viewHost.attach("results", "app://ui/results.html");
      // Closed by something other than closeResults() (the page failed to load): same as Cancel, back to the start.
      h.onClosed(() => { if (!closingResults && controller) controller.resultsClose().catch(() => {}); });
    },
    closeResults() {
      if (!viewHost || viewHost.current() !== "results") return;
      closingResults = true;
      try { viewHost.closeAll(); } finally { closingResults = false; }
    },
    // In-window questions (no native message box). The results view (if attached) is hidden while the question is shown by the
    // main renderer; on "no" it comes back, on "yes" the controller closes it itself.
    async confirmPermanent() {
      if (viewHost) viewHost.setVisible(false);
      let yes = false;
      try { yes = (await questions.ask("permanent", PERMANENT_WARNING)) === true; } finally { if (!yes && viewHost) viewHost.setVisible(true); }
      return yes;
    },
    confirmAction(message) {
      return questions.ask("action", String(message));
    },
    askContinueWithoutRestore(message) {
      return questions.ask("restore", String(message));
    },
    openRitual(url) {
      const m = RITUAL_URL_RE.exec(typeof url === "string" ? url : "");
      if (!m || !viewHost || !live(mainWindow) || viewHost.current() === "ritual") throw new Error("ritual window refused");
      ritualOrigin = "http://127.0.0.1:" + m[1];
      let h;
      try { h = viewHost.attach("ritual", url); } catch { ritualOrigin = null; throw new Error("ritual window refused"); }
      // Detached (cancel, run ended, failed load, main window closed): the allow policy for this run is cleared.
      h.onClosed(() => { ritualOrigin = null; });
      return { onClosed: cb => h.onClosed(cb), close: () => h.close() };
    },
  };

  // Phase 1b: start this app again elevated (normal UAC prompt). Lock released first, quit on "started", lock taken back
  // otherwise (see makeRelaunchElevated in elevation.mjs, which is tested with a fake app).
  const relaunchElevated = makeRelaunchElevated({ app, execPath: process.execPath });

  // Main-process errors can carry the ritual url (and its token) in their text: never print them, never show them.
  process.on("unhandledRejection", () => { console.error("Nuke-Uninstaller: an internal step failed."); });
  // An internal error outside a delete tells the user (fixed text) and quits; while a delete is in the "deleting" state the app
  // stays up so the run can finish and be reported.
  process.on("uncaughtException", () => {
    console.error("Nuke-Uninstaller: an internal error occurred.");
    let deleting = false;
    try { deleting = !!controller && controller.isDeleting() === true; } catch { deleting = false; }
    if (deleting) return;
    try { dialog.showErrorBox("Nuke-Uninstaller", INTERNAL_TEXT); } catch { /* no UI */ }
    app.quit();
  });

  app.whenReady().then(async () => { try {
    Menu.setApplicationMenu(null);
    const allowRequest = url => isUiUrl(url) || (typeof url === "string" && url.startsWith("data:"));
    hardenSession(session.defaultSession, { allowRequest });
    serveUi(session.defaultSession);
    // The ritual partition: same deny-all permissions, its own request allow-list, and no app:// handler at all.
    ritualSession = session.fromPartition("ritual");
    hardenSession(ritualSession, { allowRequest: isRitualUrl });

    const identity = await readIdentity();
    // Fixed protections plus redirected known folders (read-only reg queries through sysread). A failed read only adds
    // notes; the fixed list is always included. profileRoot (R45) is null when no valid profile folder is known, which
    // makes the controller refuse investigate items.
    const prot = await buildProtection({
      appDir: app.getAppPath(), dataRoot: paths.root, home: os.homedir(), env: process.env, readReg: regQuery,
      execDir: app.isPackaged ? path.dirname(process.execPath) : null,
    });
    controller = createController({ ui, paths, identity, runScan, protectedPaths: prot.protectedPaths, protectedRoots: prot.protectedRoots, profileRoot: prot.profileRoot, relaunch: relaunchElevated, readPrograms: () => listPrograms(regQuery) });
    mainWindow = new BrowserWindow(windowOptions("main", { preload: PRELOAD, devTools: !app.isPackaged }));
    const id = mainWindow.webContents.id;
    // The question answer is handled here (main-window sender only, ignored unless a question is pending).
    const ipcController = Object.freeze({ ...guardController(controller), questionAnswer: async arg => ({ ok: questions.answer(arg && arg.answer) }) });
    registerIpc(ipcMain, ipcController, event => trustedSender(event, trustedIds),
      event => !!event && !!event.sender && event.sender.id === id);
    trustedIds.add(id);
    viewHost = createViewHost({
      win: mainWindow,
      baseMinimum: MAIN_MINIMUM,
      createView: kind => new WebContentsView(viewOptions(kind, { preload: PRELOAD, devTools: !app.isPackaged })),
      trust: wcId => trustedIds.add(wcId),
      untrust: wcId => trustedIds.delete(wcId),
    });
    mainWindow.on("closed", () => { questions.cancel(); try { viewHost.closeAll(); } catch { /* window gone */ } trustedIds.delete(id); mainWindow = null; });
    mainWindow.once("ready-to-show", () => mainWindow && mainWindow.show());
    mainWindow.loadURL("app://ui/index.html").catch(() => {});
  } catch {
    try { dialog.showErrorBox("Nuke-Uninstaller", FATAL_TEXT); } catch { /* no UI */ }
    app.quit();
  } });
}
