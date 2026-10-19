import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { windowOptions, viewOptions, hardenContents, hardenSession } from "../../app/main/windows.mjs";

const PARENT = { fake: "parent" };

test("windowOptions/viewOptions: hardening flags exact for the window and both views; ritual view has no preload, its own partition, devTools always off", () => {
  for (const devTools of [true, false]) {
    for (const kind of ["main", "results", "ritual"]) {
      const o = kind === "main" ? windowOptions(kind, { preload: "C:\\p\\preload.cjs", devTools }) : viewOptions(kind, { preload: "C:\\p\\preload.cjs", devTools });
      const wp = o.webPreferences;
      assert.equal(wp.contextIsolation, true);
      assert.equal(wp.nodeIntegration, false);
      assert.equal(wp.sandbox, true);
      assert.equal(wp.webSecurity, true);
      assert.equal(wp.allowRunningInsecureContent, false);
      assert.equal(wp.webviewTag, false);
      assert.equal(wp.spellcheck, false);
      assert.equal(wp.devTools, kind === "ritual" ? false : devTools);
      assert.equal(wp.nodeIntegrationInWorker, undefined);
      if (kind === "ritual") {
        assert.equal(wp.preload, undefined);
        assert.equal(wp.partition, "ritual");
        assert.ok(!wp.partition.startsWith("persist:"));
      } else {
        assert.equal(wp.preload, "C:\\p\\preload.cjs");
        assert.equal(wp.partition, undefined);
      }
    }
  }
  assert.equal(windowOptions("main", { preload: "p", devTools: false }).modal, undefined);
  assert.equal(windowOptions("main", { preload: "p", devTools: false }).parent, undefined);
  assert.throws(() => windowOptions("evil", { preload: "p" }));
  assert.throws(() => windowOptions("results", { preload: "p" }), "no results window any more");
  assert.throws(() => windowOptions("ritual", { preload: "p" }), "no ritual window any more");
  assert.throws(() => viewOptions("main", { preload: "p" }));
  assert.equal(viewOptions("results", { preload: "p" }).webPreferences.partition, undefined, "results uses the default session (app:// only)");
  assert.equal(windowOptions("main", { preload: "p" }).webPreferences.devTools, false, "devTools defaults off");
});

function fakeContents() {
  const wc = new EventEmitter();
  wc.handler = null;
  wc.setWindowOpenHandler = h => { wc.handler = h; };
  return wc;
}
const ev = (extra = {}) => ({ prevented: false, preventDefault() { this.prevented = true; }, ...extra });
const allowUrl = u => u.startsWith("app://ui/");

test("hardenContents: off-origin navigation and redirects prevented, window.open denied, webview blocked", () => {
  const wc = fakeContents();
  hardenContents(wc, { allowUrl });
  for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
    for (const bad of ["https://evil.example/", "file:///C:/x.html", "app://other/index.html", "javascript:alert(1)"]) {
      const e = ev({ url: bad });
      wc.emit(name, e, bad);
      assert.equal(e.prevented, true, name + " " + bad);
      const e2 = ev({ url: bad }); // details-style event without a second arg
      wc.emit(name, e2);
      assert.equal(e2.prevented, true, name + " details " + bad);
    }
    const ok = ev({ url: "app://ui/index.html" });
    wc.emit(name, ok, "app://ui/index.html");
    assert.equal(ok.prevented, false, name + " allowed");
  }
  const noUrl = ev();
  wc.emit("will-navigate", noUrl);
  assert.equal(noUrl.prevented, true, "missing url refused");
  assert.deepEqual(wc.handler({ url: "https://evil.example/" }), { action: "deny" });
  assert.deepEqual(wc.handler({ url: "app://ui/index.html" }), { action: "deny" });
  const wv = ev();
  wc.emit("will-attach-webview", wv, {}, {});
  assert.equal(wv.prevented, true);
  const cm = ev();
  wc.emit("context-menu", cm, {});
  assert.equal(cm.prevented, true);
});

function fakeSession() {
  const ses = new EventEmitter();
  ses.perm = ses.check = ses.device = ses.before = null;
  ses.setPermissionRequestHandler = h => { ses.perm = h; };
  ses.setPermissionCheckHandler = h => { ses.check = h; };
  ses.setDevicePermissionHandler = h => { ses.device = h; };
  ses.webRequest = { onBeforeRequest: h => { ses.before = h; } };
  return ses;
}

test("hardenSession: every permission false, downloads prevented, requests outside allowRequest cancelled", () => {
  const ses = fakeSession();
  hardenSession(ses, { allowRequest: u => u.startsWith("app://ui/") });
  for (const p of ["media", "geolocation", "notifications", "clipboard-read", "openExternal", "midi", "hid", "usb"]) {
    let got = "unset";
    ses.perm({}, p, v => { got = v; });
    assert.equal(got, false, p);
    assert.equal(ses.check({}, p, "app://ui/", {}), false, p + " check");
  }
  assert.equal(ses.device({ deviceType: "usb" }), false);
  let r;
  ses.before({ url: "https://evil.example/x.js" }, v => { r = v; });
  assert.deepEqual(r, { cancel: true });
  ses.before({ url: "app://ui/main.js" }, v => { r = v; });
  assert.deepEqual(r, { cancel: false });
  const throwing = hardenSession(fakeSession(), { allowRequest: () => { throw new Error("x"); } });
  assert.equal(throwing, undefined);
  const dl = ev();
  ses.emit("will-download", dl, {}, {});
  assert.equal(dl.prevented, true);
});

test("hardenSession: a throwing allowRequest cancels the request", () => {
  const ses = fakeSession();
  hardenSession(ses, { allowRequest: () => { throw new Error("boom"); } });
  let r;
  ses.before({ url: "app://ui/main.js" }, v => { r = v; });
  assert.deepEqual(r, { cancel: true });
});
