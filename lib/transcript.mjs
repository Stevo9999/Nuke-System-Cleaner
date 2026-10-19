// lib/transcript.mjs
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);
const normKey = (p) => p.replace(/\\/g, "/").toLowerCase();
// Drive letter must not follow a letter/digit, so URL schemes like "https://" are not matched.
const WIN_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|*?\r\n]+/g;
const KEYS = ["file_path", "notebook_path"];

function* parsedLines(jsonlText) {
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    yield obj;
  }
}

// tool_use_id -> { status: "ok" | "error", kind: "create" | "update" | "unknown", filePath }, from tool_result blocks.
// Missing means the call never got a result. Claude Code writes files atomically, so a new birth time proves nothing;
// what separates creating a file from overwriting one is the result record: toolUseResult.type ("create" | "update")
// and the result text ("File created successfully at:" vs "... has been updated successfully"). Anything that does not
// say so unambiguously is "unknown" (fail closed).
function resultText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(x => (x && typeof x.text === "string" ? x.text : "")).join("");
  return "";
}
function toolResults(jsonlText) {
  const res = new Map();
  for (const obj of parsedLines(jsonlText)) {
    const content = obj && obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const text = resultText(b.content);
      const tur = obj.toolUseResult && typeof obj.toolUseResult === "object" && !Array.isArray(obj.toolUseResult) ? obj.toolUseResult : null;
      const textKind = /^File created successfully\b/.test(text) ? "create" : /^The file .* has been updated successfully\b/s.test(text) ? "update" : null;
      let kind;
      if (tur && typeof tur.type === "string") {
        const typeKind = tur.type === "create" ? "create" : tur.type === "update" ? "update" : null;
        kind = typeKind && (textKind === null || textKind === typeKind) ? typeKind : "unknown";
      } else kind = textKind ?? "unknown";
      res.set(b.tool_use_id, { status: b.is_error === true ? "error" : "ok", kind, filePath: tur && typeof tur.filePath === "string" ? tur.filePath : null });
    }
  }
  return res;
}

// Epoch ms of the first line carrying a parseable timestamp (the session start), or null.
export function firstTimestampMs(jsonlText) {
  for (const obj of parsedLines(jsonlText)) {
    const t = obj && typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function* toolUses(jsonlText) {
  for (const obj of parsedLines(jsonlText)) {
    const content = obj && obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === "tool_use" && typeof block.name === "string" && block.input && typeof block.input === "object") yield { obj, block };
    }
  }
}

export function extractCandidates(jsonlText) {
  const found = new Map();
  const results = toolResults(jsonlText);
  const add = (p, tool, viaBash, id) => {
    if (typeof p !== "string" || !p) return;
    const key = normKey(p);
    const e = found.get(key) || { path: p, tools: new Set(), writes: false, fromBash: true, created: false, edited: false, firstWrite: null };
    // Proof of creation: the FIRST successful write to this path must be a Write whose result says "create" (and names
    // this path). Overwriting an existing file (type "update"), an Edit first, or any unclear result is never proof.
    if (!viaBash && (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit")) {
      const r = typeof id === "string" ? results.get(id) : undefined;
      if (r && r.status === "ok") {
        const named = r.filePath === null || normKey(r.filePath) === key;
        const isCreate = tool === "Write" && r.kind === "create" && named;
        if (e.firstWrite === null) e.firstWrite = isCreate ? "create" : "other";
        e.created = e.firstWrite === "create";
        if (!isCreate && !(tool === "Write" && (r.kind === "unknown" || !named))) e.edited = true; // known overwrite or Edit-type
      }
    }
    e.tools.add(tool);
    if (WRITE_TOOLS.has(tool)) e.writes = true;
    if (!viaBash) { if (e.fromBash) e.path = p; e.fromBash = false; }
    found.set(key, e);
  };
  for (const { block } of toolUses(jsonlText)) {
    for (const k of KEYS) add(block.input[k], block.name, false, block.id);
    if (block.name === "Bash" && typeof block.input.command === "string") {
      const cmd = block.input.command;
      for (const m of cmd.matchAll(WIN_PATH)) {
        const next = cmd[m.index + m[0].length];
        if (next === "*" || next === "?") continue; // wildcard: match is only a directory prefix
        if (/[\\/]$/.test(m[0])) continue; // directory-looking
        add(m[0], "Bash", true);
      }
    }
  }
  return [...found.values()].map(e => ({ ...e, tools: [...e.tools] }));
}

export function extractCwds(jsonlText) {
  const out = new Set();
  for (const { obj } of toolUses(jsonlText)) if (typeof obj.cwd === "string") out.add(obj.cwd);
  return [...out];
}

export function extractOffDisk(jsonlText) {
  const out = [];
  for (const { block } of toolUses(jsonlText)) {
    if (block.name !== "Artifact") continue;
    const str = (v) => (typeof v === "string" ? v : "");
    const note = str(block.input.url) || str(block.input.file_path);
    if (note) out.push({ kind: "artifact", note });
  }
  return out;
}
