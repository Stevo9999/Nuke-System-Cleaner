// lib/lock.mjs: out/nuke.lock keeps two cleanup servers from running at once.
// The lock holds {pid, port, startedAt}. A lock is stale when its pid is dead or nothing answers on its port.
// This is the only code (besides lib/delete*.mjs) that removes a file, and it only ever removes the lock itself.
import fs from "node:fs";
import net from "node:net";

const STARTING_GRACE_MS = 30000;

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === "EPERM"; }
}

function portAnswers(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = v => { clearTimeout(timer); s.destroy(); resolve(v); };
    const timer = setTimeout(() => done(false), 700);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// True only for a lock that is demonstrably live: owner process alive AND (its port answers, or it is still starting).
export async function lockHeld(lockFile, isAlive = pidAlive) {
  let j;
  try { j = JSON.parse(fs.readFileSync(lockFile, "utf8")); } catch { return false; }
  if (!j || typeof j !== "object" || !Number.isSafeInteger(j.pid) || j.pid <= 0 || !Number.isSafeInteger(j.port) || j.port < 0) return false;
  let alive = false; try { alive = isAlive(j.pid) === true; } catch { alive = false; }
  if (!alive) return false;
  if (j.port === 0) return typeof j.startedAt === "number" && Date.now() - j.startedAt < STARTING_GRACE_MS;
  return portAnswers(j.port);
}

// Creates the lock exclusively. Throws {code:"LOCKED"} when a live server holds it; replaces a stale one.
export async function acquireLock(lockFile, isAlive = pidAlive) {
  const body = () => JSON.stringify({ pid: process.pid, port: 0, startedAt: Date.now() });
  try { fs.writeFileSync(lockFile, body(), { flag: "wx" }); return; } catch (e) { if (!e || e.code !== "EEXIST") throw e; }
  if (await lockHeld(lockFile, isAlive)) throw Object.assign(new Error("another cleanup server is already running (out/nuke.lock); finish or wait for it"), { code: "LOCKED" });
  fs.rmSync(lockFile, { force: true });
  fs.writeFileSync(lockFile, body(), { flag: "wx" });
}

export function setLockPort(lockFile, port) {
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }));
}

// Removes the lock only if this process owns it.
export function releaseLock(lockFile) {
  try {
    const j = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (j && j.pid === process.pid) fs.rmSync(lockFile, { force: true });
  } catch { /* nothing to release */ }
}
