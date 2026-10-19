# Nuke - System Cleaner

A Windows app that finds files that are safe to remove, shows them to you, and deletes the ones you pick only after you
personally turn a key and press a big red button in a 3D room. This repository also contains the older `/nuke` command
for Claude Code (session cleanup); that is described further down under "The /nuke command".

**Deletion is permanent.** Nothing goes to the Recycle Bin. A Windows restore point does **not** bring back your own files.

**Status, said plainly.** The engine and the app code are covered by automated tests (see "Tests"). The real Windows
pieces have **not** been exercised yet: the Electron window itself, the real UAC prompt, and the real restore-point
behaviour. A hands-on rehearsal is still pending. (The newest screens, the Browsers cleaner and the Exclusions list, were also
looked at once in a running window against a throwaway fake profile only; no real browser data was ever read or touched, and
that is not the rehearsal.) Nobody can promise zero vulnerabilities; this design tries to be narrow,
reviewed and honest about its limits.

> **Warning: administrator mode from a source folder is NOT safe if that folder can be changed by other accounts.** On many PCs a data drive such as `D:\`, and any folder you create on it (say `D:\Tools\nuke`),
> can be changed by any local account, so code that runs as administrator could be replaced first. Do not use administrator
> mode until you have either installed the packaged app under `C:\Program Files`, or fixed the whole folder chain. Details
> in "Hardening you still own (icacls)" below. Standard mode is **also** affected in a smaller way: running from the source
> folder on `D:\` lets any local account change the code that then runs as you, so the packaged copy under
> `C:\Program Files` is the safer place for both modes.

## What the app does

* **Smart Scan.** Looks only in a fixed, reviewed list of known-junk places (Windows and user temp folders, error reports,
  crash dumps, thumbnail and browser caches, your Recycle Bin, and similar). It does not guess. It also lists startup items
  for your information only; it never changes them.
* **Manually find a file to investigate.** You pick a file, shortcut, program or folder. The app traces what belongs to it
  (a shortcut's target, the program's entry and install folder, matching leftover folders and Start Menu shortcuts) and
  shows what it found.
* **Pick a folder to investigate.** You pick a folder (standard mode only). The app investigates it the same way (what belongs
  to it, who else uses it) and offers that folder for removal; it is **not** a scan for junk inside the folder. In addition it
  checks, read-only, whether the folder belongs to **one** installed program, and the flow is:
  1. **Detect.** A program is "the app of this folder" only when its Uninstall entry's `InstallLocation` equals the folder, or the
     folder equals or contains the folder of its `DisplayIcon` file or of its uninstaller program, by exact canonical path
     comparison (`C:\Foo` is not `C:\FooBar`; a child of the install folder is not a match; nothing under `C:\Windows`
     counts; never by name). An entry whose command cannot be parsed exactly, or whose text is lossy, is reported and not run.
     If several different programs match, no uninstaller is offered. In all these cases (and when the program list could not
     be read completely) only the leftover scan below runs, as before.
  2. **Ask first.** An in-window question: "This folder belongs to <App>. Run its own uninstaller first? It will run: <exact
     command>". **No, only look for leftovers** runs nothing and goes straight to the leftover scan. **Yes** runs that one command
     through the same path as Installed programs (phase text "Running the uninstaller of <App>...", with a Stop waiting button that
     only stops the waiting; the uninstaller is never killed).
  3. **Restart check**, right after the uninstaller exits: a restart is needed when its exit code is 3010 or 1641 (1641 means
     Windows may restart by itself, and the prompt says so), or when the read-only `PendingFileRenameOperations` value under
     `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager` mentions a path inside the picked folder or the app's install folder.
     If so, the app asks "...Windows must restart to finish removing <App>. You can keep cleaning leftovers now and restart later.
     Continue?" (No stops here). This app never restarts Windows.
  4. **Sweep.** Only now the normal leftover scan runs, on the picked folder and on the app's install folder (merged), and the
     normal results screen opens (only high-confidence items pre-ticked). Nothing is deleted until you press Delete them! and
     finish the usual warning, restore point and key (or simple confirm) steps.
  5. **Re-check.** After that delete run the same folder(s) are scanned again and the final text says either "Re-check: nothing
     left" or "Re-check: N items could not be removed (in use or waiting for a restart)" with up to 5 names. If a restart is
     needed or items are still there, the notice "Restart Windows when you are ready to finish removing <App>." stays on the
     screens until you close the app. It is a notice only.
* **Your user folder only (R45).** For a file or folder you pick, only items inside your own Windows user folder
  (`%USERPROFILE%`, and never that folder itself) can be ticked for deletion; anything outside it is shown only (to be
  deleted by hand). If the app cannot determine a valid user folder, nothing from a picked file or folder can be deleted.
* **Results screen** (inside the same window). Each item has a size, a group and a confidence. Buttons: Cancel, Scan Again (re-scans and shows what
  is new, gone or resized), and Delete them!.
* **Delete them!** warns that deletion is permanent, optionally makes a Windows restore point, then shows the 3D final confirmation inside the same window (a slim bar on top has "Cancel - nothing will be deleted"; the app closes the confirmation by itself if you do not finish in time, with a countdown shown).
  You drag the key to the lock and turn it; the lock unclicks; you lift the hinged glass cover (it stays attached and can
  be closed again) and press the red button. Only then does anything get deleted.
* **Simple confirm screen (Settings).** The switch "Turn off the nuke-key animation" (off by default) swaps the 3D room for a
  plain page (`cleanup-plain.html`): the list and total, an Unlock button, and then, after the same waiting time, a Delete
  permanently button. It uses exactly the same one-time server steps (token, unlock, minimum gap, confirm, audit log, age
  re-check, automatic close with countdown, Cancel); only the front end differs, and the choice is made by the app from its own
  settings, never by the page.
* **Windows tools.** A home-screen list of one-click shortcuts to built-in Windows tools (System Restore, Task Scheduler,
  Services and similar). The list is fixed in `lib/wintools.mjs`; the window only sends the name of one entry. The app changes
  nothing itself and never elevates (a tool may show its own Windows prompt); the screen is not offered in administrator mode.
* **Browsers cleaner.** A home-screen button that scans the cache folders of Chrome, Edge, Brave, Opera, Opera GX and Firefox
  and shows them on the normal results screen ("Browser leftovers"), with the same warning, key and button as every other
  delete. Two plain groups: **Browser cache** (safe to remove, your pages just load a little slower the first time; ticked for
  you like other vetted junk, but only when the folder is old enough and nothing has it open) and **Browsing history** (only
  the Chromium `History`, `Visited Links` and `Top Sites` files; **never ticked for you**, "fairly sure" at most, each row says
  what removing it does). Cookies, saved passwords, saved forms, bookmarks, extensions, preferences, `Local State` and Firefox's
  `places.sqlite` (it also holds your bookmarks), `key4.db` and `logins.json` are never listed; the list of places is fixed in
  `lib/browsers.mjs`, with a never-touch list the scan also checks at run time. A browser that is running keeps some files open:
  those are skipped and the results say "Close your browsers for a complete clean". The 24-hour age rule applies to the whole
  cache sub-folder, so a browser used today may show little until you close it and try again tomorrow. Not offered in
  administrator mode, and every item must lie inside your user folder (R45).
* **Exclusions (Settings).** A plain list "Folders this app must never touch" (Add folder... opens the folder picker; Remove
  takes one off). Up to 50 folders, drive-letter paths only (no network paths, no `..`, never a whole drive, no duplicates).
  They are kept in `settings.json`. They are enforced in the main process, not the window: every scan treats them as protected
  (so nothing at, inside or around them is found), the main process drops any such item from what it shows, and the delete step
  checks again - when you press Delete and again right before the run starts - and refuses an item that is, sits inside, or
  contains an excluded folder, even if its id is sent directly. If the settings file cannot be read, scans and deletes stop
  (the list is unknown) until you change a Settings switch, which writes a clean file.
* Registry cleaning is **phase 2 and is not in this app**. Phase 1 only reads a few registry keys to trace programs and
  never writes or deletes registry data.

## How to run

From a PowerShell window in the project folder:

```powershell
npm ci
npm start
```

`npm ci` installs the pinned dependencies and **downloads the Electron binary (about 100 MB)**, so it needs internet access
and your OK before you run it. `npm start` fails until it has been run once.

This starts Electron on the source tree. A packaged copy (no `npm` needed afterwards) is built by `npm run package` into

```
%LOCALAPPDATA%\Programs\Nuke System Cleaner\<version>\Nuke System Cleaner.exe
```

The package step **refuses to run if that folder already exists** (it never deletes or overwrites). It needs the
`@electron/packager` development tool, which is **not installed yet** (installing it downloads from npm), so the packaged
build has **not** been made or smoke-tested yet. Pending steps, to be run after you approve the download:

1. `npm install --save-dev --save-exact @electron/packager@<version>` (this also updates `package-lock.json`)
2. `npm run package`
3. Start the printed `Nuke System Cleaner.exe`, open Settings, check it says Standard mode, close it.

### Putting the packaged build under Program Files

Administrator mode is only offered for a packaged copy whose program file is under `C:\Program Files` or
`C:\Program Files (x86)` (Ruling R46); from the source tree or from `%LOCALAPPDATA%` the app hides the button and says
"Administrator mode is only offered for a copy installed in C:\Program Files". These steps are **untested** (the packaged
build has not been made yet):

1. `npm run package` builds under `%LOCALAPPDATA%\Programs\Nuke System Cleaner\<version>`.
2. In an **elevated** PowerShell (Run as administrator), copy that folder to `C:\Program Files\Nuke System Cleaner\<version>`,
   for example `Copy-Item -Recurse "$env:LOCALAPPDATA\Programs\Nuke System Cleaner\<version>" "C:\Program Files\Nuke System Cleaner\<version>"`.
3. Start `C:\Program Files\Nuke System Cleaner\<version>\Nuke System Cleaner.exe`. Open Settings: the Relaunch button should be
   there. The copy under `%LOCALAPPDATA%` can then be removed by hand.

## Safety model

* **Browser items are ordinary findings.** The Browsers cleaner uses the same engine, groups, confidence rules, age and lock
  checks, protected folders, link/junction refusal and delete funnel as Smart Scan; it adds no way to delete and starts no process.
  Its only extra rules: personal browser data is never in its table, history is never pre-ticked, and items must lie inside your
  user folder.

* **Vetted places only.** Smart Scan candidates come from one reviewed data table, `lib/junk-locations.mjs`, with a reason
  for every entry. Anything not in the table is not offered. Files younger than the table's age floor (24 hours for
  temp-type files) and files that are locked right now are skipped, never forced.
* **Groups.** Every item is in exactly one group: **exclusive** (only this thing uses it), **shared** (something else may
  use it), **protected** (never deletable; shown so you know it was seen), or **report-only** (shown for information; the
  app never changes it, for example services, scheduled tasks and startup items). Unknown or odd data fails closed to
  protected.
* **Confidence.** high, medium or low. **Only high is pre-ticked**, and a shared item is never high. You can tick medium
  and low items yourself.
* **Protected folders.** Your documents-type folders, the app itself, its data folder and the tool's own files can never
  be a deletion target. Every path is checked again immediately before it is deleted (links and junctions are not followed,
  system folders, your home folder and drive roots are refused).
* **Frozen selection.** When you press Delete, the app freezes exactly the ticked ids it holds itself; the page and the
  window only send ids, never paths. The one-shot local server that does the deleting needs a per-run token and
  the unlock-then-confirm steps from the 3D room.
* **Restore point (honest version).** A Windows restore point protects **Windows settings and installed programs**. It does
  **not** protect personal files, so it cannot undo this app. Creating one **needs administrator approval** (a normal UAC
  prompt) and Windows allows **only one new restore point per 24 hours**; if one already exists the app tells you it was
  skipped and never works around the limit. The restore step reports one of: made, skipped (24-hour limit), needs
  administrator, disabled by policy, or failed. You can switch it off in Settings (on by default). In **standard** mode this
  step also needs administrator approval (the UAC prompt appears for the restore step alone), and it uses the same
  user-writable run and restore folders described under R43 below.

### Administrator mode limits

"Relaunch as administrator" asks Windows (UAC) to start a second copy of the app with elevated rights. In that mode:

* The app offers and deletes **only loose files directly inside** `C:\Windows\Temp`, `C:\Windows\Minidump`, and the Windows
  Error Reporting `ReportArchive` and `ReportQueue` folders under `C:\ProgramData\Microsoft\Windows\WER`. No subfolders,
  no nested files, no folders.
* **Per-user files are report-only while elevated.** To clean your own files, use the normal (standard) mode.
* **No service is stopped** and no setting is changed (so the Windows Update download cache stays report-only).
* **If the app cannot tell whether it is running as administrator, deleting is turned off** (the results screen says so
  and keeps Delete disabled). Scans still run, read-only.
* If Windows is not installed on `C:`, the administrator folders are not recognised and the elevated mode offers nothing.

## Every process this code can start

No shell is ever used: each start is an absolute `C:\Windows\...` program path, an argument array, `shell: false`. The Windows
folder is the fixed text `C:\Windows`; it is never read from `%SystemRoot%` or any other environment variable (a same-user
program can change those). The test `test/inventory.test.mjs` pins this list exactly and fails if a new one appears.

| Program (under `C:\Windows\System32`) | Started from | Exact arguments | Purpose |
|---|---|---|---|
| `rundll32.exe` | `run.mjs` (the `/nuke` command line only, not the Electron app) | `url.dll,FileProtocolHandler <the one-time http://127.0.0.1:<port>/?t=<64 hex> URL>` | hand the local page to your default browser |
| `powershell.exe` (`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`) | `lib/winapps.mjs` | `-NoProfile -NonInteractive -EncodedCommand <base64>` (fixed list script, or `Remove-AppxPackage -Package '<full name>'` for the one app you confirmed; current user only) | list and remove Windows (Store) apps |
| the selected program's own uninstaller | `lib/uninstall-run.mjs` | exactly the command stored in that program's own uninstall entry, shown to you and confirmed first (`MsiExec` entries become `C:\Windows\System32\msiexec.exe /X{GUID}`); `shell: false` | run the uninstaller of the program you picked |
| `reg.exe` | `lib/sysread.mjs` | `query <key>` for twelve fixed keys: `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager` with `/v PendingFileRenameOperations` (restart check after an uninstaller; read only); Uninstall (HKLM, HKLM Wow6432Node, HKCU) with `/s`; Run and RunOnce (HKCU, HKLM, Wow6432Node Run) with no extra flag; `HKLM\SYSTEM\CurrentControlSet\Services` with `/s /v ImagePath`; `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders` with no extra flag; `HKCU\SOFTWARE\Microsoft\OneDrive\Accounts` with `/s /v UserFolder` | read-only: installed programs, startup entries, services, and redirected Documents/Desktop/OneDrive folders (to protect them) |
| `schtasks.exe` | `lib/sysread.mjs` | `/query /fo csv /v /nh` | read-only: list scheduled tasks |
| `whoami.exe` | `lib/sysread.mjs` | `/user /fo csv /nh` and `/groups /fo csv /nh` | read-only: your account id and whether you are an administrator |
| `WindowsPowerShell\v1.0\powershell.exe` | `lib/restore.mjs` | `-NoProfile -NonInteractive -EncodedCommand <base64>` | create and verify one restore point. When not elevated, this script runs `Start-Process -Verb RunAs` and so starts a **second, elevated** `powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>` (its own script, which calls `Checkpoint-Computer` and `Get-ComputerRestorePoint`); when already elevated the inner script runs directly. The script texts are pinned by `test/inventory-scripts.test.mjs` |
| `WindowsPowerShell\v1.0\powershell.exe` | `app/main/elevation.mjs` | `-NoProfile -NonInteractive -EncodedCommand <base64>` | `Start-Process -FilePath '<this app>' [-ArgumentList ...] -Verb RunAs` to relaunch as administrator (shows the UAC prompt) |
| `rundll32.exe` | `lib/wintools.mjs` | `shell32.dll,ShellExec_RunDLL <tool program> [<snap-in>]`, where the tool is one entry of the fixed list below (nothing else can be given) | "Windows tools" screen: asks Windows to start one built-in tool the way double-clicking it would, so a tool that needs administrator approval shows its own Windows prompt (this app itself is never elevated); `shell: false`, detached |

