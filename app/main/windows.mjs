// app/main/windows.mjs
// Window options and hardening for webContents/sessions. Pure (no electron import) so it is unit-testable display-less.
const KINDS = {
  main: { width: 1100, height: 760, minWidth: 720, minHeight: 520, title: "Nuke - System Cleaner" },
};
export const MAIN_MINIMUM = Object.freeze({ width: KINDS.main.minWidth, height: KINDS.main.minHeight });

// One window: the results and ritual pages are WebContentsViews inside the main window (see embedded-view.mjs).
function basePreferences(devTools) {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    devTools: devTools === true,
  };
}

export function windowOptions(kind, { preload, devTools = false } = {}) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error("unknown window kind");
  return { ...KINDS[kind], show: false, autoHideMenuBar: true, webPreferences: { ...basePreferences(devTools), preload } };
}

// Options for the WebContentsView of an embedded page. results: same preload and default session as the main window
// (app:// only). ritual: NO preload, its own in-memory "ritual" partition, devTools always off.
export function viewOptions(kind, { preload, devTools = false } = {}) {
  if (kind === "results") return { webPreferences: { ...basePreferences(devTools), preload } };
  if (kind === "ritual") return { webPreferences: { ...basePreferences(false), partition: "ritual" } }; // no "persist:" prefix: in-memory
  throw new Error("unknown view kind");
}

const urlOf = (e, second) => (typeof second === "string" ? second : e && typeof e.url === "string" ? e.url : "");

export function hardenContents(wc, { allowUrl }) {
  const guard = (e, second) => {
    let ok = false;
    try { const u = urlOf(e, second); ok = u.length > 0 && allowUrl(u) === true; } catch { ok = false; }
    if (!ok) e.preventDefault();
  };
  for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) wc.on(name, guard);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-attach-webview", e => e.preventDefault());
  wc.on("context-menu", e => e.preventDefault());
}

export function hardenSession(ses, { allowRequest }) {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    let ok = false;
    try { ok = allowRequest(details && details.url) === true; } catch { ok = false; }
    callback({ cancel: !ok });
  });
  ses.on("will-download", e => e.preventDefault());
}
