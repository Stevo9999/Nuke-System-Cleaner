// app/main/ipc.mjs
// IPC channel allowlist, argument validation, sender trust, and handler registration. Pure; no electron import.
import { isToolKey } from "../../lib/wintools.mjs";
export const CHANNELS = Object.freeze([
  "nuke:settings:get", "nuke:settings:set", "nuke:status:get", "nuke:scan:smart", "nuke:scan:startup", "nuke:scan:browsers", "nuke:exclusions:add", "nuke:exclusions:remove", "nuke:programs:list", "nuke:programs:uninstall", "nuke:apps:list", "nuke:apps:remove", "nuke:tools:list", "nuke:tools:open", "nuke:scan:investigate",
  "nuke:scan:folder", "nuke:scan:again", "nuke:scan:cancel", "nuke:results:get", "nuke:delete",
  "nuke:results:close", "nuke:admin:relaunch", "nuke:ritual:cancel", "nuke:ritual:close", "nuke:question:answer",
]);
export const EVENTS = Object.freeze(["nuke:progress", "nuke:phase", "nuke:question"]);

const ID_ONLY = new Set(["nuke:programs:uninstall", "nuke:apps:remove", "nuke:exclusions:remove"]);
const NO_ARGS = new Set(CHANNELS.filter(c => c !== "nuke:settings:set" && c !== "nuke:delete" && c !== "nuke:question:answer" && c !== "nuke:tools:open" && !ID_ONLY.has(c)));
const ID_RE = /^[0-9a-f]{16}$/;
const MAX_IDS = 5000;
const REFUSED = { ok: false };

const isPlainObject = o => o !== null && typeof o === "object" && !Array.isArray(o) &&
  (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);

// Own data property (no getters/proxies surprises): returns the descriptor value or undefined.
function ownData(o, key) {
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d && Object.hasOwn(d, "value") ? d.value : undefined;
}
const onlyKeys = (o, keys) => {
  const own = Reflect.ownKeys(o);
  return own.length === keys.length && keys.every(k => own.includes(k));
};

export function validateArgs(channel, args) {
  try {
    if (typeof channel !== "string" || !Array.isArray(args)) return REFUSED;
    if (NO_ARGS.has(channel)) return args.length === 0 ? { ok: true, value: undefined } : REFUSED;
    if (args.length !== 1) return REFUSED;
    const a = args[0];
    if (!isPlainObject(a)) return REFUSED;
    if (channel === "nuke:settings:set") {
      if (!onlyKeys(a, ["restorePoint", "plainConfirm"])) return REFUSED;
      const v = ownData(a, "restorePoint"), p = ownData(a, "plainConfirm");
      return typeof v === "boolean" && typeof p === "boolean" ? { ok: true, value: { restorePoint: v, plainConfirm: p } } : REFUSED;
    }
    if (channel === "nuke:tools:open") {
      if (!onlyKeys(a, ["tool"])) return REFUSED;
      const v = ownData(a, "tool");
      return isToolKey(v) ? { ok: true, value: { tool: v } } : REFUSED;
    }
    if (channel === "nuke:question:answer") {
      if (!onlyKeys(a, ["answer"])) return REFUSED;
      const v = ownData(a, "answer");
      return typeof v === "boolean" ? { ok: true, value: { answer: v } } : REFUSED;
    }
    if (ID_ONLY.has(channel)) {
      if (!onlyKeys(a, ["id"])) return REFUSED;
      const v = ownData(a, "id");
      return typeof v === "string" && ID_RE.test(v) ? { ok: true, value: { id: v } } : REFUSED;
    }
    if (channel === "nuke:delete") {
      if (!onlyKeys(a, ["ids"])) return REFUSED;
      const ids = ownData(a, "ids");
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS) return REFUSED;
      const out = [];
      const seen = new Set();
      for (let i = 0; i < ids.length; i++) {
        const id = Object.hasOwn(ids, i) ? ownData(ids, String(i)) : undefined;
        if (typeof id !== "string" || !ID_RE.test(id) || seen.has(id)) return REFUSED;
        seen.add(id);
        out.push(id);
      }
      return { ok: true, value: { ids: out } };
    }
    return REFUSED;
  } catch { return REFUSED; }
}

export function trustedSender(event, allowedIds) {
  try {
    if (!event || !(allowedIds instanceof Set)) return false;
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null) return false; // top frame only (undefined parent is also refused)
    if (typeof frame.url !== "string" || !frame.url.startsWith("app://ui/")) return false;
    const id = event.sender && event.sender.id;
    return typeof id === "number" && allowedIds.has(id);
  } catch { return false; }
}

const methodOf = channel => channel.slice("nuke:".length).split(":").map((p, i) => i === 0 ? p : p[0].toUpperCase() + p.slice(1)).join(""); // settings:get -> settingsGet, delete -> delete, results:close -> resultsClose

// Channels only the main window's own renderer may use (not the embedded results page).
export const MAIN_ONLY = Object.freeze(["nuke:ritual:cancel", "nuke:ritual:close", "nuke:question:answer", "nuke:tools:list", "nuke:tools:open", "nuke:exclusions:add", "nuke:exclusions:remove"]);

// isMain(event): true only for the main window's webContents. Without it, MAIN_ONLY channels are refused (fail closed).
export function registerIpc(ipcMain, controller, isTrusted, isMain) {
  for (const channel of CHANNELS) {
    const method = methodOf(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      let trusted = false;
      try { trusted = isTrusted(event) === true; } catch { trusted = false; }
      if (trusted && MAIN_ONLY.includes(channel)) {
        try { trusted = typeof isMain === "function" && isMain(event) === true; } catch { trusted = false; }
      }
      if (!trusted) throw new Error("refused");
      const v = validateArgs(channel, args);
      if (!v.ok) throw new Error("refused");
      const fn = controller && Object.hasOwn(controller, method) ? controller[method] : undefined;
      if (typeof fn !== "function") throw new Error("refused");
      return v.value === undefined ? fn.call(controller) : fn.call(controller, v.value);
    });
  }
}
