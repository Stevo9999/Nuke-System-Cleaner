// Part of the spawn inventory: the exact PowerShell script texts that travel inside -EncodedCommand are pinned, so a change that
// makes them start another program (or anything new) fails here and has to be reviewed.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restoreScripts } from "../lib/restore.mjs";
import { relaunchScript } from "../app/main/elevation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/\s.*$/gm, "");
const code = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const decodeEncoded = (b64) => Buffer.from(b64, "base64").toString("utf16le");
const FORBIDDEN_PS = /Invoke-Expression|\biex\b|Invoke-Command|\bicm\b|Start-Job|Add-Type|DownloadString|WebClient|Invoke-WebRequest|\biwr\b|New-Object\s+-ComObject|WScript|\bcmd(\.exe)?\b|\bsc\.exe\b|Remove-Item|Set-ItemProperty|New-ItemProperty|\bStop-Service\b|\bStart-Service\b|\bSet-Service\b|Set-ExecutionPolicy|\[Reflection|-Command\b/i;

// Update these only after reviewing the script change.
const PINNED = {
  restoreInner: "79a7863d049adb9f0911af1c5680389c6009d611d658297f44919e2636975a51",
  restoreOuter: "95ea77d1bc982eb16d4e1cc02fdf78217c0363342bdae94a29de691e66186204",
  relaunch: "2c9af1f474d2377920bbef62415ff60ebf9ca8666c104b4029e9b44dcf5de278",
};

test("each spawn call is a literal options object (no spread) with shell: false", () => {
  for (const f of ["run.mjs", "lib/sysread.mjs", "lib/restore.mjs", "app/main/elevation.mjs"]) {
    const calls = code(f).split("\n").filter((l) => l.includes("spawnFn(") && l.includes("shell: false"));
    assert.equal(calls.length, 1, f);
    assert.ok(!/\.\.\./.test(calls[0].replace("...k.args", "")), f + ": no spread in the spawn call");
    assert.ok(/\{ shell: false, /.test(calls[0]), f);
  }
});

test("restore scripts start exactly one program (the elevated powershell.exe -EncodedCommand); the inner script starts none", () => {
  const { inner, outer } = restoreScripts({ runId: "0123456789abcdef", psExe: PS });
  assert.equal((outer.match(/Start-Process/g) || []).length, 1);
  assert.equal((inner.match(/Start-Process/g) || []).length, 0);
  assert.ok(outer.includes("Start-Process -FilePath '" + PS + "' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',"));
  assert.ok(outer.includes("-Verb RunAs -Wait -PassThru -WindowStyle Hidden"));
  const payload = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)[1];
  assert.equal(decodeEncoded(payload), inner, "the second powershell.exe runs exactly the inner script");
  for (const s of [inner, outer.replace(payload, "")]) assert.ok(!FORBIDDEN_PS.test(s), "forbidden token: " + FORBIDDEN_PS.exec(s));
  assert.ok(inner.includes("Checkpoint-Computer") && inner.includes("Get-ComputerRestorePoint"));
  // the outcome leaves the elevated process only as an exit code: the scripts write and read no file
  assert.ok(outer.includes("exit [int]$p.ExitCode") && inner.includes("exit $code"));
  assert.ok(!/WriteAllText|Out-File|Set-Content|ConvertTo-Json|\.json|Get-Content/i.test(inner + outer.replace(payload, "")));
  assert.equal(sha(inner), PINNED.restoreInner);
  assert.equal(sha(outer), PINNED.restoreOuter);
});

test("the relaunch script starts exactly one program, the app itself, with -Verb RunAs", () => {
  const s = relaunchScript({ execPath: "C:\\App\\Nuke System Cleaner.exe", args: ["C:\\App\\a b"] });
  assert.equal((s.match(/Start-Process/g) || []).length, 1);
  assert.ok(s.includes("Start-Process -FilePath 'C:\\App\\Nuke System Cleaner.exe' -ArgumentList '\"C:\\App\\a b\"' -Verb RunAs"));
  assert.ok(!FORBIDDEN_PS.test(s));
  assert.equal(sha(s), PINNED.relaunch);
});
