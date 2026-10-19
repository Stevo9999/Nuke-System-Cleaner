import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseLnk, readLnk } from "../lib/lnk.mjs";

const CLSID = Buffer.from("0114020000000000c000000000000046", "hex");
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const wz = (s) => Buffer.from(s + "\0", "utf16le");
const az = (s) => Buffer.from(s + "\0", "latin1");

function header(flags) {
  const h = Buffer.alloc(76);
  h.writeUInt32LE(0x4c, 0);
  CLSID.copy(h, 4);
  h.writeUInt32LE(flags, 20);
  return h;
}
function sdata(s, unicode = true) {
  const b = unicode ? Buffer.from(s, "utf16le") : Buffer.from(s, "latin1");
  return Buffer.concat([u16(s.length), b]);
}
// LinkInfo with a local base path (ANSI, plus unicode variants when unicode=true).
function linkInfoLocal(local, suffix, { unicode = true } = {}) {
  const hdr = unicode ? 0x24 : 0x1c;
  const vol = Buffer.concat([u32(0x11), u32(3), u32(0), u32(0x10), Buffer.from("\0")]);
  const lbp = az(local), sfx = az(suffix);
  const ulbp = wz(local), usfx = wz(suffix);
  let o = hdr;
  const volOff = o; o += vol.length;
  const lbpOff = o; o += lbp.length;
  const sfxOff = o; o += sfx.length;
  const ulbpOff = o; if (unicode) o += ulbp.length;
  const usfxOff = o; if (unicode) o += usfx.length;
  const head = [u32(o), u32(hdr), u32(1), u32(volOff), u32(lbpOff), u32(0), u32(sfxOff)];
  if (unicode) head.push(u32(ulbpOff), u32(usfxOff));
  return Buffer.concat([...head, vol, lbp, sfx, ...(unicode ? [ulbp, usfx] : [])]);
}
function linkInfoNet(net, suffix) {
  const hdr = 0x1c;
  const nn = az(net);
  const cnrl = Buffer.concat([u32(0x14 + nn.length), u32(0), u32(0x14), u32(0), u32(0), nn]);
  const sfx = az(suffix);
  const cnOff = hdr, sfxOff = hdr + cnrl.length;
  const total = sfxOff + sfx.length;
  return Buffer.concat([u32(total), u32(hdr), u32(2), u32(0), u32(0), u32(cnOff), u32(sfxOff), cnrl, sfx]);
}
function build({ unicode = true, li, args, wd, idlist = Buffer.alloc(4) } = {}) {
  let flags = 0x01 | (unicode ? 0x80 : 0);
  if (li) flags |= 0x02;
  if (wd !== undefined) flags |= 0x10;
  if (args !== undefined) flags |= 0x20;
  const parts = [header(flags), u16(idlist.length), idlist];
  if (li) parts.push(li);
  if (wd !== undefined) parts.push(sdata(wd, unicode));
  if (args !== undefined) parts.push(sdata(args, unicode));
  return Buffer.concat(parts);
}

test("local target with unicode path and arguments", () => {
  const p = "C:\\Pr\u00f6gr\u00e4m Files\\\u00dcn\u00ef\\app\u4e2d.exe";
  const r = parseLnk(build({ li: linkInfoLocal("C:\\Pr\u00f6gr\u00e4m Files\\\u00dcn\u00ef", "app\u4e2d.exe"), args: "--flag \"x y\" \u00e9", wd: "C:\\Work" }));
  assert.deepEqual(r, { ok: true, target: p, args: "--flag \"x y\" \u00e9", workingDir: "C:\\Work", network: false, device: false });
  const a = parseLnk(build({ unicode: false, li: linkInfoLocal("C:\\Apps", "a.exe", { unicode: false }), args: "-q" }));
  assert.deepEqual(a, { ok: true, target: "C:\\Apps\\a.exe", args: "-q", workingDir: null, network: false, device: false });
});

test("no LinkInfo gives null target, empty args", () => {
  assert.deepEqual(parseLnk(build({})), { ok: true, target: null, args: "", workingDir: null, network: false, device: false });
});

