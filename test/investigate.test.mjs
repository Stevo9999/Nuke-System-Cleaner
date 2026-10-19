import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync, unlinkSync, rmdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { investigate, readProgramEntries } from "../lib/investigate.mjs";

function world() {
  const root = realpathSync.native(mkdtempSync(tmpdir() + "\\inv-"));
  const home = root + "\\home";
  const env = {
    USERPROFILE: home,
    LOCALAPPDATA: home + "\\AppData\\Local",
    APPDATA: home + "\\AppData\\Roaming",
    ProgramData: root + "\\PD",
    ProgramFiles: root + "\\PF",
  };
  for (const d of [env.LOCALAPPDATA + "\\Programs", env.APPDATA + "\\Microsoft\\Windows\\Start Menu\\Programs", home + "\\AppData\\LocalLow", env.ProgramData, env.ProgramFiles])
    mkdirSync(d, { recursive: true });
  return { root, home, env, clean: () => rmSync(root, { recursive: true, force: true }) };
}
const file = (p, body = "x") => { mkdirSync(p.slice(0, p.lastIndexOf("\\")), { recursive: true }); writeFileSync(p, body); };
const val = (data, lossy = false) => ({ type: "REG_SZ", data, lossy });
const ukey = (name, v) => ({ path: "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + name, values: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? val(x) : x])) });
function fakeReg({ hkcu = [], hklm = [], wow = [], services = [], partial = false, fail = [] } = {}) {
  const map = { uninstallHKCU: hkcu, uninstallHKLM: hklm, uninstallWow: wow, services };
  return async (name) => {
    if (fail.includes(name)) return { ok: false, reason: "x" };
    if (name in map) return partial ? { ok: true, keys: map[name], partial: true, notes: ["1 line skipped"] } : { ok: true, keys: map[name] };
    return { ok: true, keys: [] }; // run keys
  };
}
const noTasks = async () => ({ ok: true, tasks: [] });
const lnkMap = (m) => (f) => (f in m ? m[f] : { ok: false, reason: "none" });
const by = (r, p) => r.items.find((i) => i.path && i.path.toLowerCase() === p.toLowerCase());
const run = (w, target, o = {}) => investigate(target, { env: w.env, home: w.home, regQuery: fakeReg(), listScheduledTasks: noTasks, readLnk: () => ({ ok: false }), ...o });

test("exe in a per-user install folder: install folder, exact AppData leftovers and Start Menu shortcut are high; entry is report-only", async () => {
  const w = world();
  try {
    const inst = w.env.LOCALAPPDATA + "\\Programs\\Foo";
    file(inst + "\\foo.exe");
    file(w.env.LOCALAPPDATA + "\\Foo\\cache.bin");
    file(w.env.APPDATA + "\\Foo\\settings.ini");
    const lnk = w.env.APPDATA + "\\Microsoft\\Windows\\Start Menu\\Programs\\Foo\\Foo.lnk";
    file(lnk);
    const r = await run(w, inst + "\\foo.exe", {
      regQuery: fakeReg({ hkcu: [ukey("Foo", { DisplayName: "Foo App", Publisher: "Foo Inc", InstallLocation: '"' + inst + '"' })] }),
      readLnk: lnkMap({ [lnk]: { ok: true, target: inst + "\\foo.exe", network: false, device: false } }),
    });
    assert.equal(r.kind, "investigate");
    for (const p of [inst + "\\foo.exe", inst, w.env.LOCALAPPDATA + "\\Foo", w.env.APPDATA + "\\Foo", lnk]) {
      const f = by(r, p);
      assert.ok(f, "missing " + p);
      assert.equal(f.group, "exclusive", p);
      assert.equal(f.confidence, "high", p);
      assert.equal(f.preTicked, true, p);
    }
    const entry = r.items.find((i) => i.kind === "entry");
    assert.equal(entry.group, "report-only");
    assert.equal(entry.selectable, false);
    assert.match(entry.reason, /not changed in this version/);
  } finally { w.clean(); }
});

test("publisher folder shared with another installed entry is shared, unticked, sharedWith names the other program", async () => {
  const w = world();
  try {
    const inst = w.env.LOCALAPPDATA + "\\Programs\\Foo";
    file(inst + "\\foo.exe");
    file(w.env.LOCALAPPDATA + "\\Acme\\Foo\\a.txt");
    const r = await run(w, inst + "\\foo.exe", {
      regQuery: fakeReg({ hkcu: [
        ukey("Foo", { DisplayName: "Foo", Publisher: "Acme", InstallLocation: inst }),
        ukey("Bar", { DisplayName: "Bar Tool", Publisher: "Acme", InstallLocation: "C:\\Elsewhere\\Bar" }),
      ] }),
    });
    const pub = by(r, w.env.LOCALAPPDATA + "\\Acme");
    assert.equal(pub.group, "shared");
    assert.deepEqual([...pub.sharedWith], ["Bar Tool"]);
    assert.equal(pub.preTicked, false);
    assert.notEqual(pub.confidence, "high");
    assert.equal(by(r, w.env.LOCALAPPDATA + "\\Acme\\Foo").confidence, "high");
  } finally { w.clean(); }
});

test("publisher folder holding only the product folder, no other entry: offered exclusive", async () => {
  const w = world();
  try {
    const inst = w.env.LOCALAPPDATA + "\\Programs\\Foo";
    file(inst + "\\foo.exe");
    file(w.env.LOCALAPPDATA + "\\Acme\\Foo\\a.txt");
    const r = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [ukey("Foo", { DisplayName: "Foo", Publisher: "Acme", InstallLocation: inst })] }) });
    assert.equal(by(r, w.env.LOCALAPPDATA + "\\Acme").group, "exclusive");
  } finally { w.clean(); }
});

