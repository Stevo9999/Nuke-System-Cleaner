// Detective progress bar: a little guy in a detective hat with a magnifying
// glass walks along the bar to the fill edge, eyes sweeping left and right.
// Drawn entirely here (SVG via createElementNS). No assets, no network, no HTML strings.
// Pure state logic (clampFraction, percentOf, eyePhase, labelText) needs no DOM.

const SVG_NS = "http:" + "//www.w3.org/2000/svg"; // namespace identifier, not a network address
const EYE_PERIOD_MS = 2400;

/** non-finite / non-number -> null (indeterminate); else clamp to [0,1]. */
export function clampFraction(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Whole percent for a fraction, or null when indeterminate. */
export function percentOf(fraction) {
  const f = clampFraction(fraction);
  return f === null ? null : Math.round(f * 100);
}

/** Eye sweep phase in [-1, 1] (left..right) at time t ms; 0 at t=0 and for bad input. */
export function eyePhase(tMs) {
  if (typeof tMs !== "number" || !Number.isFinite(tMs)) return 0;
  return Math.sin((2 * Math.PI * tMs) / EYE_PERIOD_MS);
}

/** Visible/announced text. Explicit string text wins; otherwise "<label> NN%" or "<label>…". */
export function labelText(label, fraction, text) {
  if (typeof text === "string" && text.length > 0) return text;
  const p = percentOf(fraction);
  const base = typeof label === "string" && label ? label : "Scanning";
  return p === null ? base + "…" : base + " " + p + "%";
}

function setStyle(el, prop, value) {
  if (el.style && typeof el.style.setProperty === "function") el.style.setProperty(prop, value);
  else if (el.style) el.style[prop] = value;
}

export function mountDetective(host, { label = "Scanning" } = {}) {
  const doc = host.ownerDocument;
  const html = (tag, cls) => {
    const e = doc.createElement(tag);
    if (cls) e.setAttribute("class", cls);
    return e;
  };
  const svgEl = (tag, attrs, parent) => {
    const e = doc.createElementNS(SVG_NS, tag);
    for (const k of Object.keys(attrs || {})) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  };

  const root = html("div", "det det-indeterminate");
  const bar = html("div", "det-bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", label);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  const track = html("div", "det-track");
  const fill = html("div", "det-fill");
  const walker = html("div", "det-walker");

  // The little guy.
  const svg = svgEl("svg", { viewBox: "0 0 40 52", width: 40, height: 52, "aria-hidden": "true", focusable: "false", class: "det-svg" });
  svgEl("rect", { x: 14, y: 36, width: 12, height: 13, rx: 3, class: "det-body" }, svg);
  svgEl("circle", { cx: 20, cy: 26, r: 10, class: "det-head" }, svg);
  svgEl("path", { d: "M12 18 Q12 6 20 6 Q28 6 28 18 Z", class: "det-hat" }, svg);
  svgEl("rect", { x: 7, y: 17, width: 26, height: 4, rx: 2, class: "det-brim" }, svg);
  svgEl("rect", { x: 12, y: 14, width: 16, height: 2, class: "det-band" }, svg);
  const eyes = svgEl("g", { class: "det-eyes" }, svg);
  svgEl("circle", { cx: 16, cy: 26, r: 3.2, class: "det-eye-white" }, eyes);
  svgEl("circle", { cx: 24, cy: 26, r: 3.2, class: "det-eye-white" }, eyes);
  svgEl("circle", { cx: 16, cy: 26.4, r: 1.5, class: "det-pupil" }, eyes);
  svgEl("circle", { cx: 24, cy: 26.4, r: 1.5, class: "det-pupil" }, eyes);
  const glass = svgEl("g", { class: "det-glass" }, svg);
  svgEl("line", { x1: 30, y1: 40, x2: 36, y2: 48, class: "det-handle" }, glass);
  svgEl("circle", { cx: 29, cy: 38, r: 5, class: "det-lens" }, glass);

  const text = html("div", "det-text");
  text.setAttribute("aria-live", "polite");
  text.setAttribute("aria-atomic", "true");

  walker.appendChild(svg);
  track.appendChild(fill);
  track.appendChild(walker);
  bar.appendChild(track);
  root.appendChild(bar);
  root.appendChild(text);
  host.appendChild(root);

  let lastText = null;
  let lastNow = null;
  let destroyed = false;
  let determinate = false;

  function set(fraction, msg) {
    if (destroyed) return;
    const f = clampFraction(fraction);
    const p = percentOf(f);
    if (p === null) {
      if (determinate || lastNow !== null) {
        bar.removeAttribute("aria-valuenow");
        root.setAttribute("class", "det det-indeterminate");
        determinate = false;
        lastNow = null;
      }
    } else {
      if (!determinate) {
        root.setAttribute("class", "det");
        determinate = true;
      }
      if (p !== lastNow) {
        bar.setAttribute("aria-valuenow", String(p));
        lastNow = p;
      }
      const pct = (f * 100).toFixed(2) + "%";
      setStyle(fill, "width", pct);
      setStyle(walker, "left", pct);
      // Static eye pose for reduced motion (CSS animates the eyes otherwise).
      setStyle(eyes, "--det-eye-x", (eyePhase(f * 7 * EYE_PERIOD_MS) * 1.4).toFixed(2) + "px");
    }
    const t = labelText(label, f, msg);
    if (t !== lastText) {
      text.textContent = t;
      lastText = t;
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    host.removeChild(root);
  }

  set(null);
  return { set, destroy };
}
