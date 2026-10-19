// The "Credits and licenses" page content: plain data, no behaviour. Every third-party thing this project ships or builds with,
// who made it, its license and where to read the full terms. Keep this in step with package.json, vendor/ and sounds/
// (test/app/credits.test.mjs checks that).
// Not listed on purpose: anything that is neither included nor used. Nothing here is a claim of endorsement.

export const LICENSE_TEXTS = Object.freeze({
  MIT: [
    "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:",
    "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
  ],
  "BSD-2-Clause": [
    "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:",
    "1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.",
    "2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.",
    "THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.",
  ],
  "BSD-3-Clause": [
    "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:",
    "1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.",
    "2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.",
    "3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.",
    "THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.",
  ],
});

// Licenses whose full text is long or lives with the original: named here with the official place to read it.
export const LICENSE_LINKS = Object.freeze({
  "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/legalcode",
  "Zlib-libpng": "https://nsis.sourceforge.io/License",
});

// kind: "included" (inside the app or its installer), "build" (used to build it, not inside the app), "sound", "reference"
export const CREDITS = Object.freeze([
  { kind: "included", name: "Electron 44", what: "The app window and its Windows integration.", by: "Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.", license: "MIT", url: "https://www.electronjs.org/" },
  { kind: "included", name: "Chromium (inside Electron)", what: "The web engine that draws every screen.", by: "Copyright (c) The Chromium Authors and many other contributors", license: "BSD-3-Clause and other open licenses (full list: LICENSES.chromium.html, installed next to the app)", url: "https://www.chromium.org/" },
  { kind: "included", name: "Node.js (inside Electron)", what: "The runtime that runs the app's logic.", by: "Copyright Node.js contributors and OpenJS Foundation", license: "MIT", url: "https://nodejs.org/" },
  { kind: "included", name: "three.js r160 (and its example modules)", what: "The 3D room, the key and the red button.", by: "Copyright 2010-2023 Three.js Authors", license: "MIT", url: "https://threejs.org/" },
  { kind: "included", name: "RoomEnvironment (three.js example, adapted from Google's model-viewer environment scene)", what: "Soft room lighting for the 3D scene.", by: "three.js Authors; based on work by Google LLC", license: "MIT (three.js) / Apache-2.0 (original model-viewer scene)", url: "https://github.com/google/model-viewer" },
  { kind: "sound", name: "Sound effects (glass, press, spring, siren, blast, flyover, whistle)", what: "The sounds in the final confirmation.", by: "Various Freesound.org contributors (individual uploader names were not recorded)", license: "CC0-1.0 (public-domain dedication, no attribution required)", url: "https://freesound.org/" },
  { kind: "build", name: "electron-builder", what: "Builds the installer and the portable program.", by: "Copyright (c) 2015 Loopline Systems", license: "MIT", url: "https://www.electron.build/" },
  { kind: "build", name: "NSIS (installer engine used by electron-builder)", what: "The setup wizard code inside the installer.", by: "Nullsoft Scriptable Install System contributors", license: "Zlib-libpng", url: "https://nsis.sourceforge.io/" },
  { kind: "build", name: "@electron/packager", what: "Optional folder packaging used by the 'npm run package' script.", by: "Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.", license: "BSD-2-Clause", url: "https://github.com/electron/packager" },
  { kind: "reference", name: "Windows Resource Protection documentation (Microsoft Learn)", what: "Read to learn that Windows protects essential system files, folders and registry keys. Facts only; no text or code copied.", by: "Microsoft Corporation", license: "Documentation, read for reference", url: "https://learn.microsoft.com/en-us/windows/win32/wfp/about-windows-file-protection" },
  { kind: "reference", name: "Windows-Registry-Cleaner by RaneKun", what: "Read for the idea of cleaning only provably broken entries and refusing system areas. No code or lists from it are included here; its terms (free for personal use, no selling, keep it credited) are not an open-source license, so nothing was copied.", by: "RaneKun", license: "Author's own terms; credit given", url: "https://github.com/RaneKun/Windows-Registry-Cleaner" },
]);

export const TRADEMARKS = "Windows, Microsoft Store, Microsoft Edge, Chrome, Firefox, Brave, Opera and other product names are trademarks of their owners. They are used only to say what this app works with. This app is independent and is not affiliated with or endorsed by any of them.";
export const GENERAL_NOTE = "Nuke-Uninstaller itself is free for noncommercial use under the PolyForm Noncommercial License 1.0.0 (see the LICENSE file); it may not be sold. The programs and sounds listed here keep their own licenses and copyrights. Each license text below (or the link beside it) belongs to its author.";