test("display-name-only match is medium; prefix match is low; neither pre-ticked", async () => {
  const w = world();
  try {
    const inst = w.env.LOCALAPPDATA + "\\Programs\\Foo";
    file(inst + "\\foo.exe");
    file(w.env.APPDATA + "\\Foo Application\\a.txt");
    file(w.env.APPDATA + "\\Foo Application Updater\\a.txt");
    file(w.env.APPDATA + "\\Foobar\\a.txt");
    const r = await run(w, inst + "\\foo.exe", {
      regQuery: fakeReg({ hkcu: [ukey("Foo", { DisplayName: "Foo Application", Publisher: "Zed", InstallLocation: inst })] }),
    });
    const name = by(r, w.env.APPDATA + "\\Foo Application");
    assert.equal(name.confidence, "medium");
    assert.equal(name.preTicked, false);
    const fuzzy = by(r, w.env.APPDATA + "\\Foo Application Updater");
    assert.equal(fuzzy.confidence, "low");
    assert.equal(fuzzy.preTicked, false);
    assert.equal(by(r, w.env.APPDATA + "\\Foobar"), undefined, "no word boundary, no match");
  } finally { w.clean(); }
});

test("lossy names never match; network target traced to nothing", async () => {
  const w = world();
  try {
    const inst = w.env.LOCALAPPDATA + "\\Programs\\Cafe";
    file(inst + "\\cafe.exe");
    file(w.env.APPDATA + "\\Cafe\\a.txt");
    file(w.env.APPDATA + "\\Lossy Display\\a.txt");
    const r = await run(w, inst + "\\cafe.exe", {
      regQuery: fakeReg({ hkcu: [ukey("Cafe", { DisplayName: val("Lossy Display", true), InstallLocation: val(inst, true) })] }),
    });
    assert.equal(r.items.find((i) => i.kind === "entry"), undefined, "lossy entry never matches");
    assert.equal(by(r, w.env.APPDATA + "\\Lossy Display"), undefined, "lossy display name never matches");
    // lossy entry still makes a shared claim on a folder it might own
    const inst2 = w.env.LOCALAPPDATA + "\\Programs\\Cafe";
    file(inst2 + "\\cafe.exe");
    const r2 = await run(w, inst2 + "\\cafe.exe", {
      regQuery: fakeReg({ hkcu: [
        ukey("Cafe", { DisplayName: "Cafe", InstallLocation: inst2 }),
        ukey("Other", { DisplayName: val("Caf?", true) }),
      ] }),
    });
    const c = by(r2, w.env.APPDATA + "\\Cafe");
    assert.equal(c.group, "shared");
    assert.equal(c.preTicked, false);

    // network target: nothing traced, nothing touched
    const lnk = w.home + "\\AppData\\Local\\Programs\\net.lnk";
    file(lnk);
    const r3 = await run(w, lnk, { readLnk: () => ({ ok: true, target: "\\\\srv\\share\\x.exe", network: true, device: false }) });
    assert.match(r3.notes.join("|"), /shortcut points to a network location; not traced/);
    assert.deepEqual(r3.items.map((i) => i.path), [lnk]);
    const r4 = await run(w, lnk, { readLnk: () => ({ ok: true, target: null, network: false, device: false }) });
    assert.deepEqual(r4.items.map((i) => i.path), [lnk]);
    const r5 = await run(w, lnk, { readLnk: () => ({ ok: true, target: "\\\\?\\C:\\x.exe", network: true, device: true }) });
    assert.deepEqual(r5.items.map((i) => i.path), [lnk]);
  } finally { w.clean(); }
});

