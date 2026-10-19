// Round 1 of version 2: installed programs + Windows apps. Pure parsing, a fake registry, and controller flows with fakes only
// (no process is started, nothing is uninstalled).
import test from "node:test";
import assert from "node:assert/strict";
import { listPrograms, parseUninstallCommand, leftoverTarget, programRow } from "../../lib/programs.mjs";
import { PACKAGE_FULL_NAME, removeScript, LIST_SCRIPT, listWindowsApps } from "../../lib/winapps.mjs";
import { runUninstaller } from "../../lib/uninstall-run.mjs";
import { createController } from "../../app/main/controller.mjs";
import { validateArgs, CHANNELS } from "../../app/main/ipc.mjs";

const GUID = "{AC76BA86-7AD7-1033-7B44-AC0F074E4100}";
const key = (name, values) => ({ path: "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + name,
  values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { type: "REG_SZ", data: v, lossy: false }])) });

test("parseUninstallCommand: quoted, unquoted, MsiExec rewritten to the fixed msiexec with /X only", () => {
  assert.deepEqual(parseUninstallCommand('"C:\\Program Files\\App\\unins000.exe" /SILENT'), { exe: "C:\\Program Files\\App\\unins000.exe", args: "/SILENT", verbatim: true });
  assert.deepEqual(parseUninstallCommand("C:\\Program Files\\App\\uninstall.exe"), { exe: "C:\\Program Files\\App\\uninstall.exe", args: "", verbatim: true });
  assert.deepEqual(parseUninstallCommand("MsiExec.exe /I" + GUID), { exe: "C:\\Windows\\System32\\msiexec.exe", args: "/X" + GUID, verbatim: true });
  assert.deepEqual(parseUninstallCommand("msiexec /x " + GUID), null, "msiexec without .exe is not a drive path");
  assert.equal(parseUninstallCommand("MsiExec.exe /X{not-a-guid}"), null);
  assert.equal(parseUninstallCommand("MsiExec.exe /X" + GUID + " /qn REBOOT=ReallySuppress"), null, "extra msiexec arguments are not passed on");
});

test("parseUninstallCommand fails closed", () => {
  for (const bad of [null, undefined, 5, "", "   ", "notepad", "cmd.exe /c del *", "\\\\host\\share\\u.exe", "C:\\a\\..\\b\\u.exe", "C:\\x\\u.exe\u0000",
    "%ProgramFiles%\\a\\u.exe", "C:\\a\\u.bat", '"C:\\a\\u.exe"/S', "C:\\a/u.exe", "x".repeat(2100)])
    assert.equal(parseUninstallCommand(bad), null, String(bad).slice(0, 30));
});

test("listPrograms: hides system components, updates and nameless entries; sorts; ids are stable and opaque", async () => {
  const keys = [
    key("Zed", { DisplayName: "Zed Editor", Publisher: "Z Inc", DisplayVersion: "1.2", UninstallString: '"C:\\Zed\\unins.exe"', EstimatedSize: "0x400" }),
    key("Alpha", { DisplayName: "alpha app", UninstallString: "C:\\Alpha\\u.exe" }),
    key("Sys", { DisplayName: "Hidden Component", SystemComponent: "0x1", UninstallString: "C:\\S\\u.exe" }),
    key("Upd", { DisplayName: "Update for X", ParentKeyName: "X", UninstallString: "C:\\S\\u.exe" }),
    key("Nameless", { UninstallString: "C:\\S\\u.exe" }),
  ];
  const regQuery = async n => (n === "uninstallHKLM" ? { ok: true, keys } : { ok: true, keys: [] });
  const r = await listPrograms(regQuery);
  assert.equal(r.ok, true);
  assert.deepEqual(r.programs.map(p => p.name), ["alpha app", "Zed Editor"]);
  assert.match(r.programs[0].id, /^[0-9a-f]{16}$/);
  assert.equal(r.programs[1].sizeKb, 1024);
  const row = programRow(r.programs[1]);
  assert.deepEqual(Object.keys(row).sort(), ["canUninstall", "id", "name", "publisher", "scope", "sizeKb", "version"]);
  assert.equal(JSON.stringify(row).includes("unins"), false, "a row never carries the command or a path");
  assert.equal(row.canUninstall, true);
  assert.equal((await listPrograms(async () => ({ ok: false }))).ok, false);
});

