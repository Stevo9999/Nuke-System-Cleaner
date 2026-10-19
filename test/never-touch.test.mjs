import test from "node:test";
import assert from "node:assert/strict";
import { neverTouchPath, neverTouchRegistryKey } from "../lib/never-touch.mjs";

const PROFILE = "C:\\Users\\me";
const np = (p, o = {}) => neverTouchPath(p, { profile: PROFILE, ...o });

test("paths: Windows, Program Files and the other system folders are refused, inside and as parents", () => {
  for (const p of ["C:\\Windows", "C:\\Windows\\System32\\config\\SAM", "c:\\WINDOWS\\WinSxS\\x", "C:\\Windows\\Installer\\a.msi", "C:\\Program Files\\App\\a.dll",
    "C:\\Program Files (x86)", "C:\\ProgramData\\Microsoft\\Windows Defender\\x", "C:\\System Volume Information", "C:\\Recovery\\a", "C:\\Boot\\BCD",
    "C:\\Users\\Default\\NTUSER.DAT", "C:\\Users\\Public\\x", "C:\\pagefile.sys", "C:\\hiberfil.sys", "C:\\Windows.old\\x", "C:\\EFI\\Microsoft"])
    assert.ok(np(p), p);
  assert.ok(np("C:\\"), "drive root");
  assert.match(np("C:\\ProgramData"), /contains a protected/, "a parent of a protected folder is refused too");
  assert.match(np("C:\\Users\\Default"), /protected/);
});

test("paths: a different drive keeps the same rule only for the system-folder names that exist there; odd forms fail closed", () => {
  for (const bad of [undefined, null, "", "relative\\x", "\\\\host\\share\\x", "C:/Windows", "C:\\a\u0000b", "x".repeat(2000), 5])
    assert.ok(np(bad), String(bad).slice(0, 20));
});

test("paths: ordinary user junk is not on the list", () => {
  for (const p of ["C:\\Users\\me\\AppData\\Local\\Temp\\a.tmp", "C:\\Users\\me\\AppData\\Local\\CrashDumps\\x.dmp", "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache",
    "D:\\Games\\Old\\x.bin", "C:\\ProgramData\\SomeVendor\\cache"])
    assert.equal(np(p), null, p);
});

test("paths: account secrets inside the profile are refused, siblings are not", () => {
  for (const p of ["C:\\Users\\me\\NTUSER.DAT", "C:\\Users\\me\\ntuser.dat.LOG1", "C:\\Users\\me\\AppData\\Local\\Microsoft\\Windows\\UsrClass.dat",
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\Windows\\UsrClass.dat.LOG2", "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Protect\\S-1-5-21\\key", "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Crypto",
    "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\SystemCertificates\\My", "C:\\Users\\me\\AppData\\Local\\Microsoft\\Credentials\\x", "C:\\Users\\me\\.ssh\\id_ed25519", "C:\\Users\\me\\.gnupg"])
    assert.ok(np(p), p);
  assert.match(np("C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Protect"), /protected account data/);
  assert.equal(np("C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Recent\\x.lnk"), null);
  assert.equal(np("C:\\Users\\me\\.sshfake\\x"), null, "whole-segment match only");
});

test("paths: only direct children of an administrator folder pass, and only when the controller names that folder", () => {
  const dirs = ["C:\\Windows\\Temp", "C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive"];
  assert.equal(neverTouchPath("C:\\Windows\\Temp\\a.tmp", { profile: PROFILE, allowedAdminDirs: dirs }), null);
  assert.ok(neverTouchPath("C:\\Windows\\Temp\\sub\\a.tmp", { profile: PROFILE, allowedAdminDirs: dirs }), "nested is refused");
  assert.ok(neverTouchPath("C:\\Windows\\Temp", { profile: PROFILE, allowedAdminDirs: dirs }), "the folder itself is refused");
  assert.ok(neverTouchPath("C:\\Windows\\System32\\a.dll", { profile: PROFILE, allowedAdminDirs: dirs }));
  assert.ok(np("C:\\Windows\\Temp\\a.tmp"), "without the folder named it is refused");
});

const rk = neverTouchRegistryKey;

test("registry: hive roots, SAM, SECURITY, HARDWARE, BCD, SYSTEM are refused in every spelling", () => {
  for (const k of ["HKLM", "HKEY_LOCAL_MACHINE", "HKCU", "HKEY_CURRENT_USER\\", "HKLM\\SAM", "HKEY_LOCAL_MACHINE\\SAM\\SAM\\Domains", "HKLM\\SECURITY", "HKLM\\HARDWARE\\DESCRIPTION",
    "HKLM\\BCD00000000\\Description", "HKLM\\SYSTEM", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Foo", "hklm\\system\\controlset001\\control", "HKCC\\Software", "HKU\\S-1-5-21-1-2-3-1001",
    "HKLM\\SOFTWARE", "HKLM\\SOFTWARE\\Microsoft", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion"])
    assert.ok(rk(k), k);
});

test("registry: COM and Windows Installer registrations, core file types and shell keys are refused from HKCR, HKLM and HKCU spellings", () => {
  for (const k of ["HKCR\\CLSID\\{00000000-0000-0000-0000-000000000000}", "HKCR\\Interface", "HKCR\\TypeLib\\{x}", "HKCR\\AppID", "HKCR\\Installer\\Products",
    "HKLM\\SOFTWARE\\Classes\\CLSID\\{x}\\InprocServer32", "HKCU\\Software\\Classes\\CLSID\\{x}", "HKLM\\SOFTWARE\\WOW6432Node\\Classes\\CLSID\\{x}",
    "HKCR\\.exe", "HKCR\\exefile\\shell\\open\\command", "HKCR\\.lnk", "HKCR\\lnkfile", "HKCR\\batfile", "HKCR\\.reg", "HKCR\\Directory\\shell", "HKCR\\Folder", "HKCR\\*\\shell", "HKCR\\http",
    "HKU\\S-1-5-21-1-2-3-1001\\Software\\Classes\\CLSID\\{x}", "HKU\\S-1-5-21-1-2-3-1001_Classes\\TypeLib"])
    assert.ok(rk(k), k);
});

test("registry: Windows internals, policies, persistence keys and user shell folders are refused", () => {
  for (const k of ["HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\x.exe",
    "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Installer\\UserData", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers",
    "HKLM\\SOFTWARE\\Policies\\Microsoft", "HKCU\\SOFTWARE\\Policies", "HKLM\\SOFTWARE\\Microsoft\\Active Setup\\Installed Components", "HKLM\\SOFTWARE\\Microsoft\\Windows Defender\\Exclusions",
    "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "HKCU\\Environment", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.txt", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer"])
    assert.ok(rk(k), k);
});

test("registry: the containers that hold uninstall, App Paths and Run entries cannot be deleted, but one entry inside can be named", () => {
  for (const k of ["HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce"])
    assert.ok(rk(k), k);
  for (const k of ["HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SomeApp", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SomeApp", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\app.exe",
    "HKCU\\Software\\SomeVendor\\SomeApp", "HKLM\\SOFTWARE\\SomeVendor", "HKCR\\SomeApp.Document", "HKCR\\Applications\\someapp.exe"])
    assert.equal(rk(k), null, k + " must be allowed by the deny-list (the allow-list decides separately)");
});

test("registry: odd input fails closed", () => {
  for (const k of [undefined, null, "", "NOPE\\x", "HKLM\\..\\SYSTEM", "HKLM/SOFTWARE/x", "HKLM\\a\u0000b", "HKU\\notasid\\Software", 7, "x".repeat(2000)])
    assert.ok(rk(k), String(k).slice(0, 20));
});