test("a partial registry read never produces high confidence for derived items", async () => {
  const w = world();
  try {
    const inst = w.env.LOCALAPPDATA + "\\Programs\\Foo";
    file(inst + "\\foo.exe");
    file(w.env.LOCALAPPDATA + "\\Foo\\a.txt");
    const entry = ukey("Foo", { DisplayName: "Foo", InstallLocation: inst });
    const r = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [entry], partial: true }) });
    assert.equal(r.partial, true);
    assert.notEqual(by(r, w.env.LOCALAPPDATA + "\\Foo").confidence, "high");
    const r2 = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [entry], fail: ["uninstallHKLM"] }) });
    assert.notEqual(by(r2, w.env.LOCALAPPDATA + "\\Foo").confidence, "high");
  } finally { w.clean(); }
});

test("leftover folder that is a junction is protected", async () => {
  const w = world();
  const junc = w.env.LOCALAPPDATA + "\\Foo";
  try {
    const inst = w.env.LOCALAPPDATA + "\\Programs\\Foo";
    file(inst + "\\foo.exe");
    file(w.root + "\\elsewhere\\a.txt");
    symlinkSync(w.root + "\\elsewhere", junc, "junction");
    const r = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [ukey("Foo", { DisplayName: "Foo", InstallLocation: inst })] }) });
    const f = by(r, junc);
    assert.equal(f.group, "protected");
    assert.equal(f.selectable, false);
  } finally {
    try { unlinkSync(junc); } catch { try { rmdirSync(junc); } catch { /* ignore */ } }
    w.clean();
  }
});

test("Program Files and ProgramData results are protected, not offered", async () => {
  const w = world();
  try {
    const inst = w.env.ProgramFiles + "\\Foo";
    file(inst + "\\foo.exe");
    file(w.env.ProgramData + "\\Foo\\a.txt");
    file(w.env.LOCALAPPDATA + "\\Foo\\a.txt");
    const r = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hklm: [{ ...ukey("Foo", { DisplayName: "Foo", InstallLocation: inst }) }] }) });
    for (const p of [inst, inst + "\\foo.exe", w.env.ProgramData + "\\Foo"]) {
      const f = by(r, p);
      assert.ok(f, p);
      assert.equal(f.group, "protected", p);
      assert.equal(f.selectable, false, p);
    }
    assert.equal(by(r, w.env.LOCALAPPDATA + "\\Foo").selectable, true);
  } finally { w.clean(); }
});

