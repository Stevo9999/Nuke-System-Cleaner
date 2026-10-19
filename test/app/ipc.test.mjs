import test from "node:test";
import assert from "node:assert/strict";
import { CHANNELS, EVENTS, validateArgs, trustedSender, registerIpc } from "../../app/main/ipc.mjs";

const ID = "0123456789abcdef";
const NOARG = ["nuke:settings:get", "nuke:status:get", "nuke:scan:smart", "nuke:scan:startup", "nuke:scan:browsers", "nuke:exclusions:add", "nuke:programs:list", "nuke:apps:list", "nuke:scan:investigate", "nuke:scan:folder",
  "nuke:scan:again", "nuke:scan:cancel", "nuke:results:get", "nuke:results:close", "nuke:admin:relaunch", "nuke:ritual:cancel", "nuke:ritual:close", "nuke:tools:list"];

test("CHANNELS and EVENTS are exactly the specified lists", () => {
  const ID_CH = ["nuke:programs:uninstall", "nuke:apps:remove", "nuke:exclusions:remove"];
  assert.deepEqual([...CHANNELS].sort(), [...NOARG, ...ID_CH, "nuke:settings:set", "nuke:delete", "nuke:question:answer", "nuke:tools:open"].sort());
  assert.deepEqual([...EVENTS].sort(), ["nuke:phase", "nuke:progress", "nuke:question"]);
  assert.ok(Object.isFrozen(CHANNELS) && Object.isFrozen(EVENTS));
});

test("validateArgs: delete ids shape (bad hex, 17 chars, duplicates, 5001 ids, extra keys, arrays as objects) refused", () => {
  const ok = validateArgs("nuke:delete", [{ ids: [ID, "fedcba9876543210"] }]);
  assert.deepEqual(ok, { ok: true, value: { ids: [ID, "fedcba9876543210"] } });
  const many = n => Array.from({ length: n }, (_, i) => i.toString(16).padStart(16, "0"));
  assert.equal(validateArgs("nuke:delete", [{ ids: many(5000) }]).ok, true);
  const sparse = [ID]; sparse[2] = "1123456789abcdef";
  const proto = Object.create({ ids: [ID] });
  const withGetter = { get ids() { return [ID]; } };
  const bads = [
    [], [{}], [{ ids: [] }], [{ ids: many(5001) }], [{ ids: [ID, ID] }], [{ ids: ["0123456789ABCDEF"] }],
    [{ ids: ["0123456789abcdeg"] }], [{ ids: [ID + "0"] }], [{ ids: [ID.slice(1)] }], [{ ids: [ID + "\n"] }],
    [{ ids: [ID], extra: 1 }], [{ ids: ID }], [{ ids: [1] }], [{ ids: [null] }], [{ ids: { 0: ID, length: 1 } }],
    [{ ids: sparse }], [[ID]], [[{ ids: [ID] }]], [null], [undefined], ["x"], [{ ids: [ID] }, 1], [{ ids: [ID] }, {}],
    [proto], [withGetter], [new Map()], [Object.assign(Object.create(null), { ids: [ID], z: 1 })],
    [{ ids: [{ toString: () => ID }] }], [{ ids: [["0123456789abcdef"]] }],
  ];
  for (const a of bads) assert.equal(validateArgs("nuke:delete", a).ok, false, JSON.stringify(a));
  assert.equal(validateArgs("nuke:delete", "notarray").ok, false);
  assert.equal(validateArgs("nuke:delete", null).ok, false);
  const input = { ids: [ID] };
  const res = validateArgs("nuke:delete", [input]);
  assert.notEqual(res.value, input);
  assert.notEqual(res.value.ids, input.ids);
});

test("validateArgs: settings:set only {restorePoint:boolean, plainConfirm:boolean}; no-arg channels refuse any argument", () => {
  assert.deepEqual(validateArgs("nuke:settings:set", [{ restorePoint: false, plainConfirm: true }]), { ok: true, value: { restorePoint: false, plainConfirm: true } });
  assert.deepEqual(validateArgs("nuke:settings:set", [{ restorePoint: true, plainConfirm: false }]), { ok: true, value: { restorePoint: true, plainConfirm: false } });
  const bads = [[], [{}], [{ restorePoint: "true", plainConfirm: false }], [{ restorePoint: 1, plainConfirm: false }], [{ restorePoint: null, plainConfirm: false }], [{ restorePoint: true, plainConfirm: false, x: 1 }],
    [{ restorePoint: true }], [{ plainConfirm: true }], [{ restorePoint: true, plainConfirm: "yes" }], [{ restorePoint: true, plainConfirm: 0 }], [{ restorePoint: true, plainConfirm: null }],
    [{ restorePoint: true, plainConfirm: false }, 1], [[true]], [true], [null], [Object.create({ restorePoint: true, plainConfirm: false })], [{ get restorePoint() { return true; }, plainConfirm: false }],
    [{ restorePoint: true, get plainConfirm() { return false; } }],
    [{ path: "C:\\Windows" }]];
  for (const a of bads) assert.equal(validateArgs("nuke:settings:set", a).ok, false, JSON.stringify(a));
  for (const ch of NOARG) {
    assert.deepEqual(validateArgs(ch, []), { ok: true, value: undefined }, ch);
    for (const a of [[undefined], [null], [{}], ["C:\\Windows"], [1], [[]]]) assert.equal(validateArgs(ch, a).ok, false, ch);
  }
  assert.equal(validateArgs("nuke:unknown", []).ok, false);
  assert.equal(validateArgs("__proto__", []).ok, false);
  assert.equal(validateArgs("toString", []).ok, false);
  assert.equal(validateArgs(undefined, []).ok, false);
});

