// lib/squarify.mjs  (standard squarified treemap). Pure: no I/O. cleanup.html carries an identical inlined copy (tested).
export function squarify(items, x, y, w, h) {
  if (!items.length) return [];
  const total = items.reduce((s, i) => s + i.value, 0);
  const scale = (w * h) / total;
  const out = [];
  let rest = items.map(item => ({ item, a: item.value * scale }));
  const worst = (row, side) => {
    const s = row.reduce((t, r) => t + r.a, 0);
    const mx = Math.max(...row.map(r => r.a)), mn = Math.min(...row.map(r => r.a));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (rest.length) {
    const side = Math.min(w, h);
    const row = [rest[0]];
    let k = 1;
    while (k < rest.length && worst([...row, rest[k]], side) <= worst(row, side)) { row.push(rest[k]); k++; }
    const s = row.reduce((t, r) => t + r.a, 0);
    if (w >= h) {
      const rw = s / h; let cy = y;
      for (const r of row) { const rh = r.a / rw; out.push({ item: r.item, x, y: cy, w: rw, h: rh }); cy += rh; }
      x += rw; w -= rw;
    } else {
      const rh = s / w; let cx = x;
      for (const r of row) { const rw = r.a / rh; out.push({ item: r.item, x: cx, y, w: rw, h: rh }); cx += rw; }
      y += rh; h -= rh;
    }
    rest = rest.slice(k);
  }
  return out;
}
