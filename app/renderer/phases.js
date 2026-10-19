// Pure phase -> text mapping for the main window. `detail` is already sanitised by the main process.
export const PHASES = ["idle", "scanning", "results", "warning", "restore", "ritual", "done", "error"];

function clean(detail) {
  return typeof detail === "string" ? detail.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, " ").trim().slice(0, 600) : "";
}

export function phaseText(phase, detail) {
  switch (phase) {
    case "idle": return "Ready";
    case "scanning": return "Scanning…";
    // results / restore: the main process sends what really happened (e.g. nothing found; the restore point outcome).
    case "results": return clean(detail) || "Scan finished.";
    case "warning": return "Review the warning before anything is deleted";
    case "restore": return clean(detail) || "Windows is creating a system restore point";
    case "ritual": return "The final confirmation is below: turn the key, lift the glass cover and press the red button";
    case "done": return clean(detail) || "Finished";
    case "error": return clean(detail) || "Something went wrong";
    default: return "Working…";
  }
}