test("services, tasks, startup entries pointing into the install folder are report-only; reader failure becomes a note", async () => {
  const w = world();
  try {
    const inst = w.env.LOCALAPPDATA + "\\Programs\\Foo";
    file(inst + "\\foo.exe");
    const entry = ukey("Foo", { DisplayName: "Foo", InstallLocation: inst });
    const reg = async (name) => {
      if (name === "services") return { ok: true, keys: [{ path: "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\FooSvc", values: { ImagePath: val('"' + inst + '\\svc.exe" -run') } },
        { path: "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Other", values: { ImagePath: val("C:\\Other\\o.exe") } }] };
      if (name === "runHKCU") return { ok: true, keys: [{ path: "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run", values: { Foo: val('"' + inst + '\\foo.exe" --tray') } }] };
      return fakeReg({ hkcu: [entry] })(name);
    };
    const r = await run(w, inst + "\\foo.exe", {
      regQuery: reg,
      listScheduledTasks: async () => ({ ok: true, tasks: [{ name: "\\FooUpdate", run: inst + "\\up.exe /check", lossy: false }, { name: "\\Nope", run: "C:\\x\\y.exe", lossy: false }] }),
    });
    for (const k of ["service", "task", "startup"]) {
      const l = r.items.filter((i) => i.kind === k);
      assert.equal(l.length, 1, k);
      assert.equal(l[0].group, "report-only");
      assert.equal(l[0].selectable, false);
    }
    const r2 = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [entry] }), listScheduledTasks: async () => { throw new Error("boom"); } });
    assert.match(r2.notes.join("|"), /scheduled tasks could not be read/);
    const r3 = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [entry] }), listScheduledTasks: async () => ({ ok: false, reason: "x" }) });
    assert.match(r3.notes.join("|"), /scheduled tasks could not be read/);
  } finally { w.clean(); }
});

test("missing shortcut target: note + the shortcut itself offered; UNC picked target refused before any fs call", async () => {
  const w = world();
  try {
    const lnk = w.env.LOCALAPPDATA + "\\Programs\\Gone.lnk";
    file(lnk);
    const r = await run(w, lnk, { readLnk: () => ({ ok: true, target: w.env.LOCALAPPDATA + "\\Programs\\Gone\\gone.exe", network: false, device: false }) });
    assert.match(r.notes.join("|"), /no longer exists/);
    const f = by(r, lnk);
    assert.ok(f);
    assert.equal(f.group, "exclusive");

    const r2 = await investigate("\\\\server\\share\\x.exe", { env: w.env, home: w.home, regQuery: () => { throw new Error("no"); }, readLnk: () => { throw new Error("no"); } });
    assert.deepEqual(r2.items, []);
    assert.ok(r2.notes.length > 0);
    const r3 = await investigate("\\\\?\\C:\\x.exe", { env: w.env, home: w.home });
    assert.deepEqual(r3.items, []);
  } finally { w.clean(); }
});

test("picked folder directly under a drive root is protected (read-only, no writes to the drive root)", async () => {
  const w = world();
  try {
    const driveRoot = parse(tmpdir()).root;
    const r0 = await run(w, driveRoot);
    assert.equal(by(r0, driveRoot).group, "protected");
    assert.equal(by(r0, driveRoot).selectable, false);
    const child = readdirSync(driveRoot, { withFileTypes: true }).find((d) => d.isDirectory() && !d.isSymbolicLink() && !/^\$|System Volume/i.test(d.name));
    if (child) {
      const p = driveRoot + child.name;
      const r = await run(w, p);
      const f = by(r, p);
      assert.equal(f.group, "protected");
      assert.equal(f.selectable, false);
      assert.match(f.reason, /drive root, home or system folders|system folder|protected/);
    }
  } finally { w.clean(); }
});

test("picked item directly in home is protected; protected roots are never offered (R32)", async () => {
  const w = world();
  try {
    file(w.home + "\\loose.exe");
    const r = await run(w, w.home + "\\loose.exe");
    assert.equal(by(r, w.home + "\\loose.exe").group, "protected");
    // installLocation that is a protected root must not be offered
    const inst = w.env.LOCALAPPDATA;
    file(inst + "\\bar.exe");
    const r2 = await run(w, inst + "\\bar.exe", { regQuery: fakeReg({ hkcu: [ukey("Bar", { DisplayName: "Bar", InstallLocation: inst })] }) });
    assert.equal(r2.items.find((i) => i.kind === "entry"), undefined);
    assert.ok(!r2.items.some((i) => i.path && i.path.toLowerCase() === inst.toLowerCase() && i.selectable));
  } finally { w.clean(); }
});

