// Tests for lib/restore.mjs. Every test uses a fake spawnFn and (where time matters) mocked timers.
// No test starts a real process, creates a real restore point, or shows a real UAC prompt.
// The outcome comes back ONLY as the exit code of the process we started (no result file, nothing user-writable is read).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import {
  encodeCommand, restoreScripts, classifyRestore, RESTORE_MESSAGES, TIMEOUT_MESSAGE, RESTORE_EXIT, createRestorePoint,
} from "../lib/restore.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(HERE + path.sep + ".." + path.sep + "lib" + path.sep + "restore.mjs", "utf8");
const RUN_ID = "0123456789abcdef";
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const decode = b64 => Buffer.from(b64, "base64").toString("utf16le");

// Fake spawn: records calls; `behave(child, call)` decides what the fake "process" does.
function fakeSpawn(behave) {
  const calls = [];
  const fn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit("kill-called"); return true; };
    const call = { exe, args, opts, child };
    calls.push(call);
    if (behave) setImmediate(() => behave(child, call));
    return child;
  };
  fn.calls = calls;
  return fn;
}
const exitWith = code => child => child.emit("exit", code, null);
const base = (spawnFn, o = {}) => ({ runId: RUN_ID, elevated: false, spawnFn, systemRoot: "C:\\Windows", ...o });

test("encodeCommand is base64 of UTF-16LE", () => {
  assert.equal(encodeCommand("Get-Date"), Buffer.from("Get-Date", "utf16le").toString("base64"));
  assert.equal(decode(encodeCommand("x 'é' 1440")), "x 'é' 1440");
});