test("listPrograms: lossy text or a command that cannot be parsed cannot be uninstalled", async () => {
  const bad = key("Bad", { DisplayName: "Odd", UninstallString: "cmd.exe /c something" });
  const lossy = { path: "HKEY_LOCAL_MACHINE\\x\\Lossy", values: { DisplayName: { type: "REG_SZ", data: "Caf\u00e9", lossy: true }, UninstallString: { type: "REG_SZ", data: "C:\\a\\u.exe", lossy: false } } };
  const r = await listPrograms(async n => (n === "uninstallHKCU" ? { ok: true, keys: [bad, lossy] } : { ok: true, keys: [] }));
  assert.deepEqual(r.programs.map(p => programRow(p).canUninstall), [false, false]);
  assert.deepEqual(r.programs.map(p => p.hive), ["user", "user"]);
});

test("leftoverTarget: install location, else the icon's or uninstaller's folder", () => {
  assert.equal(leftoverTarget({ installLocation: "C:\\Apps\\Foo\\", displayIcon: "", uninstallCommand: "" }), "C:\\Apps\\Foo");
  assert.equal(leftoverTarget({ installLocation: "", displayIcon: '"C:\\Apps\\Bar\\bar.exe",0', uninstallCommand: "" }), "C:\\Apps\\Bar");
  assert.equal(leftoverTarget({ installLocation: "", displayIcon: "", uninstallCommand: '"C:\\Apps\\Baz\\unins.exe" /S' }), "C:\\Apps\\Baz");
  assert.equal(leftoverTarget({ installLocation: "relative", displayIcon: "", uninstallCommand: "" }), "");
});

test("winapps: package names are strict, scripts fixed, the removal literal is quoted", () => {
  const ok = "Microsoft.XboxApp_48.49.31001.0_x64__8wekyb3d8bbwe";
  assert.ok(PACKAGE_FULL_NAME.test(ok));
  for (const bad of ["", "a b_1.0_x64__8wekyb3d8bbwe", ok + "; calc", "x'; Remove-Item *; '_1.0_x64__8wekyb3d8bbwe", "..\\x", ok.replace("8wekyb3d8bbwe", "short")])
    assert.ok(!PACKAGE_FULL_NAME.test(bad), bad);
  assert.throws(() => removeScript("x; calc"));
  assert.ok(removeScript(ok).includes("Remove-AppxPackage -Package '" + ok + "' -ErrorAction Stop"));
  assert.ok(!/-AllUsers/.test(removeScript(ok)) && !/-AllUsers/.test(LIST_SCRIPT), "current user only");
});

test("winapps: list output is parsed and filtered through the same strict patterns", async () => {
  const good = "Contoso.App_1.2.3.4_x64__8wekyb3d8bbwe";
  const payload = JSON.stringify([{ n: "Contoso.App", f: good, v: "1.2.3.4" }, { n: "Evil", f: "bad name", v: "1" }, { n: "<b>", f: good, v: "1" }, null]);
  const spawnFn = () => {
    const h = {};
    const out = { on: (e, cb) => { if (e === "data") setImmediate(() => cb(Buffer.from(payload))); } };
    const child = { stdout: out, kill() {}, once: (e, cb) => { h[e] = cb; if (e === "close") setTimeout(() => cb(0), 20); } };
    return child;
  };
  const r = await listWindowsApps({ spawnFn });
  assert.equal(r.ok, true);
  assert.deepEqual(r.apps.map(a => a.fullName), [good]);
});

test("runUninstaller: refuses relative/odd input before anything starts; passes arguments through verbatim", async () => {
  let started = 0;
  const spawnFn = (exe, args, o) => { started++; spawnFn.last = { exe, args, o }; const c = { once: (e, cb) => { if (e === "exit") setImmediate(() => cb(0)); }, kill() {} }; return c; };
  for (const bad of [{ exe: "unins.exe", args: "" }, { exe: "C:\\a\\u.txt", args: "" }, { exe: "C:\\a\\u.exe", args: "x\u0000" }, { exe: "C:\\a/u.exe", args: "" }])
    assert.equal((await runUninstaller({ ...bad, spawnFn, exists: () => true })).ok, false);
  assert.equal((await runUninstaller({ exe: "C:\\a\\u.exe", args: "", spawnFn, exists: () => false })).ok, false);
  assert.equal(started, 0);
  const r = await runUninstaller({ exe: "C:\\a\\u.exe", args: "/S /v\"/qn\"", spawnFn, exists: () => true });
  assert.deepEqual(r, { ok: true, code: 0 });
  assert.equal(spawnFn.last.o.shell, false);
  assert.equal(spawnFn.last.o.windowsVerbatimArguments, true);
  assert.deepEqual(spawnFn.last.args, ['/S /v"/qn"']);
});

