// fixture/fixture-root.mjs: where make-fixture.mjs may build (and recursively delete) its sandbox.
// Default: the repo's own fixture/sandbox. Override (tests only): NUKE_FIXTURE_ROOT, which is accepted only for a folder STRICTLY
// inside the system temp folder, never a drive root / the home folder / a parent of it, never a link, and, when it already exists
// and is not empty, only if it carries the marker file this script wrote itself earlier.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MARKER = ".nuke-fixture-root";
const WIN = process.platform === "win32";
const norm = p => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (child, parent) => { const r = path.relative(norm(parent), norm(child)); return r !== "" && r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r); };

// Returns a refusal reason, or null when the override is acceptable. Pure apart from reading the file system. `tmp` and `home` are injectable.
export function fixtureRootProblem(raw, { tmp = os.tmpdir(), home = os.homedir() } = {}) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return "not a path";
  if (!path.isAbsolute(raw)) return "not absolute";
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return "parent segment";
  const root = path.resolve(raw);
  if (path.parse(root).root === root) return "drive root";
  if (norm(root) === norm(home) || inside(home, root)) return "home folder or a parent of it";
  let realTmp;
  try { realTmp = fs.realpathSync.native(tmp); } catch { return "temp folder unreadable"; }
  if (!inside(root, tmp) && !inside(root, realTmp)) return "not inside the temp folder";
  // the nearest existing ancestor must really be inside the temp folder (no junction out of it)
  let cur = root;
  for (;;) {
    try { const real = fs.realpathSync.native(cur); if (!inside(real, realTmp) && norm(real) !== norm(realTmp)) return "resolves outside the temp folder"; break; }
    catch (e) { const up = path.dirname(cur); if (up === cur || !e || e.code !== "ENOENT") return "cannot resolve"; cur = up; }
  }
  let st = null;
  try { st = fs.lstatSync(root); } catch { st = null; }
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) return "not a plain folder";
    let names = [];
    try { names = fs.readdirSync(root); } catch { return "cannot read"; }
    if (names.length > 0 && !names.includes(MARKER)) return "non-empty folder without the fixture marker";
    if (names.includes(MARKER)) { try { if (!fs.lstatSync(path.join(root, MARKER)).isFile()) return "bad marker"; } catch { return "bad marker"; } }
  }
  return null;
}

// Resolves the root (exits with a refusal text otherwise). `defaultRoot` is the repo's fixture/sandbox.
export function resolveFixtureRoot(defaultRoot, env = process.env, opts = {}) {
  const override = env.NUKE_FIXTURE_ROOT;
  if (override === undefined || override === "") return { root: defaultRoot, override: false };
  const why = fixtureRootProblem(override, opts);
  if (why) throw new Error("NUKE_FIXTURE_ROOT refused: " + why);
  return { root: path.resolve(override), override: true };
}

// The recursive delete happens only through here; an override root is re-validated right before.
export function clearRoot(root, isOverride, opts = {}) {
  if (isOverride) { const why = fixtureRootProblem(root, opts); if (why) throw new Error("NUKE_FIXTURE_ROOT refused: " + why); }
  fs.rmSync(root, { recursive: true, force: true });
}
export function stampRoot(root, isOverride) {
  fs.mkdirSync(root, { recursive: true });
  if (isOverride) fs.writeFileSync(path.join(root, MARKER), "written by fixture/make-fixture.mjs\n");
}
