# Nuke-Uninstaller

A Windows program that helps you **remove programs and the junk they leave behind**, with safety checks and a deliberately dramatic confirmation (a 3D key, a glass cover and a big red button) so nothing is deleted by accident.

It runs as a normal user, needs no account and no internet connection, and sends nothing anywhere.

**It is free, and it must stay free:** the license lets anyone use, copy and share it for noncommercial purposes, and does **not** allow selling it or using it for a business. See [License](#license).

> **Read the [disclaimer](#disclaimer) before you delete anything.** Deleting is permanent: files do not go to the Recycle Bin.

## What it can do

| Button | What it does |
|---|---|
| **Scan** | Smart Scan: looks only in a fixed list of safe places (temp files, caches, crash dumps, thumbnails, your Recycle Bin) and shows what could be freed. |
| **Manually find a file to investigate** | Pick a file, shortcut or program. The app follows it to the program it belongs to and lists the leftover files, folders and shortcuts that program made. |
| **Pick a folder to investigate** | Looks into a folder and checks whether other programs, sub-folders or shortcuts use its contents. |
| **Installed programs** | A searchable list of installed programs. Pick one: the app shows you the exact command, asks you first, runs the program's own uninstaller, then looks for leftovers. |
| **Windows apps** | Lists Microsoft Store apps for your account and removes the one you pick (for your account only). |
| **Windows tools** | One-click shortcuts to built-in Windows tools such as Task Scheduler, Services and System Restore. Nothing is changed by this app. |
| **Browsers cleaner** | Finds browser cache (Chrome, Edge, Brave, Opera, Firefox). Browsing history is offered separately and never ticked by default. Cookies, passwords and bookmarks are never offered. |
| **Startup programs** | Lists the programs that start with Windows (view only). |
| **Settings** | Restore point switch, a simpler confirm screen instead of the 3D key, and a list of folders the app must never touch. |
| **Credits and licenses** | Every library and source this app is built with, and its license. |

## Download

**One download is all you need.** Everything is built in: you do **not** need Node.js, npm, Electron, a runtime, or any other download or internet connection to use the program.

On the **Releases** page of this repository you can download either of these single files, or the zip that holds both plus the documents:

* `Install-Nuke-Uninstaller.exe` (about 97 MB): the setup wizard, a single file.
* `Nuke-Uninstaller-Portable.exe` (about 97 MB): the no-install program, a single file.
* `Nuke-Uninstaller-<version>-windows-x64.zip`: both of the above plus the license, notices and a short read-me.

If you took the zip, unzip it and then either:

* **Install:** double-click **`Install-Nuke-Uninstaller.exe`** (or `Install.bat`). A setup wizard opens: read and accept the terms, choose the install folder (the default is `C:\Program Files\Nuke-Uninstaller`), click Install. It adds desktop and Start-menu shortcuts and offers to start the program. Windows asks for permission once. To remove it later use Windows Settings > Apps > Installed apps. The setup wizard lets you choose the install folder. The optional administrator mode is only offered when it is installed under `C:\Program Files`.
* **No install:** double-click **`Nuke-Uninstaller-Portable.exe`**. It is completely standalone: it needs no installer, no other file and no install step, and runs from anywhere, including a USB drive. Administrator mode is not available from this version.

Requirements: Windows 10 or 11, 64-bit. It was developed and tested on Windows 11.

### "Windows protected your PC" (SmartScreen)

The programs are **not code-signed** (a signing certificate costs money), so Windows may warn you the first time. If you downloaded them from this repository's Releases page and trust them, click **More info** then **Run anyway**. You can also read the source code and build the programs yourself (see [Build from source](#build-from-source)).

## How to use it (quick start)

1. Start the program. Click **Scan** (or one of the other buttons).
2. Look at what it found. Items the app is very sure about are ticked; items it is less sure about are not. Untick anything you want to keep.
3. Click **Delete them!**. Read the warning. Click **Yes, go ahead**.
4. If the restore-point switch in Settings is on (it is by default) Windows asks for administrator approval and makes a **system restore point**. Note: a restore point protects Windows settings and installed programs, **not your personal files**.
5. A confirmation screen opens. Click **Begin**, drag the key into the lock, drag it to the right to turn it, lift the glass cover, press the red button. If you prefer, turn on the simple confirm screen in Settings.
6. You have 60 seconds on that screen; after that the app closes it by itself and nothing is deleted.

## How it keeps you safe

* **Nothing is deleted until the last button.** Scans only read.
* **Fixed places only.** Smart Scan looks in a short fixed list of junk locations. Windows itself (`C:\Windows`, `Program Files`, `ProgramData\Microsoft`), other accounts, and account secrets (saved-password and key folders, `.ssh`, `.gnupg`, `NTUSER.DAT`) are on a built-in never-touch list and are refused even if something offers them. You can add your own never-touch folders in Settings.
* **Your own files are protected.** Desktop, Documents, Pictures, Music, Videos, Downloads and OneDrive are never offered.
* **One narrow delete path.** The delete step re-checks every item again, refuses anything that changed since the scan, and writes an audit line to `%LOCALAPPDATA%\Nuke-Uninstaller` before and after.
* **The registry is not changed by this version.** Registry entries are listed for information only.
* **No network.** The program makes no internet connections; the confirmation page is served only to this app on your own computer, once, with a random token.
* **Normal user rights.** Administrator mode is optional and limited to a few Windows junk folders (temporary files, error reports, Windows Update downloads). It is only offered from the installed copy under `C:\Program Files`.

More detail for technical readers: [docs/TECHNICAL.md](docs/TECHNICAL.md) and [docs/never-touch-list.md](docs/never-touch-list.md).

## Known limits

* Windows only. Developed and tested on Windows 11 x64.
* Leftovers outside your own user folder (for example under `C:\Program Files`) are **shown but not deleted** in standard mode.
* Not yet exercised by the author: the administrator-mode relaunch from the installed copy, a real restore point created by the app, and most of the Windows tools shortcuts (only one was opened during testing). The automated test suite covers the logic with simulated Windows calls.
* The programs are unsigned (see above).

## Disclaimer

**Please read this before you delete anything.**

* Nuke-Uninstaller is provided "as is", without any warranty. It is a free hobby project and you use it at your own risk.
* It deletes files permanently. Deleted items do not go to the Recycle Bin. A Windows restore point can bring back Windows settings and installed programs, but it cannot bring back your personal files. Back up anything important before you use this program.
* Uninstalling a program or removing a Windows app can stop other software that depends on it from working. Read each confirmation before you continue.
* I AM NOT LIABLE. To the fullest extent the law allows, the author is not liable for any loss or damage of any kind that results from using, or from not being able to use, this program. That includes lost or deleted files, lost data, damaged or unbootable systems, lost settings, lost programs, and lost time or money. It makes no difference whether the damage is direct or indirect, whether it comes from a mistake in the program, or whether the author was told it might happen. By using the program you accept this and agree not to hold the author responsible.
* This project is independent. It is not made, endorsed or sponsored by Microsoft or any other company. Names such as Windows, Edge, Chrome and Firefox belong to their owners and are used only to say what the program works with.
* Nothing here is legal, financial or professional advice.

If you do not agree with this, please do not use the program.

## License

Nuke-Uninstaller is free to use, copy and share for **noncommercial** purposes under the **PolyForm Noncommercial License 1.0.0** ([LICENSE](LICENSE), also at <https://polyformproject.org/licenses/noncommercial/1.0.0>). In plain words:

* You may use it for yourself, at home, for hobby, study or research, and for charities, schools and similar organizations.
* You may share it and change it, as long as you keep the license (and its "Required Notice" line) with it.
* You may **not** sell it, charge for it or for access to it, or use it as part of a business. Nobody may charge money for this program.
* No warranty (see the disclaimer above).

This is a "source-available" license, not an OSI-approved open-source license, because it limits commercial use. The author keeps the rights not granted here. (Copyright exists automatically for anything a person writes; this license is how that right is shared for free, with the no-selling condition.) Only the license text itself is binding; this summary is not legal advice. (The license text contains a made-up example notice naming "Yoyodyne, Inc." and example.com. That is part of the standard PolyForm text and only shows what a notice looks like; it is not ours.)

It includes or builds with third-party software that keeps **its own** license (those licenses do not change, and they are not restricted by the noncommercial rule above): Electron, Chromium and Node.js, three.js, and sound effects from Freesound.org released under CC0, among others. The full list with copyright lines and license texts is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and on the **Credits and licenses** screen inside the app. The installed program also includes `LICENSE.electron.txt` and `LICENSES.chromium.html`.

## Build from source

**You do not need this to use the program** (see Download above). This is only for people who want to read, change or rebuild the code. It needs Windows, Node.js 22 or newer and git, and it downloads the build tools and Electron from the internet.

```powershell
git clone https://github.com/Stevo9999/Nuke-Uninstaller.git
cd Nuke-Uninstaller
npm ci                    # installs the build tools
node node_modules/electron/install.js   # downloads the Electron program (newer npm versions skip this step)
npm start                 # run the app from source
npm test                  # run the automated tests (about 700)
npx electron-builder --win --x64   # builds the one-click installer and the portable program into .\release
powershell -File scripts\make-release-zip.ps1   # packs them into the release zip
```

Run the tests with `node --test --test-concurrency=1` from PowerShell (Git Bash can break the folder-link tests).

## Contributing and reporting problems

Issues and pull requests are welcome. Please do **not** test against real data: the repository has a fixture builder (`fixture/make-app-fixture.mjs`) for a throwaway fake profile. For a security problem, open an issue that says "security" without exploit details and I will get in touch, or use GitHub's private vulnerability reporting if it is enabled.

See [docs/ORIGINALITY.md](docs/ORIGINALITY.md) for the project's originality and licensing rules, and [docs/ROADMAP.md](docs/ROADMAP.md) for what may come next.
