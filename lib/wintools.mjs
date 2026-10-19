// lib/wintools.mjs: one-click launcher for a FIXED list of built-in Windows tools (the "Windows tools" screen).
// Every entry is a program that ships with Windows (absolute C:\Windows\System32 path, fixed arguments). Several of them
// (System Restore, Windows Features, the management consoles, Disk Defragmenter, the On-Screen Keyboard) cannot be started by a
// plain process start because their manifests ask for administrator rights or UI access, so the launcher asks Windows to start
// the entry the way double-clicking it would: rundll32.exe shell32.dll,ShellExec_RunDLL <program> [<snap-in>]. Windows then
// shows its own permission prompt where one is needed. This app is never elevated by it and changes nothing itself.
// No shell, no environment value, and nothing from a renderer except the key of one fixed entry.
// Nothing here deletes, formats, edits the registry or opens a command prompt.
// The only process this module starts is rundll32.exe with one fixed entry (the spawn site in openTool).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const S = "C:\\Windows\\System32\\";
const LAUNCHER = S + "rundll32.exe";
const entry = (label, description, file, ...args) => Object.freeze({ label, description, exe: S + file, args: Object.freeze(args.map(a => S + a)) });
// Management console snap-ins are opened with mmc.exe; the snap-in file is its (fixed) argument.
const mmc = (label, description, snapin) => entry(label, description, "mmc.exe", snapin);

export const WINTOOLS = Object.freeze({
  systemRestore: entry("System Restore", "Opens the Windows wizard for going back to an earlier restore point.", "rstrui.exe"),
  systemInfo: entry("System Information", "Shows details about this PC: Windows version, hardware and drivers.", "msinfo32.exe"),
  services: mmc("Services", "Lists the background services Windows runs and whether each one is on.", "services.msc"),
  taskScheduler: mmc("Task Scheduler", "Shows the jobs Windows and your programs have set to run on a schedule.", "taskschd.msc"),
  diskManagement: mmc("Disk Management", "Shows your drives and how they are divided up.", "diskmgmt.msc"),
  eventViewer: mmc("Event Viewer", "A log of what happened on this PC, including errors and warnings.", "eventvwr.msc"),
  computerManagement: mmc("Computer Management", "One window with many Windows management tools together.", "compmgmt.msc"),
  sharedFolders: mmc("Shared Folders", "Shows which folders on this PC are shared on your network and who is connected.", "fsmgmt.msc"),
  defrag: entry("Disk Defragmenter", "Optimize Drives: checks and tidies your drives so they run well.", "dfrgui.exe"),
  keyboard: entry("On-Screen Keyboard", "A keyboard you can click on the screen.", "osk.exe"),
  resourceMonitor: entry("Resource Monitor", "Live view of how busy the processor, memory, disk and network are.", "resmon.exe"),
  taskManager: entry("Task Manager", "Shows running programs and lets you close one that is stuck.", "taskmgr.exe"),
  diskCleanup: entry("Disk Cleanup", "Windows' own tool for clearing out its temporary files (it asks before it removes anything).", "cleanmgr.exe"),
  windowsFeatures: entry("Windows Features", "Turn optional Windows features on or off.", "optionalfeatures.exe"),
  programsAndFeatures: entry("Programs and Features", "The classic Windows list of installed programs.", "control.exe", "appwiz.cpl"),
});

// What the window gets to see: key, label and description only (never a program path).
export function toolList() {
  return Object.keys(WINTOOLS).map(key => ({ key, label: WINTOOLS[key].label, description: WINTOOLS[key].description }));
}

// The exact argument list the launcher is started with for one key (also used by the tests and the README check).
export const launchArgs = key => ["shell32.dll,ShellExec_RunDLL", WINTOOLS[key].exe, ...WINTOOLS[key].args];

export const isToolKey = k => typeof k === "string" && Object.hasOwn(WINTOOLS, k);

// Asks Windows to start one tool and does not wait for it to close. Resolves { ok: true } once the request was handed to Windows,
// otherwise { ok: false }.
export function openTool(key, { spawnFn = spawn, exists = existsSync } = {}) {
  if (!isToolKey(key)) return Promise.resolve({ ok: false });
  const tool = WINTOOLS[key];
  let there = false;
  try { there = exists(LAUNCHER) === true && exists(tool.exe) === true && tool.args.every(a => exists(a) === true); } catch { there = false; }
  if (!there) return Promise.resolve({ ok: false });
  return new Promise(resolve => {
    let child;
    try { child = spawnFn(LAUNCHER, launchArgs(key), { shell: false, detached: true, stdio: "ignore" }); } catch { resolve({ ok: false }); return; }
    if (!child || typeof child.once !== "function") { resolve({ ok: false }); return; }
    child.once("error", () => resolve({ ok: false }));
    child.once("spawn", () => { try { child.unref(); } catch { /* ignore */ } resolve({ ok: true }); });
  });
}
