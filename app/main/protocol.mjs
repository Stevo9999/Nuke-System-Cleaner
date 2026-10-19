// app/main/protocol.mjs
// Pure helpers for the app://ui/ protocol: exact file allowlist, CSP, and URL resolution. No electron import.
export const UI_FILES = Object.freeze(new Set([
  "index.html", "main.js", "main.css", "phases.js", "credits.js", "detective.js", "detective.css", "results.html", "results.js", "results.css",
]));

export const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };

// Only `app://ui/<name>` with <name> in the allowlist. Anything else (query, fragment, percent-escapes,
// separators, dots, userinfo, port, case variants, other hosts) fails the strict pattern and returns null.
const URL_RE = /^app:\/\/ui\/([a-z]+\.(?:html|js|css))$/;

export function resolveUi(url, uiDir) {
  if (typeof url !== "string" || typeof uiDir !== "string" || uiDir.length === 0) return null;
  const m = URL_RE.exec(url);
  if (!m || !UI_FILES.has(m[1])) return null;
  const name = m[1];
  const sep = uiDir.endsWith("\\") || uiDir.endsWith("/") ? "" : "\\";
  return { file: uiDir + sep + name, type: TYPES[name.slice(name.lastIndexOf(".") + 1)] };
}