test("UNC target is flagged network and returned as text only", () => {
  const r = parseLnk(build({ li: linkInfoNet("\\\\evil-host\\share", "dir\\x.exe") }));
  assert.equal(r.ok, true);
  assert.equal(r.network, true);
  assert.equal(r.target, "\\\\evil-host\\share\\dir\\x.exe");
  const r2 = parseLnk(build({ li: linkInfoLocal("\\\\srv\\s", "a.exe") }));
  assert.equal(r2.ok, true);
  assert.equal(r2.network, true);
});

test("malformed: short header, wrong CLSID, offsets past end, LinkInfo size loop, huge string length -> ok:false", () => {
  const good = build({ li: linkInfoLocal("C:\\A", "b.exe"), args: "x" });
  assert.equal(parseLnk(good).ok, true);
  const LI = 82; // 76 header + 2 idlist size + 4 idlist
  const mut = (fn) => { const b = Buffer.from(good); fn(b); return b; };
  const cases = {
    empty: Buffer.alloc(0),
    short: good.subarray(0, 40),
    notBuffer: "nope",
    clsid: mut((b) => { b[10] ^= 0xff; }),
    hdrsize: mut((b) => b.writeUInt32LE(0x50, 0)),
    idlistPastEnd: mut((b) => b.writeUInt16LE(0xffff, 76)),
    liSizePastEnd: mut((b) => b.writeUInt32LE(0x7fffffff, LI)),
    liSizeZero: mut((b) => b.writeUInt32LE(0, LI)),
    liSizeLoop: mut((b) => b.writeUInt32LE(4, LI)),
    lbpOffPastEnd: mut((b) => b.writeUInt32LE(0xfffffff0, LI + 0x10)),
    suffixOffPastEnd: mut((b) => b.writeUInt32LE(0xfffffff0, LI + 0x20)),
    ansiSuffixOffPastEnd: build({ unicode: false, li: (() => { const l = linkInfoLocal("C:\\A", "b.exe", { unicode: false }); l.writeUInt32LE(0xfffffff0, 0x18); return l; })() }),
    hdrBetween: mut((b) => b.writeUInt32LE(0x20, LI + 4)),
    truncatedStrings: good.subarray(0, good.length - 1),
    hugeStrLen: mut((b) => b.writeUInt16LE(0xffff, good.length - 4)),
    truncLinkInfo: good.subarray(0, 90),
    unterminated: mut((b) => { const sz = b.readUInt32LE(LI); b.fill(0x41, LI + 0x24, LI + sz); }),
  };
  for (const [name, buf] of Object.entries(cases)) {
    const r = parseLnk(buf);
    assert.equal(r.ok, false, name);
    assert.equal(typeof r.reason, "string", name);
  }
  const net = build({ li: linkInfoNet("\\\\h\\s", "a") });
  const cn = LI + 0x1c;
  const b1 = Buffer.from(net); b1.writeUInt32LE(0xffffffff, cn); assert.equal(parseLnk(b1).ok, false);
  const b2 = Buffer.from(net); b2.writeUInt32LE(0x7fffffff, cn + 8); assert.equal(parseLnk(b2).ok, false);
});

test("fuzz: random mutations never throw and results stay capped", () => {
  const good = build({ li: linkInfoLocal("C:\\A", "b.exe"), args: "x", wd: "C:\\W" });
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 3000; i++) {
    const b = Buffer.from(good);
    for (let k = 0; k < 1 + (rnd() % 4); k++) b[rnd() % b.length] = rnd() & 0xff;
    const r = parseLnk(rnd() % 5 === 0 ? b.subarray(0, rnd() % b.length) : b);
    assert.equal(typeof r.ok, "boolean");
    if (r.ok) assert.ok((r.target ?? "").length <= 32767 && r.args.length <= 32767);
  }
});

test("readLnk refuses a directory, a symlink, a 5 MB file", (t) => {
  const d = mkdtempSync(tmpdir() + "/nuke-lnk-");
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const good = build({ li: linkInfoLocal("C:\\A", "b.exe") });
  const f = d + "/ok.lnk";
  writeFileSync(f, good);
  assert.equal(readLnk(f).ok, true);
  assert.equal(readLnk(d).ok, false);
  assert.equal(readLnk(d + "/missing.lnk").ok, false);
  const big = d + "/big.lnk";
  writeFileSync(big, Buffer.concat([good, Buffer.alloc(5 * 1024 * 1024)]));
  assert.equal(readLnk(big).ok, false);
  const tiny = d + "/tiny.lnk";
  writeFileSync(tiny, good.subarray(0, 50));
  assert.equal(readLnk(tiny).ok, false);
  const sl = d + "/link.lnk";
  let made = false;
  try { symlinkSync(f, sl); made = true; } catch { /* no symlink privilege */ }
  if (made) assert.equal(readLnk(sl).ok, false);
  else t.diagnostic("symlink creation not permitted; symlink refusal not exercised");
});

