// scripts/sync-disclaimer.mjs: docs/disclaimer.txt is the ONE source of the disclaimer wording. This script writes it into
//   README.md                                  (between the disclaimer:start / disclaimer:end markers)
//   scripts/release-extras/READ-ME-FIRST.txt   (between the same markers)
//   build/license.txt                          (the whole installer terms page, generated)
// Run `node scripts/sync-disclaimer.mjs` after editing docs/disclaimer.txt; test/release-config.test.mjs fails if they drift.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const START = "disclaimer:start", END = "disclaimer:end";

export function disclaimerLines() {
  return read("docs/disclaimer.txt").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function between(text, open, close, body) {
  const a = text.indexOf(open), b = text.indexOf(close);
  if (a < 0 || b < a) throw new Error("markers missing");
  return text.slice(0, a + open.length) + body + text.slice(b);
}

// The expected content of every generated file, as { relativePath: text }. Pure: used by the writer and by the drift test.
export function expectedFiles() {
  const lines = disclaimerLines();
  const readme = between(read("README.md"), "<!-- " + START + " -->", "<!-- " + END + " -->", "\n" + lines.map(l => "* " + l).join("\n") + "\n");
  const first = between(read("scripts/release-extras/READ-ME-FIRST.txt").replace(/\r\n/g, "\n"), "[" + START + "]", "[" + END + "]", "\n" + lines.map(l => "- " + l).join("\n") + "\n");
  const license = [
    "NUKE - SYSTEM CLEANER - PLEASE READ BEFORE INSTALLING", "",
    "1. LICENSE (what you may do)",
    "Nuke - System Cleaner is free for noncommercial use. You may use it, copy it and share it, and change it, as long as you keep its license with it. You may not sell it, charge for it, or use it as part of a business.",
    "The full legal text is the PolyForm Noncommercial License 1.0.0. It is installed with the program (the file LICENSE inside the program's resources\\app folder) and is also at https://polyformproject.org/licenses/noncommercial/1.0.0", "",
    "2. DISCLAIMER", ...lines.map((l, i) => (i + 1) + ") " + l), "If you do not agree with this, click Cancel.", "",
    "3. THIRD-PARTY SOFTWARE",
    "Nuke - System Cleaner includes open-source software (Electron, Chromium, Node.js, three.js and others) and sound effects released into the public domain. Each keeps its own license. The list, with copyright lines and license texts, is in the file THIRD_PARTY_NOTICES.md and on the \"Credits and licenses\" screen inside the program.", "",
    "Click \"I Agree\" to continue.", "",
  ].join("\r\n");
  return { "README.md": readme, "scripts/release-extras/READ-ME-FIRST.txt": first.replace(/\n/g, "\r\n"), "build/license.txt": license };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [f, text] of Object.entries(expectedFiles())) fs.writeFileSync(path.join(ROOT, f), text);
  console.log("disclaimer synced");
}