test("readProgramEntries trims quotes and icon index, flags lossy", async () => {
  const k = [
    ukey("A", { DisplayName: "A", DisplayIcon: '"C:\\Apps\\A\\a.exe",0', UninstallString: '"C:\\Apps\\A\\unins000.exe" /S', InstallLocation: '"C:\\Apps\\A\\"' }),
    ukey("B", { DisplayName: val("B?", true) }),
  ];
  const r = await readProgramEntries(fakeReg({ hkcu: k }));
  assert.equal(r.ok, true);
  assert.equal(r.entries[0].displayIcon, "C:\\Apps\\A\\a.exe");
  assert.equal(r.entries[0].uninstallString, "C:\\Apps\\A\\unins000.exe");
  assert.equal(r.entries[0].installLocation, "C:\\Apps\\A");
  assert.equal(r.entries[1].lossy, true);
  const bad = await readProgramEntries(fakeReg({ fail: ["uninstallHKLM"] }));
  assert.equal(bad.ok, false);
});


// ---------- fix round 1 ----------
const LNKDIR = (w) => w.env.APPDATA + "\\Microsoft\\Windows\\Start Menu\\Programs";

test("C1: publisher folder is shared when its product folder (or anything inside) belongs to another program", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA, A = w.env.APPDATA;
    const inst = L + "\\Programs\\Foo3";
    file(inst + "\\foo.exe");
    file(A + "\\Acme3\\Foo3\\Plugins\\Bar\\b.exe");
    const r = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [
      ukey("Foo3", { DisplayName: "Foo3", Publisher: "Acme3", InstallLocation: inst }),
      ukey("Bar", { DisplayName: "Bar", Publisher: "BarSoft", InstallLocation: A + "\\Acme3\\Foo3\\Plugins\\Bar" })] }) });
    for (const p of [A + "\\Acme3\\Foo3", A + "\\Acme3"]) {
      const f = by(r, p);
      assert.equal(f.group, "shared", p);
      assert.equal(f.preTicked, false, p);
      assert.ok(f.sharedWith.includes("Bar"), p);
    }
  } finally { w.clean(); }
});

test("C2: icon/uninstall-only entries count as claims; two distinct entries in the pick's folder make everything derived shared", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA, A = w.env.APPDATA;
    const acme = L + "\\Acme\\Suite";
    file(acme + "\\foo.exe"); file(acme + "\\bar.exe"); file(A + "\\Suite\\x");
    const lnk = LNKDIR(w) + "\\Suite.lnk"; file(lnk);
    const r = await run(w, acme + "\\foo.exe", {
      regQuery: fakeReg({ hkcu: [ukey("Foo", { DisplayName: "Foo", DisplayIcon: acme + "\\foo.exe" }), ukey("Bar", { DisplayName: "Bar", DisplayIcon: acme + "\\bar.exe" })] }),
      readLnk: lnkMap({ [lnk]: { ok: true, target: acme + "\\foo.exe", network: false, device: false } }),
    });
    for (const p of [A + "\\Suite", acme, lnk]) {
      const f = by(r, p);
      assert.ok(f, "present: " + p);
      assert.notEqual(f.group, "exclusive", p);
      assert.equal(f.preTicked, false, p);
    }
    assert.ok(by(r, acme), "install folder offered");
    assert.equal(by(r, acme).group, "shared");
    const inst = L + "\\Programs\\Solo";
    file(inst + "\\solo.exe"); file(A + "\\Solo\\x");
    const r2 = await run(w, inst + "\\solo.exe", { regQuery: fakeReg({ hkcu: [
      ukey("Solo", { DisplayName: "Solo", InstallLocation: inst }),
      ukey("Other", { DisplayName: "Other", UninstallString: '"' + A + '\\Solo\\unins.exe" /S' })] }) });
    assert.equal(by(r2, A + "\\Solo").group, "shared");
  } finally { w.clean(); }
});

