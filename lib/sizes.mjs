import fs from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
const nk = p => { const s = path.resolve(p); return WIN ? s.toLowerCase() : s; };

// Total bytes under p. Never follows links and never crosses onto another volume: a directory
// whose dev differs from the top's, or whose realpath differs from its path (reparse points that
// lstat reports as plain directories), counts as 0 and is not read.
export function dirSize(p) { return size(p, undefined); }

function size(p, rootDev) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  if (rootDev === undefined) rootDev = st.dev;
  if (st.dev !== rootDev) return 0;
  let names = [];
  try {
    if (nk(fs.realpathSync.native(p)) !== nk(p)) return 0;
    names = fs.readdirSync(p);
  } catch { return 0; }
  let total = 0;
  for (const n of names) total += size(path.join(p, n), rootDev);
  return total;
}