test("spawns powershell.exe by full System32 path, args array, -EncodedCommand, shell:false, stdio ignored", async () => {
  const spawnFn = fakeSpawn(exitWith(RESTORE_EXIT.made));
  const r = await createRestorePoint(base(spawnFn, { elevated: true }));
  assert.equal(spawnFn.calls.length, 1);
  const { exe, args, opts } = spawnFn.calls[0];
  assert.equal(exe, PS);
  assert.ok(Array.isArray(args));
  assert.equal(args.length, 4);
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.match(args[3], /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(opts.shell, false);
  assert.equal(opts.stdio, "ignore");
  assert.deepEqual(r, { outcome: "made", message: RESTORE_MESSAGES.made, sequence: null, detail: "made" });
});

test("not elevated -> outer script with Start-Process -Verb RunAs; elevated -> inner script directly", async () => {
  const spawnFn = fakeSpawn(exitWith(RESTORE_EXIT.made));
  await createRestorePoint(base(spawnFn, { elevated: false }));
  await createRestorePoint(base(spawnFn, { elevated: true }));
  const outer = decode(spawnFn.calls[0].args[3]);
  const direct = decode(spawnFn.calls[1].args[3]);
  assert.match(outer, /Start-Process -FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','[A-Za-z0-9+/=]+' -Verb RunAs -Wait -PassThru -WindowStyle Hidden/);
  assert.match(outer, /exit \[int\]\$p\.ExitCode/, "the outer process exits with the elevated process's code");
  assert.match(outer, /1223/);
  assert.doesNotMatch(outer, /Checkpoint-Computer/); // only inside the nested encoded inner script
  const nested = decode(outer.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1]);
  assert.equal(nested, direct);
  assert.match(direct, /Checkpoint-Computer -Description 'Nuke-Uninstaller 0123456789abcdef' -RestorePointType MODIFY_SETTINGS -WarningVariable w -ErrorAction Stop/);
  assert.match(direct, /Get-ComputerRestorePoint/);
  assert.doesNotMatch(direct, /Start-Process/);
});

test("scripts write no file and read no file: the outcome travels only as an exit code", () => {
  const { inner, outer } = restoreScripts({ runId: RUN_ID, psExe: PS });
  for (const s of [inner, outer]) {
    assert.doesNotMatch(s, /WriteAllText|Out-File|Set-Content|Add-Content|ConvertTo-Json|\.json|\[System\.IO|Get-Content|>\s*\$|New-Item/i);
  }
  assert.match(inner, /exit \$code/);
  // the exit codes are distinct
  const codes = Object.values(RESTORE_EXIT);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(!codes.some(c => c === 0 || c === 1 || c === 1223), "none collides with success, a generic failure or UAC-cancelled");
  for (const c of [RESTORE_EXIT.made, RESTORE_EXIT.skipped24h, RESTORE_EXIT.disabled, RESTORE_EXIT.failed, RESTORE_EXIT.notAdmin])
    assert.ok(inner.includes(String(c)), "inner script uses exit code " + c);
});

test("script text: description carries the hex runId; psExe with a quote is doubled; numeric tokens only inside the encoded script", () => {
  const psExe = "C:\\Users\\O'Brien\u2019x\\powershell.exe";
  const { inner, outer } = restoreScripts({ runId: RUN_ID, psExe });
  assert.ok(inner.includes("'Nuke-Uninstaller 0123456789abcdef'"));
  assert.ok(outer.includes("'C:\\Users\\O''Brien\u2019\u2019x\\powershell.exe'"));
  assert.ok(!outer.includes("O'Brien"));
  assert.equal((inner.match(/['\u2018\u2019\u201A\u201B]/g) || []).length % 2, 0);
  assert.ok(!outer.includes("Checkpoint-Computer"));
  assert.ok(outer.includes(encodeCommand(inner)));
  assert.ok(encodeCommand(outer).length < 30000, "outer encoded length " + encodeCommand(outer).length);
});

test("restoreScripts rejects bad runId and psExe", () => {
  const good = { runId: RUN_ID, psExe: PS };
  for (const runId of ["", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "0123456789abcdeg", "0123456789abcdef\n", "' ; calc ; '", 123, null])
    assert.throws(() => restoreScripts({ ...good, runId }), /runId/);
  for (const psExe of ["powershell.exe", "C:\\p\ns.exe", "\\\\srv\\ps.exe", null])
    assert.throws(() => restoreScripts({ ...good, psExe }), /psExe/);
});

test("exit code -> outcome table; only the exact made code is made; 0, 1 and unknown codes are failures", async (t) => {
  const table = [
    [RESTORE_EXIT.made, "made", "made"],
    [RESTORE_EXIT.skipped24h, "skipped-24h", "skipped-24h"],
    [RESTORE_EXIT.disabled, "disabled", "disabled"],
    [RESTORE_EXIT.notAdmin, "needs-admin", "not-admin"],
    [1223, "needs-admin", "uac-cancelled"],
    [RESTORE_EXIT.failed, "failed", "error"],
    [0, "failed", "error"],            // a process that merely exited cleanly proves nothing
    [1, "failed", "error"],
    [-1, "failed", "error"],
    [3010, "failed", "error"],
    [2147483647, "failed", "error"],
    [RESTORE_EXIT.timeout, "failed", "error"], // 25 is host-side only: a script exit of 25 is just an unknown code
    [null, "failed", "no-result"],     // killed by a signal
  ];
  for (const [code, outcome, detail] of table) {
    assert.equal(classifyRestore(code), outcome, String(code));
    const r = await createRestorePoint(base(fakeSpawn(exitWith(code))));
    assert.deepEqual(r, { outcome, message: detail === "timeout" ? TIMEOUT_MESSAGE : RESTORE_MESSAGES[outcome], sequence: null, detail }, String(code));
  }
  assert.equal(classifyRestore("20"), "failed");
  assert.equal(classifyRestore(undefined), "failed");

  assert.deepEqual(RESTORE_MESSAGES, {
    made: "A system restore point was created and verified.",
    "skipped-24h": "Windows did not create a new restore point because one was already created in the last 24 hours.",
    "needs-admin": "No restore point: administrator approval was not given.",
    disabled: "No restore point: System Restore is turned off on this PC.",
    failed: "No restore point: Windows reported an error.",
  });
  assert.ok(Object.isFrozen(RESTORE_MESSAGES));

  // a leftover file in a user-writable folder named like the old result file changes nothing
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuke-restore-"));
  try {
    fs.writeFileSync(path.join(dir, `restore-${RUN_ID}.json`), JSON.stringify({ made: true, sequence: 99, warning: null, error: null }));
    const r = await createRestorePoint(base(fakeSpawn(exitWith(0)), { resultDir: dir }));
    assert.equal(r.outcome, "failed");
    assert.equal(r.sequence, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // spawn error event (e.g. exe missing) -> failed
  {
    const r = await createRestorePoint(base(fakeSpawn(child => child.emit("error", new Error("ENOENT"))), { elevated: true }));
    assert.deepEqual(r, { outcome: "failed", message: RESTORE_MESSAGES.failed, sequence: null, detail: "spawn-error" });
  }
  // spawnFn throwing synchronously -> failed
  {
    const r = await createRestorePoint(base(() => { throw new Error("EACCES"); }, { elevated: true }));
    assert.equal(r.outcome, "failed"); assert.equal(r.detail, "spawn-error");
  }

  // timeout: the clock is mocked; the fake never exits; the child is killed; a late made code is ignored
  {
    try {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const spawnFn = fakeSpawn(null);
      const p = createRestorePoint(base(spawnFn, { timeoutMs: 5000 }));
      assert.equal(spawnFn.calls.length, 1);
      t.mock.timers.tick(4999);
      assert.equal(spawnFn.calls[0].child.killed, false);
      t.mock.timers.tick(1);
      assert.equal(spawnFn.calls[0].child.killed, true);
      spawnFn.calls[0].child.emit("exit", RESTORE_EXIT.made, null); // too late to count
      const r = await p;
      assert.deepEqual(r, { outcome: "failed", message: TIMEOUT_MESSAGE, sequence: null, detail: "timeout" });
      assert.match(r.message, /timed out/);
    } finally { t.mock.timers.reset(); }
  }
  // default timeout is 180000 ms (3 minutes)
  {
    try {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const spawnFn = fakeSpawn(null);
      const p = createRestorePoint(base(spawnFn, { elevated: true }));
      t.mock.timers.tick(179999);
      assert.equal(spawnFn.calls[0].child.killed, false);
      t.mock.timers.tick(1);
      assert.equal(spawnFn.calls[0].child.killed, true);
      assert.equal((await p).detail, "timeout");
    } finally { t.mock.timers.reset(); }
  }
});

test("never edits the restore frequency or System Restore settings", () => {
  assert.doesNotMatch(SRC, /SystemRestorePointCreationFrequency|Enable-ComputerRestore|Disable-ComputerRestore|Set-ItemProperty|reg(\.exe)?\s+add/i);
  assert.doesNotMatch(SRC, /\bfrom "node:fs"|readFileSync|lstatSync|existsSync|writeFile/, "no file access at all");
  const { inner, outer } = restoreScripts({ runId: RUN_ID, psExe: PS });
  for (const s of [inner, outer]) {
    assert.doesNotMatch(s, /SystemRestorePointCreationFrequency|ComputerRestore\b|ItemProperty|New-Item|Remove-Item|HKLM|HKEY_|Registry::|reg(\.exe)?\s|Invoke-Expression|iex\b|Set-ExecutionPolicy|vssadmin|wmic/i);
  }
  assert.equal((SRC.match(/spawnFn\(/g) || []).length, 1);
  assert.doesNotMatch(SRC, /exec(Sync|File)?\(|spawnSync|shell:\s*true|child_process"\)\.exec/);
});

test("runId, systemRoot, elevated, timeoutMs are validated before any spawn", async () => {
  const spawnFn = fakeSpawn(() => assert.fail("must not spawn"));
  const bad = [
    { runId: "ABCDEF0123456789" }, { runId: "x" }, { runId: "0123456789abcdef\r" }, { runId: undefined },
    { systemRoot: "C:\\Windows\\..\\Evil" }, { systemRoot: "D:\\Evil Root\\x" }, { systemRoot: "Windows" }, { systemRoot: "\\\\srv\\Windows" },
    { elevated: "yes" },
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: Infinity }, { timeoutMs: "5" },
  ];
  for (const b of bad) await assert.rejects(createRestorePoint({ ...base(spawnFn), ...b }), TypeError, JSON.stringify(b));
  assert.equal(spawnFn.calls.length, 0);
});
