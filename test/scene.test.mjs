// test/scene.test.mjs - source scan of cleanup.html (scene: room, small table, ceiling spotlight, camera pulled back)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(here, "..", "cleanup.html"), "utf8");
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(src)[1];
const vec = name => {
  const m = new RegExp(name + "\\s*=\\s*new THREE\\.Vector3\\(\\s*(-?[\\d.]+)\\s*,\\s*(-?[\\d.]+)\\s*,\\s*(-?[\\d.]+)\\s*\\)").exec(script);
  assert.ok(m, name + " literal not found");
  return m.slice(1, 4).map(Number);
};
const lum = hex => {
  const c = [16, 8, 0].map(s => ((hex >> s) & 255) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

test("camera is pulled back: |CAM0 - LOOK| >= 30 (was ~17)", () => {
  const a = vec("CAM0"), b = vec("LOOK");
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) >= 30);
});
test("room and small table exist and the device sits on the table", () => {
  assert.match(script, /const room = new THREE\.Group\(\)/);
  assert.match(script, /const table = new THREE\.Group\(\)/);
  assert.match(script, /TABLE_TOP_Y = 0\b/);
  assert.match(script, /const BASE_Y = 1\.6, PLATE_TOP = 3\.1;/);   // device geometry unchanged
});
test("well lit: light background, hemisphere >= 0.9, spot casts shadow and targets the cap", () => {
  const bg = /scene\.background = new THREE\.Color\(0x([0-9a-fA-F]{6})\)/.exec(script);
  assert.ok(bg); assert.ok(lum(parseInt(bg[1], 16)) >= 0.35);
  const h = /new THREE\.HemisphereLight\([^,]+,[^,]+,\s*([\d.]+)\)/.exec(script);
  assert.ok(h && Number(h[1]) >= 0.9);
  assert.match(script, /ceilingLight/);
  assert.match(script, /spot\.castShadow = true/);
  assert.match(script, /spot\.target\.position\.copy\(capWorld\)/);
  assert.match(script, /const capWorld/);
});
test("#dim outer opacity <= 0.35 and still no url()/external assets", () => {
  const dim = /#dim \{[^}]*\}/.exec(src)[0];
  const alphas = [...dim.matchAll(/rgba\(0,0,0,\s*(\.?[\d.]+)\)/g)].map(m => Number(m[1]));
  assert.ok(alphas.length >= 3 && Math.max(...alphas) <= 0.35);
  assert.doesNotMatch(src, /url\(/i);
});

// ---- fix round 1 ----
test("lights are actually added to the scene with non-zero intensity", () => {
  assert.match(script, /scene\.add\(new THREE\.HemisphereLight\([^)]*,\s*1\.\d+\)\)/);
  assert.match(script, /ceilingLight = new THREE\.PointLight\(0x[0-9a-f]{6},\s*[1-9]\d*,/i);
  assert.match(script, /scene\.add\(ceilingLight\)/);
  assert.match(script, /new THREE\.SpotLight\(0x[0-9a-f]{6},\s*[1-9]\d*,/i);
  assert.match(script, /scene\.add\(spot,\s*spot\.target\)/);
});
test("room and table get children (planes, top, legs)", () => {
  assert.ok((script.match(/room\.add\(/g) || []).length >= 1 && (script.match(/\bplane\(/g) || []).length >= 5);
  assert.ok((script.match(/table\.add\(/g) || []).length >= 2);
});
test("cap bounce uses real surfaces (TABLE_TOP_Y / FLOOR_Y), not the old magic floor; the glass has no free-fall", () => {
  assert.doesNotMatch(script, /cap\.position\.y < 2 && cap\.position\.x > 9\.5/);
  assert.doesNotMatch(script, /hinge\.position\.y/);
  assert.match(script, /function surfaceY\(/);
  const fn = /function surfaceY\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(script)[1];
  assert.match(fn, /TABLE_TOP_Y/); assert.match(fn, /FLOOR_Y/);
  const frameSrc = script.slice(script.indexOf("function frame("));
  assert.match(frameSrc, /surfaceY\(cap\.position\.x, cap\.position\.z\)/);
});
test("slide-in moves table and underGlow with the device", () => {
  assert.match(script, /table\.position\.x = device\.position\.x/);
  assert.match(script, /underGlow\.position\.x = device\.position\.x/);
});
test("key has an invisible oversized pick proxy and pointerdown keeps the isTrusted check", () => {
  assert.match(script, /const keyProxy = new THREE\.Mesh\(new THREE\.BoxGeometry\(/);
  assert.match(script, /visible:\s*false/);
  assert.match(script, /key\.add\(keyProxy\)/);
  assert.match(script, /pointerdown', e => \{\s*if \(!e\.isTrusted/);
});
test("#dim hole sits near 40% viewport height", () => {
  assert.match(/#dim \{[^}]*\}/.exec(src)[0], /at 50% 4\d%/);
});
test("the key snaps off in the lock after it has turned: stub stays, upper part flies off and lands (user request)", () => {
  // the break is triggered from enterUnlocked (i.e. only after the server said unlocked and the key was turned)
  const unlocked = /function enterUnlocked\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.match(unlocked, /snapKey\(\)/);
  assert.match(unlocked, /if \(stage !== 'locked'\) return;/, "snaps at most once, only from the locked stage");
  const snap = /function snapKey\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  assert.match(snap, /keyBreak\.snapped/);
  assert.match(snap, /key\.remove\(keyBow\)/, "the bow leaves the key group");
  assert.match(snap, /keyShaft\.scale\.y = KEY_STUB_H/, "a short stub stays in the lock");
  assert.match(snap, /device\.add\(piece\)/, "the broken piece is a loose object");
  // it falls under gravity and comes to rest on the plate or the table, never forever
  assert.match(src, /keyBreak\.vel\.y -= 60 \* dt/);
  assert.match(src, /keyBreak\.moving = false/);
  assert.match(src, /KEY_STUB_H = 0\.4/);
});

// ---- the computer that gets blown up (user request) ----
const pcBlock = script.slice(script.indexOf("/* ================= the computer that gets blown up"), script.indexOf("/* ================= press, blast"));
test("a low-poly computer (monitor, tower, keyboard) stands on a small desk in the room, built from primitives only", () => {
  assert.ok(pcBlock.length > 2000);
  for (const part of ["monitor shell", "tower", "keyboard", "mouse"]) assert.match(pcBlock, new RegExp(part));
  assert.match(pcBlock, /scene\.add\(pc\.group\)/);
  assert.doesNotMatch(pcBlock, /GLTFLoader|OBJLoader|TextureLoader|new Image|\.load\(/, "no external models or textures");
  const pos = /PC_POS = new THREE\.Vector3\((-?[\d.]+),\s*PC_FLOOR,\s*(-?[\d.]+)\)/.exec(pcBlock);
  assert.ok(pos && Math.abs(Number(pos[1])) <= 24 && Number(pos[2]) > -30, "inside the room, near the default view");
});
test("the explosion is purely visual: it starts only after the server accepted the confirm and never touches server, lock, gating or countdown", () => {
  const pressSrc = /async function press\(\) \{[\s\S]*?\n\}/.exec(script)[0];
  assert.ok(pressSrc.indexOf("pcStart()") > pressSrc.indexOf("postApi('confirm')"), "after the confirm call");
  assert.ok(pressSrc.indexOf("pcStart()") > pressSrc.indexOf("stage = 'pressed'"), "only in the pressed stage");
  assert.equal([...script.matchAll(/^\s*pcStart\(\);/gm)].length, 1, "exactly one call, inside press()");
  assert.doesNotMatch(pcBlock, /postApi|getJson|fetch\(|EventSource|serverState|doUnlock|enterUnlocked|canPress|deadline|stage\s*=[^=]|keyState|glassAngle|doneEvent|blastDone/);
  assert.match(script, /pcUpdate\(dt\);/);
});
test("the sequence: red warning screen, flash, shockwave rings, pieces with gravity and spin, mushroom smoke, blast sound via sfx", () => {
  assert.match(pcBlock, /FATAL ERROR/);
  assert.match(pcBlock, /PointLight\(0xffa040/);
  assert.match(pcBlock, /RingGeometry/);
  assert.match(pcBlock, /f\.vel\.y -= 60 \* dt/);
  assert.match(pcBlock, /f\.spin/);
  assert.match(pcBlock, /stem: \[\]/); assert.match(pcBlock, /cap: \[\]/);
  assert.match(pcBlock, /sfx\('blast', 0\.7\)/, "the existing blast sound through the existing helper");
  assert.ok(!/new Audio/.test(pcBlock));
});
test("reduced motion: flash only, no debris physics, rings or smoke; everything made for the effect is disposed afterwards", () => {
  assert.match(pcBlock, /prefers-reduced-motion: reduce/);
  const boom = /function pcBoom\(\) \{[\s\S]*?\n\}/.exec(pcBlock)[0];
  const r = boom.indexOf("if (pc.reduced)");
  assert.ok(r > 0 && r < boom.indexOf("RingGeometry") && r < boom.indexOf("SphereGeometry") && r < boom.indexOf("pc.flying.push"));
  assert.match(boom, /if \(pc\.reduced\) \{[^}]*return;/);
  const disp = /function pcDispose\(\) \{[\s\S]*?\n\}/.exec(pcBlock)[0];
  assert.match(disp, /scene\.remove\(o\)/); assert.match(disp, /d\.dispose\(\)/);
  assert.match(pcBlock, /if \(u > 5\.2\) pcDispose\(\)/, "ends before the existing blast at 7 s");
  assert.match(script, /setTimeout\(blast, 7000\)/, "the existing blast flow is unchanged");
});
test("the 3D scene stops rendering once the opaque result map is showing", () => {
  assert.match(script, /if \(!mapShown\) renderer\.render\(scene, camera\)/);
});
