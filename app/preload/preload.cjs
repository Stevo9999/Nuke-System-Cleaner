"use strict";
// Minimal, explicit bridge. Each function wraps ipcRenderer.invoke with a literal channel.
// The renderer never receives ipcRenderer or an IPC event object, and no-arg calls forward no arguments.
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(eventName, cb) {
  if (typeof cb !== "function") throw new TypeError("callback must be a function");
  const handler = (_event, payload) => { cb(payload); };
  ipcRenderer.on(eventName, handler);
  return () => { ipcRenderer.removeListener(eventName, handler); };
}

contextBridge.exposeInMainWorld("nuke", {
  getSettings: () => ipcRenderer.invoke("nuke:settings:get"),
  setSettings: s => ipcRenderer.invoke("nuke:settings:set", s),
  getStatus: () => ipcRenderer.invoke("nuke:status:get"),
  programsList: () => ipcRenderer.invoke("nuke:programs:list"),
  programsUninstall: id => ipcRenderer.invoke("nuke:programs:uninstall", { id }),
  appsList: () => ipcRenderer.invoke("nuke:apps:list"),
  appsRemove: id => ipcRenderer.invoke("nuke:apps:remove", { id }),
  toolsList: () => ipcRenderer.invoke("nuke:tools:list"),
  toolsOpen: tool => ipcRenderer.invoke("nuke:tools:open", { tool }),
  scanStartup: () => ipcRenderer.invoke("nuke:scan:startup"),
  scanBrowsers: () => ipcRenderer.invoke("nuke:scan:browsers"),
  exclusionsAdd: () => ipcRenderer.invoke("nuke:exclusions:add"),
  exclusionsRemove: id => ipcRenderer.invoke("nuke:exclusions:remove", { id }),
  scanSmart: () => ipcRenderer.invoke("nuke:scan:smart"),
  scanInvestigate: () => ipcRenderer.invoke("nuke:scan:investigate"),
  scanFolder: () => ipcRenderer.invoke("nuke:scan:folder"),
  scanAgain: () => ipcRenderer.invoke("nuke:scan:again"),
  cancelScan: () => ipcRenderer.invoke("nuke:scan:cancel"),
  getResults: () => ipcRenderer.invoke("nuke:results:get"),
  deleteSelected: ids => ipcRenderer.invoke("nuke:delete", { ids }),
  closeResults: () => ipcRenderer.invoke("nuke:results:close"),
  relaunchAdmin: () => ipcRenderer.invoke("nuke:admin:relaunch"),
  cancelRitual: () => ipcRenderer.invoke("nuke:ritual:cancel"),
  closeRitual: () => ipcRenderer.invoke("nuke:ritual:close"),
  answerQuestion: answer => ipcRenderer.invoke("nuke:question:answer", { answer }),
  onQuestion: cb => subscribe("nuke:question", cb),
  onProgress: cb => subscribe("nuke:progress", cb),
  onPhase: cb => subscribe("nuke:phase", cb),
});
