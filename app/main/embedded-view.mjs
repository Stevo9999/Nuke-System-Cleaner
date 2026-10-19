// app/main/embedded-view.mjs
// One window, three screens: the results page and the ritual page are WebContentsViews attached to the main window's
// contentView (one at a time). Pure (no electron import): everything Electron-specific is injected, so the bounds math and
// the attach/detach/replace lifecycle (including trusted-id registration) are unit-testable display-less.
// Nothing here reads, logs or stores the url that is loaded (the ritual url carries the one-time token).

export const RITUAL_BAR_HEIGHT = 56; // the slim bar that belongs to the main renderer (must equal --ritual-bar in main.css)
export const RITUAL_MIN = Object.freeze({ width: 800, height: 600 });
export const RESULTS_MIN = Object.freeze({ width: 640, height: 480 });

// kind -> bar height (main renderer area kept above the view), minimum view size, whether the page may use the IPC bridge.
export const VIEW_KINDS = Object.freeze({
  results: Object.freeze({ bar: 0, min: RESULTS_MIN, trusted: true }),
  ritual: Object.freeze({ bar: RITUAL_BAR_HEIGHT, min: RITUAL_MIN, trusted: false }),
});

const dim = v => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// View rectangle in content coordinates: below `barHeight`, full width, never smaller than `min` (the window minimum is
// raised to match, so this only matters for garbage input).
export function computeRitualBounds(contentBounds, barHeight = 0, min = { width: 0, height: 0 }) {
  const bar = dim(barHeight);
  const cw = dim(contentBounds && contentBounds.width);
  const ch = dim(contentBounds && contentBounds.height);
  return { x: 0, y: bar, width: Math.max(cw, dim(min && min.width)), height: Math.max(ch - bar, dim(min && min.height)) };
}

// Smallest window size that still leaves the view its minimum: the bar sits on top of it.
export function windowMinimum(base, min, barHeight = 0) {
  return { width: Math.max(dim(base && base.width), dim(min && min.width)), height: Math.max(dim(base && base.height), dim(min && min.height) + dim(barHeight)) };
}

const quiet = fn => { try { return fn(); } catch { return undefined; } };

/**
 * createViewHost({ win, createView, baseMinimum, trust, untrust })
 *   win: { contentView:{addChildView,removeChildView}, getContentBounds(), setMinimumSize(w,h), on/removeListener, isDestroyed() }
 *   createView(kind): returns { webContents:{id,loadURL,on,close,focus}, setBounds(rect) }
 *   trust(id) / untrust(id): the IPC trusted-sender set (only kinds with trusted:true are registered)
 * attach(kind, url) -> { kind, close(), onClosed(cb) }. One view at a time: attaching another kind replaces the old view
 * silently (no closed callbacks); attaching the same kind again throws.
 */
export function createViewHost({ win, createView, baseMinimum, trust = () => {}, untrust = () => {} }) {
  let cur = null; // { kind, view, wc, id, trusted, resize, callbacks, gone }

  function detach(c, silent) {
    if (!c || c.gone) return;
    c.gone = true;
    if (cur === c) cur = null;
    if (c.trusted) quiet(() => untrust(c.id)); // an id is never left trusted after its view is gone
    quiet(() => win.removeListener("resize", c.resize));
    quiet(() => win.contentView.removeChildView(c.view));
    quiet(() => { if (typeof c.wc.close === "function") c.wc.close({ waitForBeforeUnload: false }); });
    if (!cur) quiet(() => win.setMinimumSize(dim(baseMinimum.width), dim(baseMinimum.height)));
    if (!silent) for (const cb of c.callbacks) quiet(cb);
  }

  function attach(kind, url) {
    if (!Object.hasOwn(VIEW_KINDS, kind)) throw new Error("unknown view kind");
    if (cur && cur.kind === kind) throw new Error("view already attached");
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) throw new Error("no window");
    const spec = VIEW_KINDS[kind];
    if (cur) detach(cur, true);
    const view = createView(kind);
    const wc = view.webContents;
    const c = { kind, view, wc, id: wc.id, trusted: spec.trusted === true, resize: null, callbacks: [], gone: false };
    const fit = () => quiet(() => view.setBounds(computeRitualBounds(win.getContentBounds(), spec.bar, spec.min)));
    c.resize = fit;
    cur = c;
    try {
      const m = windowMinimum(baseMinimum, spec.min, spec.bar);
      win.setMinimumSize(m.width, m.height);
      if (c.trusted) trust(c.id);
      win.contentView.addChildView(view);
      fit();
      win.on("resize", fit);
      // A failed main-frame load must not leave a dead view holding the screen: detach it (callers treat that as cancel).
      wc.on("did-fail-load", (_e, _code, _desc, _u, isMainFrame) => { if (isMainFrame) detach(c, false); });
      // A crashed or destroyed page is a lost view: detach it so the controller sees "closed" (cancel before the press).
      wc.on("render-process-gone", () => detach(c, false));
      wc.on("destroyed", () => detach(c, false));
      quiet(() => wc.focus());
      // The rejection text of loadURL contains the full url (token included): swallow it, never log the reason.
      wc.loadURL(url).catch(() => {});
    } catch (e) {
      detach(c, true);
      throw e;
    }
    return {
      kind,
      close() { detach(c, false); },
      onClosed(cb) { if (typeof cb === "function") c.callbacks.push(cb); },
    };
  }

  // Hide/show the attached view without detaching it (an in-window question is drawn by the main renderer underneath).
  function setVisible(visible) {
    if (!cur) return false;
    return quiet(() => { cur.view.setVisible(visible === true); return true; }) === true;
  }

  return { attach, setVisible, current: () => (cur ? cur.kind : null), closeAll() { detach(cur, false); } };
}
