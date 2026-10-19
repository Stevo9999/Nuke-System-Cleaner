import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { CHANNELS, EVENTS } from "../../app/main/ipc.mjs";

const SRC = fs.readFileSync(fileURLToPath(new URL("../../app/preload/preload.cjs", import.meta.url)), "utf8");
const EXPOSED = ["getSettings", "setSettings", "getStatus", "scanSmart", "scanStartup", "scanBrowsers", "exclusionsAdd", "exclusionsRemove", "programsList", "programsUninstall", "appsList", "appsRemove", "toolsList", "toolsOpen", "scanInvestigate", "scanFolder", "scanAgain", "cancelScan",
  "getResults", "deleteSelected", "closeResults", "relaunchAdmin", "cancelRitual", "closeRitual", "answerQuestion", "onQuestion", "onProgress", "onPhase"];

function load() {
  const invoked = [], listeners = new Map(), exposed = [];
  const ipcRenderer = {
    invoke: (ch, ...a) => { invoked.push([ch, a]); return Promise.resolve("r"); },
    on: (ev, h) => { listeners.set(ev, [...(listeners.get(ev) || []), h]); },
    removeListener: (ev, h) => { listeners.set(ev, (listeners.get(ev) || []).filter(x => x !== h)); },
  };
  const contextBridge = { exposeInMainWorld: (name, api) => exposed.push([name, api]) };
  const fakeRequire = id => { assert.equal(id, "electron"); return { contextBridge, ipcRenderer }; };
  vm.runInNewContext(SRC, { require: fakeRequire, module: { exports: {} }, console }, { filename: "preload.cjs" });
  return { invoked, listeners, exposed };
}

test("preload exposes exactly the listed functions and channel literals equal CHANNELS/EVENTS; never exposes ipcRenderer", async () => {
  const lits = new Set([...SRC.matchAll(/["'`](nuke:[a-z:]+)["'`]/g)].map(m => m[1]));
  assert.deepEqual([...lits].sort(), [...CHANNELS, ...EVENTS].sort());
  assert.ok(!/require\((?!["']electron["']\))/.test(SRC), "only electron required");
  assert.equal((SRC.match(/exposeInMainWorld/g) || []).length, 1);

  const { invoked, listeners, exposed } = load();
  assert.equal(exposed.length, 1);
  assert.equal(exposed[0][0], "nuke");
  const api = exposed[0][1];
  assert.deepEqual(Object.keys(api).sort(), [...EXPOSED].sort());
  for (const k of EXPOSED) assert.equal(typeof api[k], "function", k);
  assert.ok(!("ipcRenderer" in api));

  await api.getSettings();
  await api.setSettings({ restorePoint: false });
  await api.getStatus(); await api.scanSmart(); await api.scanStartup(); await api.scanInvestigate(); await api.scanFolder(); await api.scanAgain();
  await api.cancelScan(); await api.getResults(); await api.closeResults(); await api.relaunchAdmin(); await api.cancelRitual(); await api.closeRitual(); await api.answerQuestion(true);
  await api.deleteSelected(["0123456789abcdef"]);
  await api.toolsList(); await api.toolsOpen("services");
  await api.scanBrowsers(); await api.exclusionsAdd(); await api.exclusionsRemove("0123456789abcdef");
  assert.deepEqual(invoked.map(i => i[0]), ["nuke:settings:get", "nuke:settings:set", "nuke:status:get", "nuke:scan:smart", "nuke:scan:startup",
    "nuke:scan:investigate", "nuke:scan:folder", "nuke:scan:again", "nuke:scan:cancel", "nuke:results:get", "nuke:results:close",
    "nuke:admin:relaunch", "nuke:ritual:cancel", "nuke:ritual:close", "nuke:question:answer", "nuke:delete", "nuke:tools:list", "nuke:tools:open", "nuke:scan:browsers", "nuke:exclusions:add", "nuke:exclusions:remove"]);
  assert.equal(JSON.stringify(invoked[1][1]), JSON.stringify([{ restorePoint: false }]));
  assert.equal(JSON.stringify(invoked[17][1]), JSON.stringify([{ tool: "services" }]));
  assert.equal(JSON.stringify(invoked[18][1]), JSON.stringify([]));
  assert.equal(JSON.stringify(invoked[19][1]), JSON.stringify([]));
  assert.equal(JSON.stringify(invoked[20][1]), JSON.stringify([{ id: "0123456789abcdef" }]));
  assert.equal(JSON.stringify(invoked[16][1]), JSON.stringify([]));
  assert.equal(JSON.stringify(invoked[15][1]), JSON.stringify([{ ids: ["0123456789abcdef"] }]));
  assert.equal(JSON.stringify(invoked[14][1]), JSON.stringify([{ answer: true }]));
  // no-arg wrappers never forward caller arguments (a renderer cannot smuggle a path)
  invoked.length = 0;
  await api.scanFolder("C:\\Windows"); await api.scanSmart({ x: 1 }); await api.scanBrowsers("C:\\Windows"); await api.exclusionsAdd("C:\\Windows");
  assert.equal(JSON.stringify(invoked.map(i => i[1])), "[[],[],[],[]]");

  for (const [fn, ev] of [["onProgress", "nuke:progress"], ["onPhase", "nuke:phase"], ["onQuestion", "nuke:question"]]) {
    const got = [];
    const off = api[fn](p => got.push(p));
    assert.equal(typeof off, "function");
    const h = listeners.get(ev)[0];
    h({ sender: "SECRET", senderId: 1 }, { n: 1 });
    assert.equal(JSON.stringify(got), JSON.stringify([{ n: 1 }]), "payload only, never the event");
    off();
    assert.equal(listeners.get(ev).length, 0, "unsubscribed");
    assert.throws(() => api[fn]("notfn"));
  }
});
