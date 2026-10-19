// Scans the dummy session and starts the cleanup server for it. Prints NUKE_URL (sandbox only).
// Sandbox only: --claude-dir is fixture/sandbox/claude, never the real ~/.claude, and the scratch folder is
// fixture/sandbox/tmp (never the real %TEMP%\claude). Optional env:
//   NUKE_SANDBOX_OUT=<dir>              where map/selection/audit/lock go (default: this project's out/)
//   NUKE_SANDBOX_EXIT_ON_STDIN_CLOSE=1  stop the server and exit when stdin closes (used by the smoke test)
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sb = path.join(root, "fixture", "sandbox");
const run = path.join(root, "run.mjs");
execFileSync(process.execPath, [path.join(root, "fixture", "make-fixture.mjs")], { stdio: "ignore" });

// the current session is identified by a nonce found in its transcript, exactly like the real flow
const nonce = "SandboxNonce" + Date.now().toString(36);
fs.appendFileSync(path.join(sb, "claude", "projects", "SBX-project", "dummy-session-A.jsonl"),
  JSON.stringify({ type: "user", message: { role: "user", content: `node run.mjs scan --nonce ${nonce}` } }) + "\n");

const outDir = process.env.NUKE_SANDBOX_OUT ? path.resolve(process.env.NUKE_SANDBOX_OUT) : path.join(root, "out");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "sandbox-map.json");
const common = ["--claude-dir", path.join(sb, "claude"), "--tmp-dir", path.join(sb, "tmp"), "--session", "dummy-session-A", "--nonce", nonce,
  "--live", "false", "--roots", `${path.join(sb, "work")};${path.join(sb, "claude")}`, "--out", out];
const scan = execFileSync(process.execPath, [run, "scan", ...common], { encoding: "utf8" });
console.log(scan);
const metaLine = scan.split(/\r?\n/).find(l => l.startsWith("NUKE_META="));
if (!metaLine) throw new Error("scan printed no NUKE_META");
const { bind } = JSON.parse(metaLine.slice("NUKE_META=".length));
const map = JSON.parse(fs.readFileSync(out, "utf8"));
const ids = map.items.filter(i => i.group === "exclusive").map(i => i.id).join(",");
console.log("\nlaunching with all exclusive items...");
const child = spawn(process.execPath, [run, "launch", ...common, "--print-url", "true", "--bind", bind, "--ids", ids], { stdio: "inherit" });
if (process.env.NUKE_SANDBOX_EXIT_ON_STDIN_CLOSE === "1") {
  process.stdin.resume();
  process.stdin.on("close", () => { child.kill(); process.exit(0); });
  child.on("exit", () => process.exit(0));
}