test("IPC: the four new channels exist; ids must be 16 hex, nothing else is accepted", () => {
  for (const c of ["nuke:programs:list", "nuke:programs:uninstall", "nuke:apps:list", "nuke:apps:remove"]) assert.ok(CHANNELS.includes(c), c);
  assert.deepEqual(validateArgs("nuke:programs:uninstall", [{ id: "0123456789abcdef" }]), { ok: true, value: { id: "0123456789abcdef" } });
  for (const bad of [[{ id: "C:\\Windows\\x.exe" }], [{ id: "0123456789abcdeF" }], [{ id: "0123456789abcdef", cmd: "x" }], [{}], [], [{ id: 5 }], ["0123456789abcdef"]])
    assert.equal(validateArgs("nuke:apps:remove", bad).ok, false);
  assert.equal(validateArgs("nuke:programs:list", [{ id: "0123456789abcdef" }]).ok, false, "list takes no argument");
});

const SID = "S-1-5-21-11-22-33-1001";
function ctl(o = {}) {
  const ui = { phases: [], confirms: [], sendPhase: p => ui.phases.push(p), sendProgress() {}, showResults() {}, closeResults() {},
    confirmAction: async m => { ui.confirms.push(m); return o.yes ?? true; }, confirmPermanent: async () => true, askContinueWithoutRestore: async () => true };
  const program = key("Foo", { DisplayName: "Foo Tool", UninstallString: '"C:\\Foo\\unins.exe" /SILENT', InstallLocation: "C:\\Foo" });
  const readPrograms = async () => listPrograms(async n => (n === "uninstallHKLM" ? { ok: true, keys: [program] } : { ok: true, keys: [] }));
  const ran = [];
  const scans = [];
  const c = createController({ ui, paths: { settingsFile: "x" }, identity: { elevated: false, sid: SID }, profileRoot: "C:\\Users\\me",
    runScan: async (k, a) => { scans.push({ k, a }); return { kind: "investigate", items: [], notes: [], allowedRoots: [], protectedPaths: [] }; },
    readPrograms, runProgramUninstaller: async x => { ran.push(x); return o.runResult ?? { ok: true, code: 0 }; },
    readApps: async () => ({ ok: true, apps: [{ name: "Contoso.App", fullName: "Contoso.App_1.2.3.4_x64__8wekyb3d8bbwe", version: "1.2.3.4" }] }),
    removeApp: async n => { ran.push({ remove: n }); return { ok: o.removeOk ?? true }; } });
  return { c, ui, ran, scans };
}

test("controller: programs list gives ids only; uninstall needs a known id, a yes, then runs the parsed command and scans the install folder", async () => {
  const { c, ui, ran, scans } = ctl();
  const list = await c.programsList();
  assert.equal(list.rows.length, 1);
  assert.equal(JSON.stringify(list).includes("unins"), false);
  await assert.rejects(c.programsUninstall({ id: "0000000000000000" }), /refused/);
  await c.programsUninstall({ id: list.rows[0].id });
  assert.match(ui.confirms[0], /Foo Tool/);
  assert.match(ui.confirms[0], /C:\\Foo\\unins\.exe \/SILENT/, "the exact command is shown first");
  assert.deepEqual(ran, [{ exe: "C:\\Foo\\unins.exe", args: "/SILENT" }]);
  assert.equal(scans.length, 1);
  assert.equal(scans[0].k, "investigate");
  assert.equal(scans[0].a.target, "C:\\Foo");
});

test("controller: answering no starts nothing; a failed uninstaller reports a fixed message and scans nothing", async () => {
  const no = ctl({ yes: false });
  const l1 = await no.c.programsList();
  const r1 = await no.c.programsUninstall({ id: l1.rows[0].id });
  assert.equal(r1.cancelled, true);
  assert.deepEqual(no.ran, []);
  const fail = ctl({ runResult: { ok: false, reason: "missing" } });
  const l2 = await fail.c.programsList();
  assert.equal((await fail.c.programsUninstall({ id: l2.rows[0].id })).ok, false);
  assert.equal(fail.scans.length, 0);
  assert.ok(fail.ui.phases.some(p => p.phase === "error" && /could not be run/.test(p.detail)));
});

test("controller: Windows apps are removed by opaque id after a yes", async () => {
  const { c, ui, ran } = ctl();
  const l = await c.appsList();
  assert.equal(JSON.stringify(l).includes("8wekyb3d8bbwe"), false, "the full package name stays in main");
  await assert.rejects(c.appsRemove({ id: "ffffffffffffffff" }), /refused/);
  const r = await c.appsRemove({ id: l.rows[0].id });
  assert.equal(r.ok, true);
  assert.match(ui.confirms[0], /Contoso\.App/);
  assert.deepEqual(ran, [{ remove: "Contoso.App_1.2.3.4_x64__8wekyb3d8bbwe" }]);
});

test("winapps: the list script is pinned by hash (any change must be reviewed here)", async () => {
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(LIST_SCRIPT).digest("hex"), "50f8aef36b06d450814231ba7d125d0e693a645ba41639fd44d0539bd6ed56c4");
});