test("C3 (R34): a lossy install location inside a candidate makes it shared", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA;
    const inst = L + "\\Programs\\Foo2";
    file(inst + "\\foo.exe"); file(inst + "\\addons\\Caf\u00e9\\c.exe");
    const r = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [
      ukey("Foo2", { DisplayName: "Foo2", InstallLocation: inst }),
      ukey("Cafe", { DisplayName: "Cafe Addon", InstallLocation: inst + "\\addons\\Caf\u00e9" })] }) });
    const f = by(r, inst);
    assert.equal(f.group, "shared");
    assert.equal(f.preTicked, false);
  } finally { w.clean(); }
});

test("lossy entry that might cover the item blocks high; a clean read would be high", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA;
    const inst = L + "\\Programs\\Foo";
    file(inst + "\\foo.exe"); file(L + "\\Foo\\a.txt");
    const clean = ukey("Foo", { DisplayName: "Foo", InstallLocation: inst });
    const r0 = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [clean] }) });
    assert.equal(by(r0, L + "\\Foo").confidence, "high");
    const r = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [clean, ukey("X", { DisplayName: "X", InstallLocation: val(L + "\\Programs\\Fo?", true) })] }) });
    assert.notEqual(by(r, L + "\\Foo").confidence, "high");
    assert.equal(by(r, L + "\\Foo").preTicked, false);
  } finally { w.clean(); }
});

test("I1: a Start Menu shortcut into another program's folder is shared; stale shortcut into an existing vendor folder is not pre-ticked", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA;
    const inst = L + "\\Programs\\Foo4";
    file(inst + "\\foo.exe"); file(inst + "\\Bar\\bar.exe");
    const lnk = LNKDIR(w) + "\\Bar.lnk"; file(lnk);
    const r = await run(w, inst + "\\foo.exe", {
      regQuery: fakeReg({ hkcu: [ukey("Foo4", { DisplayName: "Foo4", InstallLocation: inst }), ukey("Bar", { DisplayName: "Bar", InstallLocation: inst + "\\Bar" })] }),
      readLnk: lnkMap({ [lnk]: { ok: true, target: inst + "\\Bar\\bar.exe", network: false, device: false } }),
    });
    const f = by(r, lnk);
    assert.equal(f.group, "shared");
    assert.equal(f.preTicked, false);
    assert.equal(by(r, inst).group, "shared");

    const vendor = L + "\\Vendor";
    file(vendor + "\\other.exe"); file(L + "\\Vendor2\\x");
    const lnk2 = LNKDIR(w) + "\\Old.lnk"; file(lnk2);
    const lnk3 = LNKDIR(w) + "\\Other.lnk"; file(lnk3);
    const r2 = await run(w, lnk2, { readLnk: lnkMap({
      [lnk2]: { ok: true, target: vendor + "\\gone.exe", network: false, device: false },
      [lnk3]: { ok: true, target: vendor + "\\other.exe", network: false, device: false } }) });
    const derived = r2.items.filter((x) => x.category === "start-menu" || x.category === "leftover");
    assert.ok(derived.length > 0, "shortcut into the vendor folder is found");
    for (const i of derived) assert.equal(i.preTicked, false, i.path);
  } finally { w.clean(); }
});

test("I2: same name and publisher with a different install location is a second install: sharing", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA, A = w.env.APPDATA;
    const a = L + "\\Programs\\Foo5", b = w.root + "\\other\\Foo5";
    file(a + "\\foo.exe"); file(b + "\\foo.exe"); file(A + "\\Foo5\\x");
    const entries = [ukey("Foo5a", { DisplayName: "Foo5", Publisher: "P", InstallLocation: a }), ukey("Foo5b", { DisplayName: "Foo5", Publisher: "P", InstallLocation: b })];
    const r = await run(w, a + "\\foo.exe", { regQuery: fakeReg({ hkcu: entries }) });
    assert.equal(by(r, A + "\\Foo5").group, "shared");
    const r2 = await run(w, a + "\\foo.exe", { regQuery: fakeReg({ hklm: [entries[0]], wow: [entries[0]] }) });
    assert.equal(by(r2, A + "\\Foo5").group, "exclusive");
  } finally { w.clean(); }
});

