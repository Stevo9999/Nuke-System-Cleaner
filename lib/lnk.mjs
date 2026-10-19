// Pure-Node, bounds-checked MS-SHLLINK (.lnk) parser. Never throws on bad input,
// never resolves or touches the shortcut's target. Only lstat/open/read of the .lnk itself.
import { lstatSync, openSync, readSync, closeSync, fstatSync } from "node:fs";

const HEADER_SIZE = 0x4c;
const MAX_STR = 32767;
const MAX_LNK_BYTES = 1024 * 1024;
const CLSID = Buffer.from("0114020000000000c000000000000046", "hex");

const F_IDLIST = 0x01, F_LINKINFO = 0x02, F_NAME = 0x04, F_RELPATH = 0x08;
const F_WORKDIR = 0x10, F_ARGS = 0x20, F_ICON = 0x40, F_UNICODE = 0x80;
const F_NOLINKINFO = 0x100, F_EXPSTRING = 0x200;

class Bad extends Error {}
const bad = (m) => { throw new Bad(m); };

const ansi = new TextDecoder("windows-1252");

// NUL-terminated string within [start, end) of buf; capped at MAX_STR chars.
// Returns { s, bytes } where bytes includes the terminator.
function cstr(buf, start, end, unicode) {
  if (!Number.isInteger(start) || start < 0 || start >= end || end > buf.length) bad("string offset out of range");
  const w = unicode ? 2 : 1;
  const limit = Math.min(end, start + (MAX_STR + 1) * w);
  for (let i = start; i + w <= limit; i += w) {
    if (unicode ? (buf[i] === 0 && buf[i + 1] === 0) : buf[i] === 0) {
      const s = unicode ? buf.toString("utf16le", start, i) : ansi.decode(buf.subarray(start, i));
      if (!s.isWellFormed()) bad("lone surrogate in string");
      return { s, bytes: i - start + w };
    }
  }
  return bad("unterminated or oversized string");
}

function joinPath(base, suffix) {
  const sfx = suffix.replace(/^[\\/]+/, "");
  if (!sfx) return base;
  return base + (/[\\/]$/.test(base) ? "" : "\\") + sfx;
}

// Windows path namespaces. Only drive-absolute paths are local.
//   device: \\?\ \\.\ \??\ (any slash mix)   unc: two leading separators (any mix)
function classify(t) {
  if (/^[\\/]{2}[?.](?:[\\/]|$)/.test(t) || /^[\\/]\?\?(?:[\\/]|$)/.test(t)) return "device";
  if (/^[\\/]{2}/.test(t)) return "unc";
  if (/^[A-Za-z]:[\\/]/.test(t)) return "local";
  return "other";
}