const frame = (url, parent = null) => ({ url, parent });
test("trustedSender: subframe, file://, http:// and unknown sender ids refused", () => {
  const ids = new Set([3]);
  const mk = (f, id = 3) => ({ senderFrame: f, sender: { id } });
  assert.equal(trustedSender(mk(frame("app://ui/index.html")), ids), true);
  assert.equal(trustedSender(mk(frame("app://ui/results.html")), ids), true);
  assert.equal(trustedSender(mk(frame("app://ui/index.html", frame("app://ui/index.html"))), ids), false, "subframe");
  assert.equal(trustedSender(mk(frame("file:///C:/x/index.html")), ids), false);
  assert.equal(trustedSender(mk(frame("http://ui/index.html")), ids), false);
  assert.equal(trustedSender(mk(frame("https://evil.example/")), ids), false);
  assert.equal(trustedSender(mk(frame("app://ui.evil/index.html")), ids), false);
  assert.equal(trustedSender(mk(frame("app://other/index.html")), ids), false);
  assert.equal(trustedSender(mk(frame("app://ui/index.html"), 4), ids), false, "unknown id");
  assert.equal(trustedSender(mk(frame("app://ui/index.html"), "3"), ids), false, "id type");
  assert.equal(trustedSender(mk(frame("app://ui/index.html"), 3), new Set()), false);
  assert.equal(trustedSender({ sender: { id: 3 } }, ids), false, "no frame");
  assert.equal(trustedSender({ senderFrame: null, sender: { id: 3 } }, ids), false);
  assert.equal(trustedSender({ senderFrame: frame("app://ui/index.html") }, ids), false, "no sender");
  assert.equal(trustedSender(null, ids), false);
  assert.equal(trustedSender(undefined, ids), false);
  assert.equal(trustedSender(mk(frame(42)), ids), false);
  const throwing = { get senderFrame() { throw new Error("disposed"); }, sender: { id: 3 } };
  assert.equal(trustedSender(throwing, ids), false);
});

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle(ch, fn) { assert.ok(!handlers.has(ch), "double register " + ch); handlers.set(ch, fn); } };
}
const METHODS = { "nuke:settings:get": "settingsGet", "nuke:settings:set": "settingsSet", "nuke:status:get": "statusGet",
  "nuke:scan:smart": "scanSmart", "nuke:scan:startup": "scanStartup", "nuke:scan:investigate": "scanInvestigate", "nuke:scan:folder": "scanFolder",
  "nuke:scan:again": "scanAgain", "nuke:scan:cancel": "scanCancel", "nuke:results:get": "resultsGet",
  "nuke:delete": "delete", "nuke:results:close": "resultsClose", "nuke:admin:relaunch": "adminRelaunch" };

test("registerIpc: one handle per channel, camel-cased controller method, untrusted or invalid refused", async () => {
  const ipc = fakeIpc();
  const calls = [];
  const controller = {};
  for (const m of Object.values(METHODS)) controller[m] = async (...a) => { calls.push([m, a]); return m + ":ok"; };
  let trusted = true;
  registerIpc(ipc, controller, () => trusted);
  assert.deepEqual([...ipc.handlers.keys()].sort(), [...CHANNELS].sort());
  for (const [ch, m] of Object.entries(METHODS)) {
    const args = ch === "nuke:settings:set" ? [{ restorePoint: true, plainConfirm: false }] : ch === "nuke:delete" ? [{ ids: [ID] }] : [];
    assert.equal(await ipc.handlers.get(ch)({}, ...args), m + ":ok");
  }
  assert.deepEqual(calls.find(c => c[0] === "scanSmart")[1], []);
  assert.deepEqual(calls.find(c => c[0] === "delete")[1], [{ ids: [ID] }]);
  const before = calls.length;
  await assert.rejects(ipc.handlers.get("nuke:delete")({}, { ids: ["zz"] }), e => e.message === "refused");
  await assert.rejects(ipc.handlers.get("nuke:scan:smart")({}, "C:\\Windows"), e => e.message === "refused");
  trusted = false;
  await assert.rejects(ipc.handlers.get("nuke:settings:get")({}), e => e.message === "refused");
  assert.equal(calls.length, before, "controller never called when refused");
  const missing = fakeIpc();
  registerIpc(missing, {}, () => true);
  await assert.rejects(missing.handlers.get("nuke:settings:get")({}), e => e.message === "refused");
  const throwingTrust = fakeIpc();
  registerIpc(throwingTrust, controller, () => { throw new Error("x"); });
  await assert.rejects(throwingTrust.handlers.get("nuke:settings:get")({}), e => e.message === "refused");
});