test("I3: container folders picked directly are protected", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA;
    for (const p of [L + "\\Programs", w.home + "\\AppData\\LocalLow", L + "\\Microsoft", L + "\\Packages", w.env.APPDATA + "\\Microsoft"]) {
      mkdirSync(p, { recursive: true });
      const r = await run(w, p);
      const f = by(r, p);
      assert.equal(f.group, "protected", p);
      assert.equal(f.preTicked, false, p);
    }
  } finally { w.clean(); }
});

test("I5: abort gives partial + a cancelled note at every stage; onProgress reports steps and a throwing callback is harmless", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA;
    const inst = L + "\\Programs\\Foo4";
    file(inst + "\\foo.exe");
    const lnk = LNKDIR(w) + "\\Foo.lnk"; file(lnk);
    const entry = ukey("Foo4", { DisplayName: "Foo4", InstallLocation: inst });
    let ac = new AbortController();
    let r = await run(w, inst + "\\foo.exe", { signal: ac.signal, regQuery: fakeReg({ hkcu: [entry] }), readLnk: () => { ac.abort(); return { ok: false }; } });
    assert.equal(r.partial, true);
    assert.match(r.notes.join("|"), /cancelled/);
    ac = new AbortController(); ac.abort();
    r = await run(w, inst + "\\foo.exe", { signal: ac.signal });
    assert.equal(r.partial, true);
    assert.match(r.notes.join("|"), /cancelled/);
    const seen = [];
    r = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [entry] }), onProgress: (m) => seen.push(m) });
    assert.ok(seen.length >= 3);
    r = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [entry] }), onProgress: () => { throw new Error("ui"); } });
    assert.ok(r.items.length > 0);
  } finally { w.clean(); }
});

test("hostile names: bidi, very long and control characters neither match nor crash, and lossy matching is fast", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA;
    const inst = L + "\\Programs\\Foo";
    file(inst + "\\foo.exe");
    file(w.env.APPDATA + "\\Foo\u202Egpj\\a.txt");
    file(w.env.APPDATA + "\\" + "Foo ".padEnd(200, "x") + "\\a.txt");
    const hostile = "Foo\u202E\r\n\u0000" + "?%".repeat(300) + "a".repeat(5000);
    const t0 = Date.now();
    const r = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [
      ukey("Foo", { DisplayName: "Foo", InstallLocation: inst }),
      ukey("Evil", { DisplayName: val(hostile, true), Publisher: val("?".repeat(500) + "b", true), InstallLocation: val("C:\\" + "?a".repeat(900), true) })] }) });
    assert.ok(Date.now() - t0 < 5000, "no catastrophic matching");
    const bidi = by(r, w.env.APPDATA + "\\Foo\u202Egpj");
    assert.ok(!bidi || bidi.confidence !== "high");
    const ent = await readProgramEntries(fakeReg({ hkcu: [ukey("E", { DisplayName: val(hostile, false) })] }));
    assert.equal(ent.entries[0].lossy, true);
  } finally { w.clean(); }
});


