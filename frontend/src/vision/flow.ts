import type { P2 } from "./geometry";

/* Sparse optical flow (pyramidal Lucas-Kanade) on real camera frames. Used only for the drifting visual-tracking fallback. */
export interface Gray { w: number; h: number; d: Uint8ClampedArray | Float32Array }

export function toGray(img: ImageData): Gray {
  const { width: w, height: h, data } = img, d = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return { w, h, d };
}
export function pyramid(g: Gray, levels: number): Gray[] {
  const out = [g];
  for (let l = 1; l < levels; l++) {
    const p = out[l - 1], w = p.w >> 1, h = p.h >> 1, d = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = 2 * y * p.w + 2 * x; d[y * w + x] = (p.d[i] + p.d[i + 1] + p.d[i + p.w] + p.d[i + p.w + 1]) >> 2;
    }
    out.push({ w, h, d });
  }
  return out;
}
const bil = (g: Gray, x: number, y: number) => {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * g.w + x0, d = g.d;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + g.w] * (1 - fx) + d[i + g.w + 1] * fx) * fy;
};

/** Shi-Tomasi corners: best minimum-eigenvalue pixel per cell, with a quality cut. */
export function detectFeatures(g: Gray, max: number, cell: number, avoid: P2[] = []): P2[] {
  const { w, h, d } = g, m = 8;
  const ixx = new Float64Array((w + 1) * (h + 1)), ixy = new Float64Array((w + 1) * (h + 1)), iyy = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y < h - 1; y++) {
    let ax = 0, ay = 0, az = 0;
    for (let x = 1; x < w - 1; x++) {
      const gx = d[y * w + x + 1] - d[y * w + x - 1], gy = d[(y + 1) * w + x] - d[(y - 1) * w + x];
      ax += gx * gx; ay += gx * gy; az += gy * gy;
      const k = (y + 1) * (w + 1) + x + 1, u = y * (w + 1) + x + 1;
      ixx[k] = ixx[u] + ax; ixy[k] = ixy[u] + ay; iyy[k] = iyy[u] + az;
    }
  }
  const box = (I: Float64Array, x: number, y: number, r: number) => { const W = w + 1; return I[(y + r + 1) * W + x + r + 1] - I[(y - r) * W + x + r + 1] - I[(y + r + 1) * W + x - r] + I[(y - r) * W + x - r]; };
  const cols = Math.ceil(w / cell), best = new Map<number, { x: number; y: number; q: number }>();
  let qmax = 0;
  for (let y = m; y < h - m; y += 2) for (let x = m; x < w - m; x += 2) {
    const a = box(ixx, x, y, 2), b = box(ixy, x, y, 2), c = box(iyy, x, y, 2);
    const q = (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 50;
    const key = Math.floor(y / cell) * cols + Math.floor(x / cell), cur = best.get(key);
    if (!cur || q > cur.q) best.set(key, { x, y, q }); if (q > qmax) qmax = q;
  }
  const minQ = Math.max(qmax * 0.05, 40);
  return [...best.values()].filter((c) => c.q >= minQ && !avoid.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < cell * 0.8)).sort((p, q) => q.q - p.q).slice(0, max).map((c) => ({ x: c.x, y: c.y }));
}

/** Track `pts` from the previous pyramid to the next one. ok[i] is false when tracking failed. */
export function trackLK(prev: Gray[], next: Gray[], pts: P2[], win = 7, iters = 10): { out: P2[]; ok: boolean[] } {
  const L = prev.length, n = pts.length, out: P2[] = pts.map((p) => ({ ...p })), ok = new Array(n).fill(true);
  const side = 2 * win + 1, T = new Float32Array(side * side), GX = new Float32Array(side * side), GY = new Float32Array(side * side);
  for (let i = 0; i < n; i++) {
    let gx = 0, gy = 0, good = true;
    for (let l = L - 1; l >= 0 && good; l--) {
      const sc = 1 << l, p = prev[l], q = next[l], px = pts[i].x / sc, py = pts[i].y / sc;
      if (px < win + 2 || py < win + 2 || px > p.w - win - 3 || py > p.h - win - 3) { if (l === 0) good = false; else { gx *= 2; gy *= 2; } continue; }
      let a = 0, b = 0, c = 0, k = 0;
      for (let y = -win; y <= win; y++) for (let x = -win; x <= win; x++, k++) {
        T[k] = bil(p, px + x, py + y);
        GX[k] = (bil(p, px + x + 1, py + y) - bil(p, px + x - 1, py + y)) / 2; GY[k] = (bil(p, px + x, py + y + 1) - bil(p, px + x, py + y - 1)) / 2;
        a += GX[k] * GX[k]; b += GX[k] * GY[k]; c += GY[k] * GY[k];
      }
      const det = a * c - b * b; if (det < 1e-3 * side * side) { if (l === 0) good = false; if (l > 0) { gx *= 2; gy *= 2; } continue; }
      let dx = 0, dy = 0;
      for (let it = 0; it < iters; it++) {
        const qx = px + gx + dx, qy = py + gy + dy;
        if (qx < win + 2 || qy < win + 2 || qx > q.w - win - 3 || qy > q.h - win - 3) { good = false; break; }
        let e1 = 0, e2 = 0; k = 0;
        for (let y = -win; y <= win; y++) for (let x = -win; x <= win; x++, k++) { const e = T[k] - bil(q, qx + x, qy + y); e1 += e * GX[k]; e2 += e * GY[k]; }
        const ux = (c * e1 - b * e2) / det, uy = (a * e2 - b * e1) / det; dx += ux; dy += uy;
        if (ux * ux + uy * uy < 0.0004) break;
      }
      gx += dx; gy += dy; if (l > 0) { gx *= 2; gy *= 2; }
    }
    if (!good || !Number.isFinite(gx + gy)) ok[i] = false; else { out[i] = { x: pts[i].x + gx, y: pts[i].y + gy }; if (out[i].x < 0 || out[i].y < 0 || out[i].x >= next[0].w || out[i].y >= next[0].h) ok[i] = false; }
  }
  return { out, ok };
}
