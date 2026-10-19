// test/cleanup-page.test.mjs
// cleanup.html is served by the REAL server; these are source and header checks (no browser here).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createCleanupServer, selectionHash } from "../server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pageFile = path.join(root, "cleanup.html");
const src = fs.readFileSync(pageFile, "utf8");
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(src)[1];
const classic = /<script>([\s\S]*?)<\/script>/.exec(src)[1];
// R27: three.js 0.160.0 is vendored; these are the sha384 values that were pinned against the jsDelivr files.
const VENDOR_SRI = {
  "three.module.js": "sha384-61S/Nu32S3E5+n+KpCOTb2eRYps6fVKm+9Gz1QBvSePFthb46f063Aa/qe/lykFZ",
  "RoundedBoxGeometry.js": "sha384-S52/WAm3DaIIFna675h5dmavqea/akLlPFtPdnzgWWhnz+/nMqR6PPsSXPOd8Gpw",
  "RoomEnvironment.js": "sha384-ZGqh+dJjt6z9NHsWYYt+TPDFj8y+2If7naI6a6AkkyNZyH51CVS3HTWFh0njp4k6",
};
const sha256b64 = s => "'sha256-" + crypto.createHash("sha256").update(s, "utf8").digest("base64") + "'";
// the policy the server must send for a given served page: hashes of EVERY inline script block, no unsafe-inline for scripts
const expectedCsp = served => {
  const hashes = [...served.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/\bsrc\s*=/i.test(m[1])).map(m => sha256b64(m[2]));
  return `default-src 'self'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
};

const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: p, headers, agent: false }, res => {
    let d = ""; res.on("data", x => d += x); res.on("end", () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
  }).on("error", reject);
});

async function withServer(fn) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "cpage-"));
  try {
    const wr = path.join(t, "work"); fs.mkdirSync(wr);
    const f = path.join(wr, "a.txt"); fs.writeFileSync(f, "x");
    const sel = { sessionId: "S", allowedRoots: [wr], protectedPaths: [], livePaths: [], paths: [f] };
    sel.sha256 = selectionHash(sel);
    const selectionFile = path.join(t, "selection.json"); fs.writeFileSync(selectionFile, JSON.stringify(sel));
    const s = createCleanupServer({ selectionFile, pageFile, soundsDir: path.join(root, "sounds"), ttlMs: 60000, ageCheckOffForTests: true });
    const { port } = await s.listen();
    try { await fn({ port, token: s.token }); } finally { s.close(); }
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}

test("the real server serves cleanup.html only with the token, under the pinned CSP", async () => {
  await withServer(async ({ port, token }) => {
    const bad = await get(port, "/");
    assert.equal(bad.status, 403);
    const ok = await get(port, `/?t=${token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, src.split("__NUKE_TOKEN__").join(token), "served bytes are cleanup.html with this run's token in the import map");
    const csp = ok.headers["content-security-policy"];
    assert.equal(csp, expectedCsp(ok.body), "exact CSP string: self + a sha256 per inline script block");
    assert.equal([...ok.body.matchAll(/<script\b/g)].length, 3, "classic, import map and module blocks, all hashed");
    assert.ok(!/unsafe-inline/.test(csp.split("style-src")[0]) && !/cdn\.|https?:/.test(csp), "no unsafe-inline for scripts, no third-party origin");
    assert.match(csp, /default-src 'self'/); assert.match(csp, /frame-ancestors 'none'; base-uri 'none'; form-action 'none'/);
    assert.equal(ok.headers["referrer-policy"], "no-referrer");
    assert.equal(ok.headers["cache-control"], "no-store");
  });
});

