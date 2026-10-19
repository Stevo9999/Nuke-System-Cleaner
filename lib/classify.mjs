export function classify(input) {
  const { safe, isLive, sharedWith } = input || {};
  if (isLive === true) return { group: "live", reason: "this session is still running" };
  if (typeof isLive !== "boolean") return { group: "protected", reason: "unknown liveness" };
  if (!safe || typeof safe.ok !== "boolean") return { group: "protected", reason: "unknown" };
  if (!safe.ok) return { group: "protected", reason: String(safe.reason || "unsafe") };
  if (!Array.isArray(sharedWith)) return { group: "protected", reason: "unknown ties" };
  if (!sharedWith.every((x) => typeof x === "string" && x.length > 0)) return { group: "protected", reason: "unknown ties" };
  if (sharedWith.length > 0) return { group: "shared", reason: `also used by ${sharedWith.join(", ")}` };
  return { group: "exclusive", reason: "only this session touched it" };
}