test("lnk.mjs has no child_process, fs write or network import", () => {
  const src = readFileSync(new URL("../lib/lnk.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /child_process|node:net|node:http|node:https|node:dgram|node:dns|fetch\(|WebSocket/);
  assert.doesNotMatch(src, /writeFile|appendFile|unlink|rmSync|rmdir|mkdir|renameSync|copyFile|truncateSync|ftruncate|createWriteStream|chmod|symlink|writeSync|\bopen\w*\(\s*[^)]*"[wa+]/);
  assert.doesNotMatch(src, /\beval\b|new Function/);
  const imp = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imp, ["node:fs"]);
});

// ---- Fix round 1 ----
const LI = 82; // 76 header + 2 idlist size + 4 idlist
const withFlags = (buf, f) => { const b = Buffer.from(buf); b.writeUInt32LE(f, 20); return b; };
const local = (base, suffix = "x.exe", opts) => parseLnk(build({ li: linkInfoLocal(base, suffix, opts) }));

test("UNC in any slash mix is network; target text is kept, never resolved", () => {
  for (const base of ["\\/evil\\share", "/\\evil\\share", "//evil/share", "\\\\evil\\share"]) {
    const r = local(base);
    assert.equal(r.ok, true, base);
    assert.equal(r.network, true, base);
    assert.equal(r.device, false, base);
    assert.equal(r.target, base + "\\x.exe", base);
  }
});

test("device/namespace paths are flagged device (and network, fail closed)", () => {
  for (const base of ["\\\\?\\C:\\dir", "\\\\.\\pipe\\x", "\\??\\C:\\dir", "//?/C:/dir", "\\/.\\pipe"]) {
    const r = local(base);
    assert.equal(r.ok, true, base);
    assert.equal(r.device, true, base);
    assert.equal(r.network, true, base);
  }
});

test("only drive-absolute targets are local; root-relative, drive-relative, relative -> target null", () => {
  for (const base of ["C:\\dir", "c:/dir", "Z:\\"]) {
    const r = local(base);
    assert.equal(r.network, false, base);
    assert.equal(r.device, false, base);
    assert.ok(r.target && r.target.endsWith("x.exe"), base);
  }
  for (const base of ["\\dir", "/dir", "C:dir", "dir\\sub", "..\\x", "http://h/x", "x"]) {
    const r = local(base);
    assert.equal(r.ok, true, base);
    assert.equal(r.target, null, "target must be null for: " + base);
  }
});

test("lone UTF-16 surrogates are refused (target, args, working dir)", () => {
  assert.equal(local("C:\\A\ud800").ok, false);
  assert.equal(parseLnk(build({ args: "x\udc00y" })).ok, false);
  assert.equal(parseLnk(build({ wd: "C:\\W\ud800" })).ok, false);
  assert.equal(local("C:\\A\ud83d\ude00").ok, true); // a valid pair is fine
});

test("ANSI-only path with a byte >= 0x80 fails closed (target null)", () => {
  const r = parseLnk(build({ unicode: false, li: linkInfoLocal("C:\\Pr\u00f6g", "a.exe", { unicode: false }) }));
  assert.equal(r.ok, true);
  assert.equal(r.target, null);
  const r2 = parseLnk(build({ unicode: false, li: linkInfoLocal("C:\\Prog", "\u00e9.exe", { unicode: false }) }));
  assert.equal(r2.target, null);
  // the Unicode variant of the same path is trusted
  assert.equal(local("C:\\Pr\u00f6g", "a.exe").target, "C:\\Pr\u00f6g\\a.exe");
});

test("ForceNoLinkInfo (0x100) ignores LinkInfo; HasExpString (0x200) nulls the target", () => {
  const li = linkInfoLocal("C:\\A", "b.exe");
  const base = build({ li, args: "x" });
  const flags = base.readUInt32LE(20);
  const none = { ok: true, target: null, args: "x", workingDir: null, network: false, device: false };
  assert.deepEqual(parseLnk(withFlags(base, flags | 0x100)), none);
  assert.deepEqual(parseLnk(withFlags(base, flags | 0x200)), none);
  // HasExpString on a network link still flags network (conservative)
  const n = build({ li: linkInfoNet("\\\\h\\s", "a.exe") });
  const f3 = parseLnk(withFlags(n, n.readUInt32LE(20) | 0x200));
  assert.equal(f3.ok, true);
  assert.equal(f3.target, null);
  assert.equal(f3.network, true);
  // ForceNoLinkInfo still bounds-checks the structure it skips
  const broken = Buffer.from(base); broken.writeUInt32LE(0x7fffffff, LI);
  assert.equal(parseLnk(withFlags(broken, flags | 0x100)).ok, false);
});

test("string offsets must be past the LinkInfo header and must not overlap", () => {
  const good = build({ li: linkInfoLocal("C:\\A", "b.exe") });
  const mut = (fn) => { const b = Buffer.from(good); fn(b); return b; };
  assert.equal(parseLnk(good).ok, true);
  const cases = {
    ansiLocalInHeader: mut((b) => b.writeUInt32LE(0x04, LI + 0x10)),
    unicodeLocalInHeader: mut((b) => b.writeUInt32LE(0x04, LI + 0x1c)),
    unicodeSuffixInHeader: mut((b) => b.writeUInt32LE(0x08, LI + 0x20)),
    unicodeSuffixOverlapsLocal: mut((b) => b.writeUInt32LE(b.readUInt32LE(LI + 0x1c), LI + 0x20)),
    unicodeSuffixOverlapsLocalMid: mut((b) => b.writeUInt32LE(b.readUInt32LE(LI + 0x1c) + 2, LI + 0x20)),
  };
  for (const [n, b] of Object.entries(cases)) assert.equal(parseLnk(b).ok, false, n);
  const ansi = build({ unicode: false, li: linkInfoLocal("C:\\A", "b.exe", { unicode: false }) });
  const a1 = Buffer.from(ansi); a1.writeUInt32LE(a1.readUInt32LE(LI + 0x10), LI + 0x18);
  assert.equal(parseLnk(a1).ok, false, "ansi suffix overlaps local");
  const a2 = Buffer.from(ansi); a2.writeUInt32LE(0x08, LI + 0x10);
  assert.equal(parseLnk(a2).ok, false, "ansi local inside header");
  const net = build({ li: linkInfoNet("\\\\h\\s", "a") });
  const n1 = Buffer.from(net); n1.writeUInt32LE(0x04, LI + 0x14);
  assert.equal(parseLnk(n1).ok, false, "network link inside header");
  const n2 = Buffer.from(net); n2.writeUInt32LE(0x04, LI + 0x1c + 8);
  assert.equal(parseLnk(n2).ok, false, "net name inside CNRL header");
});

test("a suffix with a leading backslash does not double the separator", () => {
  assert.equal(local("C:\\A", "\\b.exe").target, "C:\\A\\b.exe");
  assert.equal(local("C:\\A\\", "\\\\b.exe").target, "C:\\A\\b.exe");
});

test("committed Windows-generated fixtures parse to exact values", () => {
  const fx = (n) => fileURLToPath(new URL("../fixture/lnk/" + n, import.meta.url));
  const q = "Q:\\\u00dcn\u00ef \u20ac";
  // Windows wrote only an ANSI LinkInfo path here (cp1252 chars U+00DC U+00EF U+20AC), so the target
  // is withheld (fail closed); the StringData working dir is real UTF-16 and is returned.
  assert.deepEqual(readLnk(fx("unicode.lnk")), { ok: true, target: null, args: "--flag \"x y\" -q", workingDir: q, network: false, device: false });
  assert.deepEqual(readLnk(fx("ansi.lnk")), { ok: true, target: "Q:\\plain\\tool.exe", args: "/silent", workingDir: "Q:\\plain", network: false, device: false });
  // env-var-only target (HasExpString): we do not expand env vars, so no target
  assert.deepEqual(readLnk(fx("envvar.lnk")), { ok: true, target: null, args: "", workingDir: null, network: false, device: false });
  // UNC target: Windows also sets HasExpString here, so target is withheld but network is flagged
  assert.deepEqual(readLnk(fx("unc.lnk")), { ok: true, target: null, args: "-r", workingDir: null, network: true, device: false });
});
