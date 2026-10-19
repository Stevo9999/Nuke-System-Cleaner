// Known-folder protection: HKCU User Shell Folders redirections + OneDrive Accounts UserFolder (read-only reg, injected here).
import test from "node:test";
import assert from "node:assert/strict";
import { appProtectedPaths, appProtectedRoots, violatesRoots, readKnownFolders } from "../../app/main/appdata.mjs";
import { checkPath } from "../../lib/safepath.mjs";

const HOME = "C:\\Users\\Fixture";
const rkey = (p, vals) => ({ path: p, values: Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, { type: "REG_EXPAND_SZ", data: v, lossy: v.includes("%") || v.includes("?") }])) });
const USF = "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
const fakeKnown = ({ usf, od, fail = [] } = {}) => {
  const calls = [];
  const fn = async name => {
    calls.push(name);
    if (fail.includes(name)) return { ok: false, reason: "reg.exe failed" };
    if (name === "userShellFolders") return { ok: true, keys: usf ? [rkey(USF, usf)] : [] };
    if (name === "oneDriveAccounts") return { ok: true, keys: (od || []).map((v, i) => rkey("HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\OneDrive\\Accounts\\Business" + (i + 1), { UserFolder: v })) };
    throw new Error("unexpected key " + name);
  };
  fn.calls = calls;
  return fn;
};

test("readKnownFolders: redirected Documents/Desktop/Pictures/Music/Videos/Downloads and OneDrive folders are read; %USERPROFILE% expands from the injected env", async () => {
  const reg = fakeKnown({
    usf: { Personal: "D:\\Docs", Desktop: "%USERPROFILE%\\Desktop", "My Pictures": "E:\\Pics", "My Music": "E:\\Mus", "My Video": "E:\\Vid",
      "{374DE290-123F-4565-9164-39C4925E467B}": "F:\\Dl", AppData: "C:\\ignored", Cache: "C:\\alsoignored" },
    od: ["C:\\Users\\Fixture\\OneDrive - Contoso Ltd", "D:\\Corp\\OneDrive"],
  });
  const r = await readKnownFolders({ readReg: reg, home: HOME, env: { USERPROFILE: HOME } });
  assert.deepEqual(reg.calls, ["userShellFolders", "oneDriveAccounts"]);
  assert.deepEqual([...r.paths].sort(), ["C:\\Users\\Fixture\\Desktop", "C:\\Users\\Fixture\\OneDrive - Contoso Ltd", "D:\\Corp\\OneDrive", "D:\\Docs", "E:\\Mus", "E:\\Pics", "E:\\Vid", "F:\\Dl"].sort());
  assert.deepEqual(r.notes, []);
});

test("readKnownFolders: read failure => a note and no paths (the caller keeps the existing list); hostile values are skipped, never trusted", async () => {
  const r1 = await readKnownFolders({ readReg: fakeKnown({ fail: ["userShellFolders", "oneDriveAccounts"] }), home: HOME, env: {} });
  assert.deepEqual(r1.paths, []);
  assert.equal(r1.notes.length, 2);
  const thrower = async () => { throw new Error("boom C:\\secret"); };
  const r2 = await readKnownFolders({ readReg: thrower, home: HOME, env: {} });
  assert.deepEqual(r2.paths, []);
  assert.ok(r2.notes.length >= 1 && !JSON.stringify(r2).includes("secret"));
  const r3 = await readKnownFolders({ readReg: fakeKnown({ usf: { Personal: "D:\\Docs" }, fail: ["oneDriveAccounts"] }), home: HOME, env: {} });
  assert.deepEqual(r3.paths, ["D:\\Docs"]);
  assert.equal(r3.notes.length, 1);
  // relative, unknown variable, lossy "?" and control characters are skipped with a note
  const r4 = await readKnownFolders({ readReg: fakeKnown({ usf: { Personal: "..\\Docs", Desktop: "%FOO%\\Desktop", "My Pictures": "E:\\Pi?s", "My Music": "E:\\M\u0001", "My Video": "D:\\ok" } }), home: HOME, env: { USERPROFILE: HOME } });
  assert.deepEqual(r4.paths, ["D:\\ok"]);
  assert.equal(r4.notes.length, 4);
  // no reader injected: notes only
  const r5 = await readKnownFolders({ home: HOME, env: {} });
  assert.deepEqual(r5.paths, []);
  assert.equal(r5.notes.length, 2);
  // never an exception on odd reader results
  for (const odd of [null, undefined, { ok: true }, { ok: true, keys: "x" }, { ok: true, keys: [null, 5, { path: 3 }] }]) {
    const r = await readKnownFolders({ readReg: async () => odd, home: HOME, env: {} });
    assert.ok(Array.isArray(r.paths) && Array.isArray(r.notes));
  }
});

test("appProtectedPaths / appProtectedRoots accept the extra known folders and never return fewer protections", () => {
  const base = { appDir: "C:\\App", dataRoot: "C:\\Data\\Nuke", home: HOME, env: {} };
  const plain = appProtectedPaths(base);
  const withExtra = appProtectedPaths({ ...base, extraPaths: ["D:\\Docs", "E:\\Pics", "relative", 7, "D:\\docs"] });
  for (const p of plain) assert.ok(withExtra.includes(p), p);
  assert.ok(withExtra.includes("D:\\Docs") && withExtra.includes("E:\\Pics"));
  assert.equal(withExtra.filter(p => p.toLowerCase() === "d:\\docs").length, 1, "deduped");
  assert.ok(!withExtra.includes("relative"));
  assert.deepEqual(appProtectedPaths({ ...base, extraPaths: undefined }), plain);
  assert.deepEqual(appProtectedPaths({ ...base, extraPaths: "D:\\Docs" }), plain, "a non-array adds nothing and does not throw");
  const r0 = appProtectedRoots({ home: HOME, env: {} });
  const r1 = appProtectedRoots({ home: HOME, env: {}, extraPaths: ["D:\\Docs"] });
  for (const p of r0) assert.ok(r1.includes(p));
  assert.ok(r1.includes("D:\\Docs"));
  assert.equal(checkPath("D:\\Docs\\a.txt", { allowedRoots: ["D:\\"], protectedPaths: withExtra }).ok, false);
  assert.equal(violatesRoots("D:\\Docs", r1), true);
  assert.equal(violatesRoots("D:\\", r1), true);
  assert.equal(violatesRoots("D:\\Other\\x", r1), false);
});