test("the page loads nothing from any other origin (three.js is vendored)", () => {
  assert.deepEqual(src.match(/https?:\/\/[^\s"'`)<>]+/g) || [], [], "no absolute URLs at all");
  assert.ok(!/<(link|img|iframe|object|embed|form)\b/i.test(src), "no external-capable elements");
  assert.ok(!/<script[^>]*\ssrc=/i.test(src), "no external script tags");
  assert.ok(!/@import|url\(/i.test(src), "no CSS imports or url()");
  assert.ok(!/(^|[^.\w])(WebSocket|XMLHttpRequest|sendBeacon|importScripts)\b/.test(script));
  // every fetch targets a relative same-origin path
  for (const m of script.matchAll(/\bfetch\(\s*([^,)]*)/g)) assert.ok(!/https?:/.test(m[1]), `fetch target ${m[1]}`);
});

test("no markup injection or code evaluation anywhere in the page script", () => {
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\s*\.\s*write/, /\beval\s*\(/, /new\s+Function/, /\bFunction\s*\(/,
    /setTimeout\(\s*['"`]/, /setInterval\(\s*['"`]/, /createContextualFragment/, /srcdoc/, /DOMParser/, /\.src\s*=/, /setAttribute\(\s*['"](href|src|style|on)/i, /style\.cssText/, /\.on(click|error|load)\s*=\s*['"]/, /\.href\s*=/, /location\s*(\.\s*href)?\s*=[^=]/]) {
    assert.ok(!bad.test(script), `forbidden pattern ${bad}`);
  }
});

test("token: scrubbed by an inline classic script BEFORE any third-party code, handed over once, never stored or logged", () => {
  assert.ok(src.indexOf("<script>") < src.indexOf('<script type="importmap">'), "classic script comes first");
  assert.ok(src.indexOf("<script>") < src.indexOf('<script type="module">'));
  assert.equal([...src.matchAll(/get\('t'\)/g)].length, 1, "token read from the URL exactly once");
  assert.ok(/get\('t'\)/.test(classic) && !/get\('t'\)/.test(script));
  assert.ok(classic.includes("history.replaceState(null, '', location.pathname)"), "replaceState with pathname only, no search");
  assert.ok(classic.indexOf("get('t')") < classic.indexOf("history.replaceState"));
  assert.ok(/enumerable: false/.test(classic) && /delete window\.__nukeTok/.test(classic), "non-enumerable one-shot getter");
  assert.ok(!/^\s*import\s/m.test(script), "no static imports: CDN code cannot run before the token is taken");
  const dyn = [...script.matchAll(/await import\(/g)].map(m => m.index);
  assert.equal(dyn.length, 3, "three + two addons, dynamic");
  assert.ok(script.indexOf("window.__nukeTok()") < Math.min(...dyn), "token taken before any dynamic import");
  assert.equal([...script.matchAll(/__nukeTok\(\)/g)].length, 1);
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src));
  assert.ok(!/console\./.test(src));
  const uses = script.split("\n").filter(l => /\bTOKEN\b/.test(l) && !/^const TOKEN =/.test(l));
  for (const l of uses) assert.ok(/encodeURIComponent\(TOKEN\)|'x-nuke-token': TOKEN/.test(l), `unexpected TOKEN use: ${l.trim().slice(0, 80)}`);
});

test("vendored three.js: the files match the pinned sha384, the import map points only at the vendor routes, and the load-failure path is visible", async () => {
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(src)[1]);
  assert.deepEqual(Object.keys(map), ["imports"], "no integrity table, no scopes");
  assert.deepEqual(Object.keys(map.imports).sort(), ["three", "three/addons/environments/RoomEnvironment.js", "three/addons/geometries/RoundedBoxGeometry.js"]);
  for (const v of Object.values(map.imports)) assert.match(v, /^\/vendor\/(three\.module|RoundedBoxGeometry|RoomEnvironment)\.js\?t=__NUKE_TOKEN__$/);
  for (const [name, sri] of Object.entries(VENDOR_SRI)) {
    const b = fs.readFileSync(path.join(root, "vendor", name));
    assert.equal("sha384-" + crypto.createHash("sha384").update(b).digest("base64"), sri, name);
  }
  await withServer(async ({ port, token }) => {
    assert.equal((await get(port, "/vendor/three.module.js")).status, 403, "token-gated");
    for (const name of Object.keys(VENDOR_SRI)) {
      const r = await get(port, `/vendor/${name}?t=${token}`);
      assert.equal(r.status, 200, name); assert.equal(r.body, fs.readFileSync(path.join(root, "vendor", name), "utf8"));
      assert.match(r.headers["content-type"], /javascript/);
    }
    for (const bad of ["/vendor/evil.js", "/vendor/", "/vendor/..%2fserver.mjs", "/vendor/three.module.js/x", "/vendor/%2e%2e/server.mjs"]) {
      const r = await get(port, `${bad}${bad.includes("?") ? "&" : "?"}t=${token}`);
      assert.equal(r.status, 404, bad);
    }
  });
  for (const imp of script.matchAll(/await import\('([^']+)'\)/g)) assert.ok(imp[1] === "three" || imp[1].startsWith("three/addons/"));
  assert.ok(/catch \(e\) \{\s*\$\('#idle'\)\.textContent = 'The 3D library could not be loaded[^']*';\s*throw e;/.test(script), "plain error then stop");
  assert.ok(/id="arm" title="Begin" disabled/.test(src), "arm button starts disabled");
});

test("server text is rendered through textContent / createElement only", () => {
  assert.ok(/textContent/.test(script) && /createElement/.test(script));
  assert.ok(!/\.(text|html)\s*\(/.test(script));
});

test("unlock only happens after the server answers ok to /unlock, after a physical key turn; the glass never detaches", () => {
  const unlock = /async function doUnlock\(\) \{([\s\S]*?)\n\}/.exec(script)[1];
  assert.ok(/j\.ok !== true/.test(unlock), "requires an explicit ok:true answer");
  assert.ok(unlock.indexOf("postApi('unlock')") < unlock.indexOf("enterUnlocked()"));
  assert.ok(/function enterUnlocked\(\) \{\s*if \(stage !== 'locked'\) return;/.test(script), "unlock starts only from enterUnlocked in the locked stage");
  assert.ok(!/lockOffset|lockAt|lock\.position\.x/.test(script), "the lock never shifts (user request)");
  assert.ok(!/glassState|snapping|falling|snapAt|\bgv\b/.test(script), "no snap-off / free-fall code remains");
  assert.ok(!/(hinge|glass\w*)\.visible\s*=|hinge\.position\.(addScaledVector|y\b)|scene\.remove\(hinge|device\.remove\(hinge|hinge\.removeFromParent/.test(script), "glass is never hidden, removed or moved off its hinge");
  assert.ok(/e\.state === 'unlocked' && stage === 'locked' && keyState === 'turned'\) enterUnlocked\(\)/.test(script), "SSE resync only after a physical turn");
  assert.ok(/st\.state === 'unlocked'\) return enterUnlocked\(\)/.test(unlock), "lost reply resyncs from GET /state");
  // /unlock is posted from nowhere but doUnlock, which is called only from the pointer-driven turn threshold
  assert.equal([...script.matchAll(/postApi\('unlock'\)/g)].length, 1);
  assert.equal([...script.matchAll(/\bdoUnlock\(\)/g)].length, 2, "definition call site + one caller");
  assert.ok(/turnRot >= Math\.PI \/ 2 - 0\.04\) \{[^}]*doUnlock\(\)/.test(script), "threshold gates doUnlock");
  assert.ok(/pointerdown', e => \{\s*if \(!e\.isTrusted/.test(script), "scripted events cannot drive the key");
  assert.ok(/pointermove', e => \{\s*if \(!e\.isTrusted\) return;/.test(script), "pointermove ignores scripted events too");
});

test("the button re-fetches /state and never auto-retries /confirm", () => {
  const press = /async function press\(\) \{([\s\S]*?)\n\}\nfunction blast/.exec(script)[1];
  assert.ok(press.indexOf("getJson('state')") < press.indexOf("postApi('confirm')"), "state re-fetched first");
  assert.ok(/st\.state !== 'unlocked'/.test(press));
  assert.equal([...script.matchAll(/postApi\('confirm'\)/g)].length, 1);
  assert.ok(press.indexOf("stage = 'pressing'") !== -1 && press.indexOf("stage = 'pressing'") < press.indexOf("await"), "re-entry guard set before the first await");
  assert.ok(/stage !== 'unlocked'\) return;/.test(press));
  assert.ok(/minGapMs/.test(press) && /canPress\(serverState, glassAngle\)/.test(press), "min-gap and glass-open gate");
  assert.ok(press.indexOf("if (stage !== 'pressing') return;") > press.indexOf("postApi('confirm')"), "does not overwrite a dead state after confirm");
  assert.ok(!/for\s*\(|while\s*\(|setInterval|catch\s*\([^)]*\)\s*\{[^}]*press\(/.test(press), "no loop or retry inside press");
  assert.ok(!/setTimeout\(\s*press|setInterval\(\s*press/.test(script));
  assert.ok(/pointerdown[\s\S]*canPress\(serverState, glassAngle\) && pick\(e, \[cap\]\)\) \{ press\(\)/.test(script), "press is only reached from a pointer event on the cap");
});

test("refused items are rendered as refused and non-interactive", () => {
  assert.ok(/it\.refused \? 'refused'/.test(script));
  assert.ok(/#items li\.refused/.test(src));
  assert.ok(!/addEventListener\('click'[^)]*items|#items[^;]*onclick/.test(src), "item rows have no click handlers");
  assert.ok(/#items \{[^}]*list-style:none/.test(src));
});

test("helper functions behave (run in a vm with stubs)", async () => {
  const grab = re => re.exec(script)[0];
  const code = [grab(/function fmt\(b\) \{.*\}\n/), grab(/const cleanText = .*\n/), grab(/const short = .*\n/), grab(/const cleanPath = .*\n/), grab(/async function errText\(r\) \{.*\}\n/)].join("\n");
  const ctx = vm.createContext({});
  vm.runInContext(code + "\nthis.fmt = fmt; this.short = short; this.errText = errText;", ctx);
  assert.equal(ctx.fmt(0), "0 B"); assert.equal(ctx.fmt(1536), "1.5 KB"); assert.equal(ctx.fmt(160 * 1024 * 1024), "160 MB"); assert.equal(ctx.fmt("junk"), "0 B");
  assert.equal(ctx.short("x".repeat(500)).length, 200); assert.equal(ctx.short(null), "");
  assert.equal(await ctx.errText(null), "the app is not responding");
  assert.equal(await ctx.errText({ ok: true, status: 200 }), "unexpected reply (HTTP 200)");
  assert.equal(await ctx.errText({ ok: false, status: 409, json: async () => ({ error: "too fast" }) }), "too fast (HTTP 409)");
  assert.equal(await ctx.errText({ ok: false, status: 500, json: async () => { throw new Error("x"); } }), "no details (HTTP 500)");
});

test("accessibility and honesty notes are present; the verdict depends on results", () => {
  assert.ok(/id="hint" role="status" aria-live="polite"/.test(src) && /id="toast" role="status" aria-live="polite"/.test(src));
  assert.ok(/no keyboard shortcut/.test(script) && /Nothing is deleted until you press the red button. The app will close automatically if you do not finish in time/.test(script));
  // The page runs both in the app (closing the page cancels) and from the /nuke command (it does not): it claims neither.
  assert.ok(!/Closing this page (does not )?cancel/.test(script), "no claim about what closing the page does");
  assert.ok(!/Run \/nuke/.test(src), "no /nuke instruction on the page");
  assert.match(src, /<title>Nuke-Uninstaller<\/title>/);
  assert.ok(script.includes("else if (r.status === 'deleted') kind = 'deleted'") && script.includes("const anyDeleted = rows.some(x => x.kind === 'deleted')"));
  assert.ok(/anyDeleted \? 'DETONATED' : 'NOTHING DELETED'/.test(script));
  assert.equal([...script.matchAll(/DETONATED/g)].length, 1, "the word appears in one results-dependent place only");
});

const viewSrc = () => script.slice(script.indexOf("function showDiskMap"), script.indexOf("window.fmt = fmt"));

test("disk map: layout is inlined (CSP-safe), no module fetch, no export", () => {
  assert.ok(!/squarify\.mjs/.test(script), "no extra module fetch; the layout is inlined and tested equal to lib/squarify.mjs");
  assert.equal([...script.matchAll(/^function squarify\(/gm)].length, 1);
  assert.ok(!/\bexport\b/.test(script));
  assert.ok(!/\.style\.[a-zA-Z]+\s*=[^;]*\b(path|reason|status|it\.|coveredBy)/.test(viewSrc()), "no server data into styles");
});

test("every aria-live region is written only through put() (write-on-change)", () => {
  const ids = [...src.matchAll(/id="([a-z]+)"[^>]*aria-live/g)].map(m => m[1]);
  assert.deepEqual(ids.sort(), ["hint", "maptext", "toast"]);
  for (const id of ids) {
    for (const line of script.split("\n").filter(l => l.includes(`#${id}'`))) assert.ok(!/textContent/.test(line), `${id}: bare textContent write: ${line.trim()}`);
  }
  assert.ok(/function toast\(msg\) \{ const t = \$\('#toast'\); put\(t, short\(msg\)\)/.test(script), "toast goes through put()");
  assert.ok(/const put = \(node, text\) => \{ if \(node\.textContent !== text\)/.test(script));
});

test("disk map is a modal dialog, the 3D page is inert while it is open, Close leaves a summary in the banner", () => {
  assert.ok(/<div id="map" role="dialog" aria-modal="true" aria-labelledby="verdict">/.test(src));
  assert.ok(/app\.inert = true/.test(viewSrc()) && /app\.inert = false/.test(viewSrc()));
  assert.ok(/\$\('#banner'\)\.replaceChildren\(document\.createTextNode\(/.test(viewSrc()));
  assert.ok(!/id="after"/.test(src));
  assert.ok(fs.readFileSync(path.join(root, ".gitattributes"), "utf8").replace(/\r/g, "").startsWith("* text=auto eol=lf\nvendor/** -text\n"), "the two base rules stay first (later lines may add CRLF rules for Windows-only files)");
});

test("disk map: cells only for sized, non-refused, uncovered items; deletion shown only for server status deleted", () => {
  const view = viewSrc();
  assert.ok(/!x\.it\.refused && !x\.it\.coveredBy && x\.value > 0/.test(view));
  assert.ok(/cl\.ok = cl\.row\.kind === 'deleted'/.test(view));
  assert.equal([...view.matchAll(/\.ok = /g)].length, 1, "ok is assigned in one place only");
  assert.ok(/const anyDeleted = rows\.some\(x => x\.kind === 'deleted'\)/.test(view), "heading from the matched rows, not raw results");
});

// Run the real showDiskMap source against stub DOM/canvas and observe what it draws and writes.
function runMap(info, done, { steps = [0, 1e6], reduced = false, close = false } = {}) {
  const grab = re => re.exec(script)[0];
  const code = [grab(/function fmt\(b\) \{.*\}\n/), grab(/const cleanText = .*\n/), grab(/const short = .*\n/), grab(/const cleanPath = .*\n/), grab(/const put = .*\n/), grab(/const el = .*\n/),
    script.slice(script.indexOf("/* squarify:begin */"), script.indexOf("/* squarify:end */")),
    grab(/const num = .*\n/), grab(/const normP = .*\n/), viewSrc()].join("\n");
  const nodes = {}, draws = [], listeners = [], removed = [];
  const mk = sel => nodes[sel] ||= (() => {
    const n = { text: "", writes: 0, classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); } }, style: {}, children: [], inert: false,
      replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); }, focus() {}, clientWidth: 1000, clientHeight: 600,
      getContext() {
        const st = {};
        return new Proxy(st, { get: (t, k) => k in t ? t[k] : k === "measureText" ? s => ({ width: String(s).length * 6 }) : (...a) => { draws.push({ m: k, a, fs: t.fillStyle }); },
          set: (t, k, v) => { t[k] = v; draws.push({ m: "set", k, v }); return true; } });
      } };
    Object.defineProperty(n, "textContent", { get() { return this.text; }, set(v) { this.text = v; this.writes++; } });
    return n;
  })();
  const doc = { body: mk("body"), createElement: () => ({ textContent: "", className: "" }), createTextNode: t => ({ textContent: t }) };
  let frames = [];
  const ctx = vm.createContext({ $: mk, body: doc.body, info, doneEvent: done, document: doc, window: { matchMedia: true }, devicePixelRatio: 1, performance: { now: () => 0 }, Math, Number, Object, Array, String, Map,
    requestAnimationFrame: f => { frames.push(f); return frames.length; }, cancelAnimationFrame() { frames = []; },
    addEventListener: n => listeners.push(n), removeEventListener: n => removed.push(n), matchMedia: () => ({ matches: reduced }) });
  vm.runInContext(code + "\nthis.showDiskMap = showDiskMap;", ctx);
  ctx.showDiskMap();
  const pending = () => frames.length;
  for (const t of steps) { const f = frames; frames = []; f.forEach(fn => fn(t * 1000)); }
  if (close) nodes["#mapclose"].onclick();
  const texts = draws.filter(d => d.m === "fillText").map(d => d.a[0]);
  return { nodes, draws, texts, pending, listeners, removed, liveText: () => ["#verdict", "#freed", "#maptext", "#mapprog"].map(k => (nodes[k] || {}).text || "").join(" | ") };
}
const P = { big: String.raw`C:\w\big.bin`, keep: String.raw`C:\w\keep.txt`, inner: String.raw`C:\w\big.bin\inner.txt`, evil: String.raw`C:\evil\<b>x</b>`, zero: String.raw`C:\w\empty.txt` };
const baseInfo = () => ({ items: [
  { path: P.big, isDir: true, bytes: 1000 }, { path: P.keep, isDir: false, bytes: 500 },
  { path: P.inner, isDir: false, bytes: 0, coveredBy: P.big }, { path: P.evil, isDir: false, bytes: 0, refused: true, reason: "protected" },
  { path: P.zero, isDir: false, bytes: 0 }],
  drives: { "C:\\": { total: 10000, free: 4000 } } });
const res = (path, status, extra = {}) => ({ path, status, bytes: 0, ...extra });
const goodDone = (o = {}) => ({ freedBytes: 1100, sumBytes: 1000, measured: true, results: [
  res(P.big, "deleted", { bytes: 1000 }), res(P.keep, "failed", { reason: "EPERM" }), res(P.inner, "skipped", { reason: "already gone" }),
  res(P.evil, "skipped", { reason: "refused at launch: protected" }), res(P.zero, "deleted")], ...o });
const cellCount = r => r.draws.filter(d => d.m === "fillRect" && /^hsl\(/.test(d.fs)).length;
const sparks = r => r.draws.filter(d => d.m === "fillRect" && d.a[2] === 3 && d.a[3] === 3).length;
const flashes = r => r.draws.filter(d => d.m === "fillRect" && /^rgba\(255,/.test(d.fs)).length;

test("disk map run: real paths, differing totals, covered item is NOT counted as kept, cells only for sized/uncovered/non-refused items", () => {
  const r = runMap(baseInfo(), goodDone());
  assert.equal(r.nodes["#verdict"].text, "DETONATED");
  assert.equal(r.nodes["#freed"].text, "Free space went up by 1.1 KB");
  assert.match(r.nodes["#maptext"].text, /\(measured, not estimated\)/);
  assert.match(r.nodes["#maptext"].text, /differs from the real figure by 100 bytes/);
  assert.match(r.nodes["#maptext"].text, /2 item\(s\) were NOT removed/, "keep.txt failed + the refused one; the covered item is not counted");
  const li = r.nodes["#results"].children.map(c => c.textContent);
  assert.equal(li.length, 5);
  assert.match(li[0], /^Deleted 1000 B/); assert.match(li[1], /NOT removed \(failed: EPERM\)/);
  assert.equal(li[2], "Removed with " + P.big + ": " + P.inner);
  assert.match(li[3], /NOT removed \(refused before launch: protected\).*<b>x<\/b>/, "markup stays literal text");
  assert.match(li[4], /^Deleted 0 B/);
  // cells: only big and keep (inner is covered, evil refused, empty has 0 bytes)
  assert.equal(cellCount(runMap(baseInfo(), goodDone(), { steps: [0] })), 2);
  assert.ok(r.texts.some(t => /NOT removed: EPERM/.test(t)));
  assert.ok(r.nodes["#mapclose"].classList.s.has("ready"));
  // drive logic ran: the red sliver is the 500 B left (keep.txt), not the 1500 B selection (880px strip => 44px vs 132px)
  const red = r.draws.filter(d => d.m === "fillRect" && d.fs === "#ff3b1f").pop();
  assert.ok(red && Math.abs(red.a[2] - 44) < 0.01, `sliver ${red && red.a[2]}`);
});

test("disk map run: a plain already-gone item is labelled and, like a covered one, does not count as kept", () => {
  const info = baseInfo(); info.items.push({ path: String.raw`C:\w\gone.txt`, isDir: false, bytes: 7 });
  const done = goodDone(); done.results.push(res(String.raw`C:\w\gone.txt`, "skipped", { reason: "already gone" }));
  const r = runMap(info, done);
  assert.equal(r.nodes["#results"].children[5].textContent, "Already gone: " + String.raw`C:\w\gone.txt`);
  assert.match(r.nodes["#maptext"].text, /2 item\(s\) were NOT removed/);
});

test("disk map run: nothing deleted -> NOTHING DELETED, Nothing freed, no flash/spark for kept items, outside free-space change not claimed", () => {
  const done = { freedBytes: 5000, sumBytes: 0, measured: true, results: baseInfo().items.map(i => res(i.path, "failed", { reason: "EBUSY" })) };
  const r = runMap(baseInfo(), done);
  assert.equal(r.nodes["#verdict"].text, "NOTHING DELETED");
  assert.equal(r.nodes["#freed"].text, "Nothing freed");
  assert.match(r.nodes["#maptext"].text, /No item was deleted\./); assert.match(r.nodes["#maptext"].text, /did not cause/);
  assert.ok(!/Freed /.test(r.liveText()) && !/measured, not estimated/.test(r.liveText()));
  assert.equal(r.nodes["#mapfill"].style.width, "0%");
  assert.equal(sparks(r), 0, "no sparks"); assert.equal(flashes(r), 0, "no white flash");
  assert.ok(r.texts.filter(t => /NOT removed: EBUSY/.test(t)).length >= 1);
  const ok = runMap(baseInfo(), goodDone(), { steps: [1.8] });   // positive control: a deleted cell does flash and spark
  assert.ok(flashes(ok) > 0 && sparks(ok) > 0);
});

test("disk map run: statfs failure says free space could not be measured; never 'measured, not estimated' or 'differs'", () => {
  for (const measured of [false, undefined, "true"]) {
    const r = runMap(baseInfo(), goodDone({ measured, freedBytes: 0 }));
    assert.match(r.nodes["#maptext"].text, /could not be measured/);
    assert.ok(!/measured, not estimated|differs|Freed /.test(r.liveText()), r.liveText());
    assert.equal(r.nodes["#freed"].text, "Free space not measured");
  }
  const none = runMap(baseInfo(), { freedBytes: 0, sumBytes: 0, measured: false, results: baseInfo().items.map(i => res(i.path, "failed", { reason: "x" })) });
  assert.equal(none.nodes["#freed"].text, "Nothing freed"); assert.match(none.nodes["#maptext"].text, /could not be measured/);
});

test("disk map run: matching totals say so", () => {
  assert.match(runMap(baseInfo(), goodDone({ freedBytes: 1000 })).nodes["#maptext"].text, /which matches/);
});

test("disk map run: result pairing falls back to path; stray, missing and duplicate results are handled; mismatched deleted path is 'no result'", () => {
  const shuffled = { ...goodDone(), results: [res(P.zero, "deleted"), res(String.raw`C:\stray\x`, "deleted", { bytes: 99 }), res(P.big, "deleted", { bytes: 1000 }), res(P.evil, "skipped", { reason: "r" })] };
  let r = runMap(baseInfo(), shuffled);
  const li = r.nodes["#results"].children.map(c => c.textContent);
  assert.match(li[0], /^Deleted 1000 B/); assert.match(li[1], /NOT removed \(no result reported\)/);
  assert.ok(!li.some(t => /stray/.test(t)), "stray result is inert");
  assert.equal(r.nodes["#verdict"].text, "DETONATED");
  const dup = { items: [{ path: P.keep, bytes: 5 }, { path: P.keep, bytes: 0, coveredBy: P.keep }], drives: {} };
  r = runMap(dup, { freedBytes: 5, sumBytes: 5, measured: true, results: [res(P.keep, "deleted", { bytes: 5 }), res(P.keep, "skipped", { reason: "already gone" }), res(P.keep, "skipped", { reason: "already gone" })] });
  assert.deepEqual(r.nodes["#results"].children.map(c => c.textContent.slice(0, 12)), ["Deleted 5 B:", "Removed with"]);
  r = runMap({ items: [{ path: P.big, bytes: 10 }], drives: {} }, { freedBytes: 10, sumBytes: 10, measured: true, results: [res(String.raw`C:\other\file`, "deleted", { bytes: 10 })] });
  assert.equal(r.nodes["#verdict"].text, "NOTHING DELETED");
  assert.match(r.nodes["#results"].children[0].textContent, /no result reported/);
});

test("disk map run: hostile numbers never produce NaN, Infinity or negative text, or non-finite geometry", () => {
  for (const [freedBytes, sumBytes, bytes] of [["abc", "x", NaN], [-5, -9, -1], ["1e308", 1e308, 1e308], [Infinity, Infinity, Infinity], [null, undefined, "12"]]) {
    const info = { items: [{ path: P.big, bytes }, { path: P.keep, bytes: 100 }], drives: { "C:\\": { total: 1000, free: 5000 }, "D:\\": { total: 0, free: 0 }, "E:\\": null, "F:\\": { total: "q", free: NaN } } };
    const done = { freedBytes, sumBytes, measured: true, results: [res(P.big, "deleted", { bytes }), res(P.keep, "deleted", { bytes: 100 })] };
    const r = runMap(info, done, { steps: [0.5, 1.9, 1e6] });
    const all = r.liveText() + " " + r.texts.join(" ");
    assert.ok(!/NaN|Infinity|undefined|-\d/.test(all), `bad text for ${freedBytes},${sumBytes},${bytes}: ${all.slice(0, 200)}`);
    for (const d of r.draws) if (d.m === "fillRect" || d.m === "strokeRect") for (const v of d.a) assert.ok(Number.isFinite(v), `non-finite ${d.m} arg for ${freedBytes}`);
  }
  assert.equal(runMap({ items: [], drives: {} }, { freedBytes: 0, sumBytes: 0, measured: true, results: [] }).nodes["#verdict"].text, "NOTHING DELETED");
  assert.equal(runMap({ items: [{ path: "x", bytes: 1 }], drives: {} }, { measured: true, results: "nope" }).nodes["#verdict"].text, "NOTHING DELETED");
});

test("disk map run: reduced motion draws the final state once and queues no animation frame", () => {
  const r = runMap(baseInfo(), goodDone(), { steps: [], reduced: true });
  assert.equal(r.pending(), 0); assert.equal(sparks(r), 0);
  assert.equal(r.nodes["#verdict"].text, "DETONATED"); assert.ok(r.nodes["#mapclose"].classList.s.has("ready"));
});

test("disk map run: aria-live text is written only when it changes, mid-animation", () => {
  const r = runMap(baseInfo(), goodDone(), { steps: [0.2, 0.3, 0.4, 0.5] });
  assert.equal(r.nodes["#mapprog"].writes, 1, "same progress text across frames = one write");
  assert.equal(r.nodes["#verdict"].writes, 1);
  assert.equal(r.nodes["#verdict"].text, "Blast radius"); assert.equal((r.nodes["#maptext"] || { writes: 0 }).writes, 0);
});

test("disk map run: app is inert while open; Close removes listeners, stops the loop and leaves a summary in the banner", () => {
  const open = runMap(baseInfo(), goodDone(), { steps: [0] });
  assert.equal(open.nodes["#app"].inert, true); assert.deepEqual(open.removed, []);
  const r = runMap(baseInfo(), goodDone(), { close: true });
  assert.equal(r.nodes["#app"].inert, false);
  assert.ok(!r.nodes["#map"].classList.s.has("show")); assert.ok(r.nodes["body"].classList.s.has("spent"));
  assert.ok(r.removed.includes("resize") && r.listeners.includes("resize"));
  assert.equal(r.nodes["#banner"].children[0].textContent, "Free space went up by 1.1 KB · 2 not removed · you can leave this page now");
});

const glassLogic = () => {
  const code = /\/\* glass-logic:start \*\/([\s\S]*?)\/\* glass-logic:end \*\//.exec(script)[1];
  const ctx = vm.createContext({ Math, Number });
  vm.runInContext(code + "\nthis.api = { clampGlass, canPress, glassHint, GLASS_MAX, GLASS_PRESS_MIN };", ctx);
  return ctx.api;
};
const deg = d => d * Math.PI / 180;
test("glass logic: clamp 0..110 degrees, junk -> 0", () => {
  const g = glassLogic();
  assert.equal(g.clampGlass(-1), 0); assert.equal(g.clampGlass(NaN), 0); assert.equal(g.clampGlass("x"), 0);
  assert.ok(Math.abs(g.clampGlass(99) - deg(110)) < 1e-9); assert.equal(g.clampGlass(0.5), 0.5);
  assert.ok(g.GLASS_PRESS_MIN >= deg(55) && g.GLASS_PRESS_MIN <= deg(65));
});
test("glass logic: closed glass cannot be pressed; open + unlocked can; lowered again cannot; locked server cannot", () => {
  const g = glassLogic();
  assert.equal(g.canPress("unlocked", 0), false);
  assert.equal(g.canPress("unlocked", deg(30)), false);
  assert.equal(g.canPress("unlocked", deg(60)), false, "threshold is exclusive");
  assert.equal(g.canPress("unlocked", deg(90)), true);
  assert.equal(g.canPress("unlocked", deg(500)), true);
  assert.equal(g.canPress("unlocked", deg(90)) && !g.canPress("unlocked", deg(10)), true, "reopen then close blocks again");
  for (const st of ["locked", "armed", "aborted", "expired", "failed", "unknown", undefined]) assert.equal(g.canPress(st, deg(100)), false, String(st));
});
test("glass logic: hint text mapping", () => {
  const g = glassLogic();
  assert.equal(g.glassHint("locked", "loose", "armed", 0), "Drag the key into the lock");
  assert.equal(g.glassHint("locked", "inserted", "armed", 0), "Hold the key and drag right to turn it");
  assert.match(g.glassHint("unlocked", "turned", "unlocked", 0), /Lift the glass cover/);
  assert.match(g.glassHint("unlocked", "turned", "unlocked", deg(30)), /Lift the glass cover/);
  assert.equal(g.glassHint("unlocked", "turned", "unlocked", deg(100)), "Press the red button");
  assert.equal(g.glassHint("dead", "turned", "failed", 0), "Cleanup ended");
  assert.equal(g.glassHint("pressed", "turned", "unlocked", deg(100)), "");
});
test("key-hole light: flashing yellow waiting for the key, steady green with the key in, steady red once turned", () => {
  assert.match(script, /if \(keyState === 'inserted'\) \{ colour = 0x00ff30; power = 1\.6; \}/);
  assert.match(script, /colour = 0xffc800; power = Math\.sin\(t \* 6\) > 0 \? 1\.8 : 0\.15;/);
  assert.match(script, /\} else \{ colour = 0xff0000; power = 1\.6; \}/);
});
test("the glass is dragged only by trusted pointer events, only after unlock; the press goes through canPress", () => {
  assert.match(script, /mode: 'glass'/);
  assert.match(script, /pointerdown', e => \{\s*if \(!e\.isTrusted/);
  assert.match(script, /stage === 'unlocked' && pick\(e, glassParts\)/);
  assert.match(script, /hinge\.rotation\.x = -glassAngle/);
  assert.match(script, /glassAngle = clampGlass\(/);
  assert.match(script, /put\(\$\('#hint'\), glassHint\(stage, keyState, serverState, glassAngle\)\)/);
  const press = /async function press\(\) \{([\s\S]*?)\n\}\nfunction blast/.exec(script)[1];
  assert.ok(press.indexOf("canPress(serverState, glassAngle)") < press.indexOf("stage = 'pressing'"));
  assert.ok(press.indexOf("canPress(") < press.indexOf("getJson('state')"));
});

test("19B: server text is sanitised before display (control, bidi, zero-width, lone surrogates; length capped; markup stays text)", () => {
  const grab = re => re.exec(script)[0];
  const ctx = vm.createContext({ Array, String });
  vm.runInContext([grab(/const cleanText = .*\n/), grab(/const short = .*\n/), grab(/const cleanPath = .*\n/)].join("\n") + "\nthis.cleanPath = cleanPath; this.short = short;", ctx);
  assert.equal(ctx.cleanPath("C:\\a\u202Eexe.txt\u0000\n\u200Bb\u2028\u2066c\ufeff"), "C:\\aexe.txtbc");
  assert.equal(ctx.cleanPath("a\ud800b\udc00c"), "abc");
  assert.equal(ctx.cleanPath("<b>x</b>"), "<b>x</b>");
  assert.equal(ctx.cleanPath("\u{1F600}".repeat(400)), "\u{1F600}".repeat(300));
  assert.equal(ctx.cleanPath("x".repeat(5e6)).length, 300);
  assert.equal(ctx.cleanPath(null), "");
  assert.equal(ctx.short("a\u202Eb"), "ab");
  // every place a path or reason is drawn goes through them
  assert.doesNotMatch(script, /String\(it\.path\)|String\(x\.it\.path\)|String\(cl\.row\.it\.path\)|String\(x\.it\.coveredBy\)/);
});

test("19B: freed-space wording is neutral about other programs; no 'Freed ' headline", () => {
  assert.match(script, /'Free space went up by ' \+ fmt\(freedBytes\)/);
  assert.match(script, /other programs can change this/);
  assert.doesNotMatch(script, /head = 'Freed '/);
});
