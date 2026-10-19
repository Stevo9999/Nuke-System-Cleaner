import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const rd = rel => fs.readFileSync(fileURLToPath(new URL("../../" + rel, import.meta.url)), "utf8");

test("main.mjs: userData moved under LOCALAPPDATA\\Nuke-Uninstaller, single-instance, no menu, web-contents-created hardening", () => {
  const s = rd("app/main/main.mjs");
  assert.match(s, /app\.setPath\(\s*["']userData["']\s*,\s*paths\.electronDir\s*\)/);
  assert.ok(s.search(/setPath\(\s*"userData"/) < s.indexOf("whenReady"), "setPath before ready");
  assert.match(s, /requestSingleInstanceLock\(\)/);
  assert.match(s, /registerSchemesAsPrivileged\(\s*\[\s*\{\s*scheme:\s*"app",\s*privileges:\s*\{\s*standard:\s*true,\s*secure:\s*true\s*\}\s*\}\s*\]\s*\)/);
  assert.match(s, /setApplicationMenu\(\s*null\s*\)/);
  assert.match(s, /loadURL\(\s*["']app:\/\/ui\/index\.html["']\s*\)/);
  assert.match(s, /on\(\s*["']web-contents-created["']/);
  assert.match(s, /hardenContents\(/);
  assert.match(s, /hardenSession\(/);
  assert.match(s, /UI_CSP/);
  assert.match(s, /resolveUi\(/);
  for (const bad of [/\binnerHTML\b/, /\beval\(/, /new Function/, /child_process/, /\bspawn/, /nodeIntegration:\s*true/, /shell\.openExternal/, /\bnet\.fetch/])
    assert.ok(!bad.test(s), "main.mjs must not contain " + bad);
});

test("renderer placeholder and preload have no unsafe sinks", () => {
  for (const f of ["app/preload/preload.cjs", "app/renderer/index.html"]) {
    const s = rd(f);
    for (const bad of [/\binnerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/])
      assert.ok(!bad.test(s), f + " must not contain " + bad);
  }
  const html = rd("app/renderer/index.html");
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  assert.deepEqual(scripts, ['<script type="module" src="main.js">'], "only the same-origin module script");
  assert.ok(!/\son[a-z]+\s*=/i.test(html) && !/style\s*=/i.test(html) && !/<style/i.test(html), "no inline handlers or styles under the CSP");
});

test("package.json: electron pinned exactly (no ^ or ~), main is app/main/main.mjs, test script unchanged, lockfile present", () => {
  const pkg = JSON.parse(rd("package.json"));
  assert.equal(pkg.name, "nuke-uninstaller");
  assert.equal(pkg.productName, "Nuke-Uninstaller");
  assert.equal(pkg.main, "app/main/main.mjs");
  assert.equal(pkg.scripts.start, "electron .");
  assert.equal(pkg.scripts.test, "node --test --test-concurrency=1");
  assert.ok(pkg.scripts.fixture);
  assert.ok(pkg.engines && pkg.engines.node);
  assert.match(pkg.devDependencies.electron, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.dependencies, undefined);
  const lock = JSON.parse(rd("package-lock.json"));
  assert.equal(lock.packages["node_modules/electron"].version, pkg.devDependencies.electron);
  assert.equal(lock.name, pkg.name);
});

test("Task 15 main.mjs wiring: identity once, sandbox, ritual session allow-list, no app:// on the ritual partition, exact warning text", () => {
  const s = rd("app/main/main.mjs");
  assert.match(s, /app\.enableSandbox\(\)/);
  assert.equal((s.match(/readIdentity\(/g) || []).length, 1, "identity read once");
  assert.match(s, /createController\(\{/);
  // the ritual partition gets its own request policy: only http://127.0.0.1:<port>/ of the current run
  assert.match(s, /hardenSession\(\s*ritualSession\s*,\s*\{\s*allowRequest:\s*isRitualUrl\s*\}\s*\)/);
  assert.match(s, /serveUi\(\s*session\.defaultSession\s*\)/);
  assert.ok(!/serveUi\(\s*ritualSession\s*\)/.test(s) && !/for \(const ses of \[session\.defaultSession, session\.fromPartition\("ritual"\)\]\)/.test(s), "ritual partition must not serve app://");
  assert.match(s, /\^http:\\\/\\\/127\\\.0\\\.0\\\.1:\(\\d\{1,5\}\)\\\/\\\?t=\[0-9a-f\]\{64\}\$/, "ritual url shape checked");
  // Task 20: one window. Results and ritual are WebContentsViews of the main window (no second BrowserWindow).
  assert.equal((s.match(/new BrowserWindow\(/g) || []).length, 1, "only the main BrowserWindow");
  assert.ok(!/windowOptions\(\s*"(ritual|results)"/.test(s));
  assert.match(s, /new WebContentsView\(\s*viewOptions\(\s*kind\s*,\s*\{\s*preload:\s*PRELOAD/);
  assert.match(s, /viewHost\.attach\(\s*"results"\s*,\s*"app:\/\/ui\/results\.html"\s*\)/);
  assert.match(s, /viewHost\.attach\(\s*"ritual"\s*,\s*url\s*\)/);
  assert.match(s, /trust:\s*wcId => trustedIds\.add\(wcId\)/);
  assert.match(s, /untrust:\s*wcId => trustedIds\.delete\(wcId\)/);
  assert.match(s, /registerIpc\([^;]*event\.sender\.id === id/, "ritual cancel is main-window only");
  assert.ok(!/dialog\.show\w+\(\s*(resultsWindow|ritualWindow)/.test(s) && /const dialogParent = \(\) => \(live\(mainWindow\) \? mainWindow : undefined\)/.test(s), "native dialogs are parented to the main window");
  // the single web-contents-created hook covers every WebContents (views included): not filtered by window type
  assert.match(s, /app\.on\(\s*"web-contents-created"[\s\S]*?contents\.session === ritualSession[\s\S]*?hardenContents\(contents/);
  assert.ok(s.includes('"Deleting is permanent: these items do not go to the Recycle Bin. A system restore point protects Windows settings and installed programs, but it does NOT bring back your own files (documents, pictures and so on)."'));
  assert.ok(!/showMessageBox/.test(s), "no native message boxes: questions are in-window (question.mjs)");
  assert.match(s, /questions\.ask\(\s*"permanent"\s*,\s*PERMANENT_WARNING\s*\)/);
  assert.match(s, /questions\.ask\(\s*"restore"/);
  // the only OS-level popups left: the file/folder pickers and the fatal-start / internal-crash error boxes
  assert.deepEqual([...s.matchAll(/dialog\.(\w+)\(/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort(), ["showErrorBox", "showOpenDialog"]);
  assert.equal((s.match(/new BrowserWindow\(/g) || []).length, 1);
  assert.ok(!/window\.open|setWindowOpenHandler\([^)]*allow/.test(s));
  assert.match(s, /properties:\s*\["openFile"\]/);
  assert.match(s, /properties:\s*\["openDirectory"\]/);
  assert.match(s, /buildProtection\(\{\s*appDir:/); // 19C: appProtectedPaths/Roots + known folders are built in appdata.mjs
  // the token url is handed to the ritual window only: never logged, never sent to a renderer
  assert.ok(!/console\.(log|error|warn)\([^)]*url/i.test(s));
  assert.ok(!/send\([^)]*url/i.test(s));
});

test("Fix round 1 main.mjs: every loadURL has a silent catch; ritual load failure closes the window; fatal start-up shows a fixed message", () => {
  const s = rd("app/main/main.mjs");
  const ev = rd("app/main/embedded-view.mjs");
  const all = (s + ev).match(/\.loadURL\(/g) || [];
  const caught = (s + ev).match(/\.loadURL\([^)]*\)\.catch\(\(\) => \{\}\)/g) || [];
  assert.ok(all.length >= 2);
  assert.equal(caught.length, all.length, "every loadURL ends in .catch(() => {})");
  assert.match(ev, /on\("did-fail-load"/);
  for (const bad of [/console\./, /validatedURL/, /console-message/, /\binnerHTML\b/, /child_process/]) assert.ok(!bad.test(ev), "embedded-view must not contain " + bad);
  assert.match(s, /dialog\.showErrorBox\(\s*"Nuke-Uninstaller"\s*,\s*FATAL_TEXT\s*\)/);
  assert.match(s, /process\.on\("unhandledRejection"/);
  assert.match(s, /process\.on\("uncaughtException"/);
  for (const m of s.matchAll(/console\.(log|error|warn|info)\(([^;]*)/g)) assert.match(m[2], /^"Nuke-Uninstaller cannot start: " \+ \(e && e\.message\)\)$|^"[^"]*"\)$/, "console call prints fixed text only: " + m[0]);
  assert.ok(!/console-message/.test(s) && !/validatedURL/.test(s), "no handler reads or prints load urls or ritual console text");
});