// ---------- fix round 2 ----------
test("R2-1: a nameless hidden entry's uninstaller makes the folder shared, but a nameless entry never matches positively", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA, A = w.env.APPDATA;
    const i2 = L + "\\Programs\\Foo2";
    file(i2 + "\\foo.exe"); file(A + "\\Acme2\\Foo2\\x"); file(A + "\\Acme2\\Foo2\\unins.exe");
    const r = await run(w, i2 + "\\foo.exe", { regQuery: fakeReg({ hkcu: [
      ukey("Foo2", { DisplayName: "Foo2", Publisher: "Acme2", InstallLocation: i2 }),
      ukey("{GUID-COMP}", { UninstallString: '"' + A + '\\Acme2\\Foo2\\unins.exe" /S' })] }) });
    const f = by(r, A + "\\Acme2\\Foo2");
    assert.equal(f.group, "shared");
    assert.equal(f.preTicked, false);
    assert.ok(f.sharedWith.includes("{GUID-COMP}"));
    // positive-match guard: a nameless entry whose icon sits in the picked folder is not "the program"
    const i3 = L + "\\Programs\\Foo3";
    file(i3 + "\\foo.exe");
    const r2 = await run(w, i3 + "\\foo.exe", { regQuery: fakeReg({ hkcu: [ukey("{HIDDEN}", { DisplayIcon: i3 + "\\foo.exe" })] }) });
    assert.equal(r2.items.find((i) => i.kind === "entry"), undefined);
  } finally { w.clean(); }
});

test("R38: the picked item gets the sharing check (publisher folder holding two programs; inside another program's folder)", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA;
    const pub4 = L + "\\Acme4";
    file(pub4 + "\\Foo4\\foo.exe"); file(pub4 + "\\Bar4\\bar.exe");
    const r = await run(w, pub4, { regQuery: fakeReg({ hkcu: [
      ukey("Foo4", { DisplayName: "Foo4", Publisher: "Acme4", InstallLocation: pub4 + "\\Foo4" }),
      ukey("Bar4", { DisplayName: "Bar4", Publisher: "Acme4", InstallLocation: pub4 + "\\Bar4" })] }) });
    const f = by(r, pub4);
    assert.equal(f.group, "shared");
    assert.equal(f.preTicked, false);
    assert.deepEqual([...f.sharedWith].sort(), ["Bar4", "Foo4"]);
    // picking a sub-folder of another registered program's install folder
    const r2 = await run(w, pub4 + "\\Foo4\\foo.exe", { regQuery: fakeReg({ hkcu: [
      ukey("Foo4", { DisplayName: "Foo4", InstallLocation: pub4 + "\\Foo4" }),
      ukey("Suite", { DisplayName: "Suite", InstallLocation: pub4 })] }) });
    const g = by(r2, pub4 + "\\Foo4\\foo.exe");
    assert.equal(g.group, "shared");
    assert.equal(g.preTicked, false);
  } finally { w.clean(); }
});

test("a value flagged lossy (e.g. duplicate value name) is a 'maybe' claim even when its text is clean", async () => {
  const w = world();
  try {
    const L = w.env.LOCALAPPDATA, A = w.env.APPDATA;
    const inst = L + "\\Programs\\Solo2";
    file(inst + "\\solo.exe"); file(A + "\\Solo2\\x");
    const entry = ukey("Solo2", { DisplayName: "Solo2", InstallLocation: inst });
    const r0 = await run(w, inst + "\\solo.exe", { regQuery: fakeReg({ hkcu: [entry, ukey("Plain", { DisplayName: "Different" })] }) });
    assert.equal(by(r0, A + "\\Solo2").group, "exclusive");
    const r = await run(w, inst + "\\solo.exe", { regQuery: fakeReg({ hkcu: [entry, ukey("Dup", { DisplayName: val("Different", true) })] }) });
    assert.equal(by(r, A + "\\Solo2").group, "shared");
  } finally { w.clean(); }
});

test("bidi-named fuzzy leftover is present, low and unticked", async () => {
  const w = world();
  try {
    const inst = w.env.LOCALAPPDATA + "\\Programs\\Foo";
    file(inst + "\\foo.exe");
    file(w.env.APPDATA + "\\Foo Application‮gpj\\a.txt");
    const r = await run(w, inst + "\\foo.exe", { regQuery: fakeReg({ hkcu: [ukey("Foo", { DisplayName: "Foo Application", InstallLocation: inst })] }) });
    const f = by(r, w.env.APPDATA + "\\Foo Application‮gpj");
    assert.ok(f, "present");
    assert.equal(f.confidence, "low");
    assert.equal(f.preTicked, false);
  } finally { w.clean(); }
});