The fixed "Windows tools" list (every file is in `C:\Windows\System32`; the window can only send the name of one entry, never a path or an argument):
`rstrui.exe` (System Restore), `msinfo32.exe` (System Information), `mmc.exe` with exactly one of `services.msc`, `taskschd.msc`,
`diskmgmt.msc`, `eventvwr.msc`, `compmgmt.msc` or `fsmgmt.msc` (Services, Task Scheduler, Disk Management, Event Viewer, Computer
Management, Shared Folders), `dfrgui.exe` (Disk Defragmenter), `osk.exe` (On-Screen Keyboard), `resmon.exe` (Resource Monitor),
`taskmgr.exe` (Task Manager), `cleanmgr.exe` (Windows' own Disk Cleanup, which asks before it removes anything),
`optionalfeatures.exe` (Windows Features) and `control.exe` with `appwiz.cpl` (Programs and Features). Each is given to
`ShellExec_RunDLL` as its full `C:\Windows\System32\...` path (the snap-in or `.cpl` file as a second full path). It is started
through `rundll32.exe` rather than directly because several of these programs ask for administrator rights or UI access in
their manifests, which a plain process start cannot satisfy.

The script text travels only inside `-EncodedCommand`; every value placed in it is a single-quoted PowerShell literal and
the paths are validated first (absolute local drive paths, no wildcards, no control characters). Development-only helper
scripts in `fixture/` also start processes (`node`, `cmd /c mklink /J` for a junction test fixture, PowerShell in the app
fixture); they are not part of the packaged app and are listed in the same test.

## Where it stores data

Before the rename to Nuke - System Cleaner the folder was `%LOCALAPPDATA%\Nuke-Uninstaller\`. On start, if the new folder has no `settings.json` and the old one has a plain `settings.json`, the two switches and the excluded-folder list are read through the same strict loader and the sanitised result is saved into the new folder (`migrateLegacySettings` in `app/main/appdata.mjs`). `run\`, `electron\` and logs are never copied, the old folder is never changed or deleted, and any oddity means nothing is migrated and startup continues. The old folder can be deleted by hand.

Everything is under `%LOCALAPPDATA%\Nuke System Cleaner\`: `settings.json` (the restore-point switch, the "simple confirm screen" switch and the list of excluded folders), `run\` (the one-run
lock, the frozen `selection.json` and the audit log: paths and sizes, never file contents) and `electron\` (Electron's own profile data). No network access, no telemetry, no accounts, no API keys.

## Electron hardening (summary)

* Windows use `contextIsolation`, the Chromium `sandbox`, no `nodeIntegration`, no `webview`, `webSecurity` on.
* The interface loads only from a private `app://ui/` protocol with a fixed file allow-list and a strict Content Security
  Policy; navigation, new windows and permission requests are denied; the page can only call a short list of validated IPC
  channels, and the main process checks the sender of each call.
* The 3D room is **designed** to run in its own in-memory session that may only reach `http://127.0.0.1:<port>/` of the
  current run. This is design intent from the code and its tests; it has **not** been verified in a running Electron yet.
* Untrusted text (file and registry names) is shown with `textContent` only: no `innerHTML`, no `eval`.
* The app is **designed** to allow only one running copy (single-instance lock); not yet verified in a running Electron.
* The Electron fuses are **not changed** (see residual risks).

## Tests

From **PowerShell** (a few junction and locked-file tests fail under Git Bash for environment reasons):

```powershell
node --test --test-concurrency=1
```

Tests use temp folders and `fixture/` only; they never touch your real folders. What the tests do **not** cover: the real
Electron window, the real UAC prompt and the real Windows restore point. Those need the hands-on rehearsal.

## Hardening you still own (icacls)

Administrator mode runs whatever program files you start as administrator. If any of those files, **or any folder above
them**, can be changed by another account, that account can swap in its own code and get administrator rights. On a typical data drive,
`D:\` and `D:\Tools\nuke` grant **Users** and **Authenticated Users** full control (check yours with `icacls`), and so,
through the root, can `D:\Tools`. Tightening only `D:\Tools\nuke` is **not enough**: anyone can still rename
`D:\Tools` or `D:\Tools\nuke` and put their own copy in its place. **Administrator mode from the source folder is unsafe
until one of these is done:**

* **(a) Recommended: install the packaged app under `C:\Program Files`** (or any location whose whole parent chain only
  administrators can write to), and run administrator mode only from there. The packaging script's default target
  `%LOCALAPPDATA%\Programs\...` is writable by your own account and every program running as you, so it is fine for standard
  mode but is **not** a safe place to run administrator mode from.
* **(b) Fix the whole chain** `D:\` then `D:\Tools` then `D:\Tools\nuke`: for each of the three, check with `icacls` and make
  sure "Users" and "Authenticated Users" have no (M)odify/(W)rite/(F)ull rights, here or inherited. Changing `D:\` itself
  affects everything on that drive, so think before you do it; this is your decision, the app never changes permissions.

```powershell
icacls D:\
icacls D:\Tools
icacls D:\Tools\nuke
# look for "Users" / "Authenticated Users" with (M), (W) or (F), including inherited (I) entries.
```

Until (a) or (b) is done, use standard mode only.

## Residual risks and known limits

* **The run and restore folders are user-writable (R43), in standard mode too.** The restore step (which asks for
  administrator approval even in standard mode) and every run use `%LOCALAPPDATA%\Nuke System Cleaner\run` and `restore`.
  During an administrator run the app still writes its lock file, the
  frozen selection, the audit log and the restore folder under `%LOCALAPPDATA%\Nuke System Cleaner\`, which any program
  running as you can write to. A program running as you could try to redirect those writes with a junction. A real fix
  needs an administrator-only folder and was not done in this version. Administrator mode is opt-in; if that risk is not
  acceptable, do not use it.
* **Electron fuses are not changed.** The hardening switches that Electron offers for the packaged executable (for example
  turning off Node-style run modes and limiting where the app code may load from) are left at their defaults.
* **The package is not an asar archive (`asar: false`).** The app files are plain, editable files in the install folder, with
  no integrity protection. Anyone who can write to that folder can change the app's code, which is another reason to
  install it somewhere only administrators can write (see the icacls section) before using administrator mode.
* **A different administrator account.** If UAC asks for another administrator's password, the elevated copy runs as that
  account and scans that account's folders, not yours. This is the wrong scope, not unsafe, but it is not what you want.
* **Windows on a drive other than `C:`** is not supported in administrator mode; it fails closed (offers nothing).
* **Not yet exercised on a real machine:** the Electron window and its page under the sandbox, the real UAC prompt,
  single-instance behaviour during relaunch, and real restore-point behaviour (including Windows' exact wording). The
  packaged build has not been made. A rehearsal is pending.
* Anything running as the same Windows user can read what you can read and talk to the local server of a run. The physical
  key-and-button step stops a careless program, not malware running as you.
* Cannot promise zero vulnerabilities. Registry cleaning is phase 2 and is not present. Services, scheduled tasks and
  startup items are shown only. Requires Node 22 or newer for the scripts; Windows only.

---

# The /nuke command

`/nuke` finds the files that belong to the CURRENT Claude Code session (its transcript, file history, memory notes, and
files it provably created), shows them grouped, and deletes the ones you pick after you personally turn a key and press
a red button on a local web page. **Deletion is permanent** (nothing goes to the Recycle Bin). The Electron app above reuses
this engine.

## How a run goes

1. `node run.mjs scan --session auto --nonce <fresh word>` (read-only). The nonce is how the tool finds the current
   session: it is the one transcript containing that word. It prints the groups and one `NUKE_META={...}` line.
2. You confirm the session, then the list. `node run.mjs launch --session <id> --nonce <word> --bind <token> --ids '<ids>'`
   rescans, checks the bind token, starts a single-use server on 127.0.0.1 and opens your **default browser** itself.
   The one-time URL is never printed (only in the sandbox, with `--print-url true`).
3. You drag the key, turn it (the lock unclicks), lift the hinged glass, press the button. Only then does the server delete.
4. The audit log `out/nuke-audit.log` records `started`, then `done` (or `failed`/`aborted`/`expired`) with a per-run
   `runId`: paths and sizes only, never file contents.

## Safety model (the /nuke command)

* Candidates come from the session transcript and Claude's own session-keyed folders. A file is **exclusive** (pre-selected)
  only with proof: a Write tool call that returned success AND the file was created after the session began. Edits,
  denied or failed writes, older files, files named only in shell commands, and anything another session mentions are
  **shared** (off by default, named explicitly to delete).
* Live items (this running session's own files) are never deleted by this tool. Remove them by hand after the session ends.
* Protected: settings, hooks, plugins, commands, skills, other sessions' transcripts, `MEMORY.md`, and this tool's own
  files (`run.mjs`, `scan.mjs`, `server.mjs`, `cleanup.html`, `lib/`, `vendor/`, `out/`, `sounds/`, `app/`, `scripts/`).
* Every path is re-checked immediately before each delete (roots, protected list, live list, links/junctions, system
  folders, home, drive roots). Links are unlinked, never followed.
* The server is the only deleting code path. It binds 127.0.0.1, needs the per-run token, exact Host/Origin, a JSON body,
  an `unlock` then (after a gap) a `confirm`, and checks that the selection file still has the launch-time hash.
  The agent never holds the token: the browser is opened by `run.mjs` itself.
* The page runs only its own inline scripts (CSP script hashes, no `unsafe-inline` for scripts) and the vendored
  three.js 0.160.0 files in `vendor/` (sha384 pinned in `test/cleanup-page.test.mjs`). No CDN.
* One server at a time (`out/nuke.lock`).

## Hardening (the /nuke command)

This folder must not be writable by other accounts, or anything that can edit `run.mjs`/`server.mjs`/`cleanup.html`
could run code as you or fake a confirmation. See "Hardening you still own (icacls)" above for the commands. Or move the
tool into your user profile (for example `%USERPROFILE%\nuke`), which is private by default. `run.mjs` does not check its own
folder's permissions: reading them would need another process start.

## Known limits (the /nuke command)

* Anything running as the same Windows user can read the one-time URL from the browser's command line or talk to the
  local server. The physical key-and-button step stops a careless model, not malware running as you.
* The session is found by the nonce in its own transcript; if the transcript is not flushed yet, rerun once with a new nonce.
* Liveness comes from `~/.claude/sessions/<pid>.json`; an unreadable file fails open for that session (the scan still
  shows its session-keyed files as live only if the file parses).
* Off-disk things (artifacts published to claude.ai, anything outside this computer) and `settings.json` hooks/plugins
  are never touched.
* A closed or reloaded page does not cancel: the run closes automatically after 60 seconds.
* Requires Node 22 or newer.
* `node fixture/launch-sandbox.mjs` starts the page against the sandbox fixture (prints `NUKE_URL=`); it never touches your
  real `~/.claude`.
