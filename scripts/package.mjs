// scripts/package.mjs: build a portable (non-asar) Windows x64 copy of the app and put it in
//   <LOCALAPPDATA>\Programs\Nuke-Uninstaller\<version>
// Run it with `npm run package` AFTER `@electron/packager` has been installed (it is not installed by default; see README).
//
// What it does: calls @electron/packager through its JavaScript API (asar:false, win32, x64) into ./dist, then copies the
// produced folder to the target with fs.cpSync. It REFUSES if the target already exists: it never deletes and never
// overwrites. It starts no process of its own and makes no network request itself (installing the packager and the
// Electron binary is a separate, explicit npm step).
//
// @electron/packager is imported lazily inside run(), so the pure functions below can be imported and tested without it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_NAME = "Nuke-Uninstaller";
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** <LOCALAPPDATA>\Programs\Nuke-Uninstaller\<version>. Throws for a bad version or a LOCALAPPDATA that is not an absolute drive path. */
export function packageTarget(env, version) {
  if (typeof version !== "string" || !VERSION_RE.test(version)) throw new TypeError("version must look like 1.2.3");
  const local = env && typeof env === "object" ? env.LOCALAPPDATA : undefined;
  if (typeof local !== "string" || !/^[A-Za-z]:\\/.test(local) || /[\u0000-\u001f"<>|?*]/.test(local) || !path.win32.isAbsolute(local)
    || local.split(/[\\/]/).includes(".."))
    throw new TypeError("LOCALAPPDATA must be an absolute Windows path without '..' segments");
  return path.win32.join(local, "Programs", APP_NAME, version);
}

// Matched by @electron/packager against paths like "/test/x.mjs" (relative to the app folder, forward slashes).
const top = (n) => new RegExp("^/" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(/|$)");
export const PACKAGER_IGNORE = Object.freeze([
  top("test"), top("fixture"), top("docs"), top("out"), top("dist"), top(".git"), top(".superpowers"), top(".claude"), top("scripts"),
  /^\/index-v1-css\.html$/,
  // not needed at run time
  /^\/\.gitignore$/, /^\/demo-server\.cjs$/, /^\/PARKED\.md$/, /^\/task-\d+-report\.md$/, /^\/package-lock\.json$/,
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

export const PACKAGER_HINT = "@electron/packager is not installed. Install it first (this downloads from npm): npm install --save-dev --save-exact @electron/packager@<version>";

/**
 * Package and copy. All inputs are injectable for tests: `loadPackager` (default: lazy import), `root`, `env`.
 * Returns { target, exe }. Throws (never deletes anything) if the target exists.
 */
export async function run({ root = ROOT, env = process.env, loadPackager = async () => { const m = await import("@electron/packager"); return m.packager ?? m.default; }, log = console.log } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const target = packageTarget(env, pkg.version);
  if (fs.existsSync(target)) throw new Error("target already exists, refusing to overwrite or delete: " + target);
  let packager;
  try { packager = await loadPackager(); } catch { throw new Error(PACKAGER_HINT); }
  if (typeof packager !== "function") throw new Error(PACKAGER_HINT);
  // The packager would stop with an obscure error (or, with other options, overwrite). Say it clearly and delete nothing.
  const staleBuild = path.join(root, "dist", APP_NAME + "-win32-x64");
  if (fs.existsSync(staleBuild)) throw new Error("the build folder already exists: " + staleBuild + ". Move or delete it yourself, then run again (this script never deletes).");
  const built = await packager({
    dir: root, out: path.join(root, "dist"), name: APP_NAME, platform: "win32", arch: "x64", asar: false,
    ignore: [...PACKAGER_IGNORE],
  });
  if (!Array.isArray(built) || built.length !== 1 || typeof built[0] !== "string") throw new Error("packager did not return exactly one output folder");
  if (fs.existsSync(target)) throw new Error("target already exists, refusing to overwrite or delete: " + target);   // re-check after the slow step
  fs.cpSync(built[0], target, { recursive: true, force: false, errorOnExist: true });
  const exe = path.win32.join(target, APP_NAME + ".exe");
  log("Packaged to: " + target);
  log("Run: " + exe);
  return { target, exe };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => { console.error(e instanceof Error ? e.message : "packaging failed"); process.exit(1); });
}