function parse(buf) {
  if (!Buffer.isBuffer(buf)) bad("not a buffer");
  if (buf.length < HEADER_SIZE) bad("short header");
  if (buf.length > MAX_LNK_BYTES) bad("too large");
  if (buf.readUInt32LE(0) !== HEADER_SIZE) bad("bad header size");
  if (!buf.subarray(4, 20).equals(CLSID)) bad("bad CLSID");
  const flags = buf.readUInt32LE(20);
  const unicode = (flags & F_UNICODE) !== 0;
  let pos = HEADER_SIZE;

  if (flags & F_IDLIST) {
    if (pos + 2 > buf.length) bad("idlist truncated");
    const sz = buf.readUInt16LE(pos);
    pos += 2;
    if (pos + sz > buf.length) bad("idlist past end");
    pos += sz;
  }

  let target = null;
  let network = false;
  let device = false;
  if (flags & F_LINKINFO) {
    const base = pos;
    if (base + 0x1c > buf.length) bad("linkinfo truncated");
    const liSize = buf.readUInt32LE(base);
    if (liSize < 0x1c || base + liSize > buf.length) bad("bad linkinfo size");
    const end = base + liSize;
    pos = end;
    // ForceNoLinkInfo: LinkInfo must be ignored (only skipped by its checked size).
    if (!(flags & F_NOLINKINFO)) {
      const hdr = buf.readUInt32LE(base + 4);
      if (hdr < 0x1c || hdr > liSize || (hdr > 0x1c && hdr < 0x24)) bad("bad linkinfo header size");
      const liFlags = buf.readUInt32LE(base + 8);
      const hasLocal = (liFlags & 1) !== 0;
      const hasNet = (liFlags & 2) !== 0;
      const used = []; // [start, end) ranges inside LinkInfo that hold data we read
      const claim = (s, e) => {
        if (s < hdr || e > liSize) bad("linkinfo data overlaps header or exceeds size");
        for (const [a, b] of used) if (s < b && a < e) bad("linkinfo data overlaps");
        used.push([s, e]);
      };
      const off = (o) => {
        const v = buf.readUInt32LE(base + o);
        if (v < hdr || v >= liSize) bad("linkinfo offset out of range");
        return v;
      };
      const lstr = (rel, uni) => {
        const r = cstr(buf, base + rel, end, uni);
        claim(rel, rel + r.bytes);
        return r.s;
      };
      let lossy = false; // an ANSI-only string with bytes >= 0x80 cannot be trusted
      let localBase = null, net = null, suffix = "";
      if (hasLocal) {
        const lbp = off(0x10);
        if (hdr >= 0x24 && buf.readUInt32LE(base + 0x1c) !== 0) {
          localBase = lstr(off(0x1c), true);
        } else {
          localBase = lstr(lbp, false);
          if (/[^\x00-\x7f]/.test(localBase)) lossy = true;
        }
      }
      if (hasNet) {
        network = true;
        const cn = off(0x14);
        const cb = base + cn;
        if (cb + 0x14 > end) bad("network link truncated");
        const cnSize = buf.readUInt32LE(cb);
        if (cnSize < 0x14 || cn + cnSize > liSize) bad("bad network link size");
        claim(cn, cn + cnSize);
        const cend = cb + cnSize;
        const nnOff = buf.readUInt32LE(cb + 8);
        if (nnOff < 0x14 || nnOff >= cnSize) bad("net name offset out of range");
        let uOff = 0;
        if (nnOff > 0x14) {
          if (cnSize < 0x1c) bad("network link truncated");
          uOff = buf.readUInt32LE(cb + 0x14);
          if (uOff !== 0 && (uOff < 0x1c || uOff >= cnSize)) bad("net name offset out of range");
        }
        if (uOff !== 0) {
          net = cstr(buf, cb + uOff, cend, true).s;
        } else {
          net = cstr(buf, cb + nnOff, cend, false).s;
          if (/[^\x00-\x7f]/.test(net)) lossy = true;
        }
      }
      if (hdr >= 0x24 && buf.readUInt32LE(base + 0x20) !== 0) {
        suffix = lstr(off(0x20), true);
      } else {
        const so = buf.readUInt32LE(base + 0x18);
        if (so !== 0) {
          if (so < hdr || so >= liSize) bad("suffix offset out of range");
          suffix = lstr(so, false);
          if (/[^\x00-\x7f]/.test(suffix)) lossy = true;
        }
      }

      let cand = null;
      if (hasLocal) cand = joinPath(localBase, suffix);
      else if (hasNet) cand = joinPath(net, suffix);
      if (cand !== null && cand.length > MAX_STR) bad("target too long");
      if (cand !== null) {
        const kind = classify(cand);
        if (kind === "device") { device = true; network = true; }
        else if (kind === "unc") network = true;
        // Only drive-absolute and UNC/device (flagged) text is ever returned; the rest is refused.
        // HasExpString: an environment-variable target may override LinkInfo; we do not expand it.
        if (!lossy && !(flags & F_EXPSTRING) && (kind !== "other" || (!hasLocal && hasNet))) target = cand;
      }
    }
  }

  const readStr = () => {
    if (pos + 2 > buf.length) bad("string data truncated");
    const n = buf.readUInt16LE(pos);
    pos += 2;
    if (n > MAX_STR) bad("string too long");
    const bytes = n * (unicode ? 2 : 1);
    if (pos + bytes > buf.length) bad("string past end");
    const s = unicode ? buf.toString("utf16le", pos, pos + bytes) : ansi.decode(buf.subarray(pos, pos + bytes));
    if (!s.isWellFormed()) bad("lone surrogate in string");
    pos += bytes;
    return s;
  };
  if (flags & F_NAME) readStr();
  if (flags & F_RELPATH) readStr();
  const workingDir = flags & F_WORKDIR ? readStr() : null;
  const args = flags & F_ARGS ? readStr() : "";
  if (flags & F_ICON) readStr();

  return { ok: true, target, args, workingDir, network, device };
}

export function parseLnk(buf) {
  try {
    return parse(buf);
  } catch (e) {
    return { ok: false, reason: e instanceof Bad ? e.message : "unreadable shortcut" };
  }
}

export function readLnk(file) {
  let fd = null;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    if (st.size < HEADER_SIZE || st.size > MAX_LNK_BYTES) return { ok: false, reason: "size out of range" };
    // Known, accepted race: the path could be swapped between lstat and open. We re-check the
    // opened handle is a regular file of the same size, and the parser bounds everything anyway;
    // the worst case is parsing a different small .lnk-shaped file, which is only ever read.
    fd = openSync(file, "r");
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size !== st.size) return { ok: false, reason: "file changed" };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    if (got !== buf.length) return { ok: false, reason: "short read" };
    return parseLnk(buf);
  } catch {
    return { ok: false, reason: "unreadable file" };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}
