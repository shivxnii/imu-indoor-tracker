import type { P2 } from "./geometry";
import type { Gray } from "./flow";

/* Automatic tile-boundary candidates: Sobel edges -> Hough line transform (gradient-direction constrained).
 * These are CANDIDATES drawn over the live image. They are not used to compute position. Plain or low-contrast floors may give none. */
export interface Seg { a: P2; b: P2; votes: number }
export interface LineResult { segs: Seg[]; corners: P2[]; edgePx: number }

export function detectLines(g: Gray, maxLines = 14): LineResult {
  const { w, h, d } = g, mag = new Float32Array(w * h), ang = new Float32Array(w * h);
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = d[i - w + 1] + 2 * d[i + 1] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - 1] - d[i + w - 1];
    const gy = d[i + w - 1] + 2 * d[i + w] + d[i + w + 1] - d[i - w - 1] - 2 * d[i - w] - d[i - w + 1];
    const m = Math.hypot(gx, gy); mag[i] = m; ang[i] = Math.atan2(gy, gx); sum += m; sum2 += m * m; n++;
  }
  const mean = sum / n, thr = Math.max(40, mean + 1.8 * Math.sqrt(Math.max(0, sum2 / n - mean * mean)));
  const NT = 60, dr = 2, diag = Math.hypot(w, h), NR = Math.ceil((2 * diag) / dr) + 2, acc = new Int32Array(NT * NR);
  const edges: number[] = [];
  const cs = Array.from({ length: NT }, (_, t) => Math.cos((t * Math.PI) / NT)), sn = Array.from({ length: NT }, (_, t) => Math.sin((t * Math.PI) / NT));
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (mag[i] < thr) continue;
    edges.push(x, y);
    let t0 = Math.round(((((ang[i] % Math.PI) + Math.PI) % Math.PI) / Math.PI) * NT);
    for (let dt = -2; dt <= 2; dt++) {
      const t = (((t0 + dt) % NT) + NT) % NT, r = x * cs[t] + y * sn[t];
      acc[t * NR + Math.round((r + diag) / dr)]++;
    }
  }
  const peaks: { t: number; r: number; v: number }[] = []; let vmax = 0;
  for (let k = 0; k < acc.length; k++) if (acc[k] > vmax) vmax = acc[k];
  const minV = Math.max(30, vmax * 0.3);
  for (let t = 0; t < NT; t++) for (let r = 2; r < NR - 2; r++) {
    const v = acc[t * NR + r]; if (v < minV) continue;
    let isMax = true;
    for (let dt = -3; dt <= 3 && isMax; dt++) for (let dr2 = -3; dr2 <= 3; dr2++) {
      if (!dt && !dr2) continue; const tt = t + dt, rr = r + dr2; if (rr < 0 || rr >= NR) continue;
      const wrapT = (tt + NT) % NT, flip = tt < 0 || tt >= NT, rrr = flip ? NR - 1 - rr : rr; // theta wraps with rho sign flip
      const o = acc[wrapT * NR + rrr]; if (o > v || (o === v && (dt < 0 || (dt === 0 && dr2 < 0)))) { isMax = false; break; }
    }
    if (isMax) peaks.push({ t, r, v });
  }
  peaks.sort((a, b) => b.v - a.v);
  const segs: Seg[] = [];
  for (const pk of peaks.slice(0, maxLines)) {
    const rho = pk.r * dr - diag, c = cs[pk.t], s = sn[pk.t], dx = -s, dy = c;
    let lo = 1e9, hi = -1e9, cnt = 0;
    for (let e = 0; e < edges.length; e += 2) {
      const x = edges[e], y = edges[e + 1];
      if (Math.abs(x * c + y * s - rho) > 2.5) continue;
      const u = x * dx + y * dy; if (u < lo) lo = u; if (u > hi) hi = u; cnt++;
    }
    if (cnt < 25 || hi - lo < Math.min(w, h) * 0.15) continue;
    segs.push({ a: { x: rho * c + lo * dx, y: rho * s + lo * dy }, b: { x: rho * c + hi * dx, y: rho * s + hi * dy }, votes: pk.v });
  }
  // intersections of clearly non-parallel segments, near both segments' extents
  const corners: P2[] = [];
  const distToSeg = (p: P2, s: Seg) => { const vx = s.b.x - s.a.x, vy = s.b.y - s.a.y, t = Math.max(0, Math.min(1, ((p.x - s.a.x) * vx + (p.y - s.a.y) * vy) / (vx * vx + vy * vy))); return Math.hypot(p.x - s.a.x - t * vx, p.y - s.a.y - t * vy); };
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const A = segs[i], B = segs[j], ux = A.b.x - A.a.x, uy = A.b.y - A.a.y, vx = B.b.x - B.a.x, vy = B.b.y - B.a.y;
    const cr = ux * vy - uy * vx, sinA = Math.abs(cr) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)); if (sinA < 0.5) continue;
    const t = ((B.a.x - A.a.x) * vy - (B.a.y - A.a.y) * vx) / cr, p = { x: A.a.x + t * ux, y: A.a.y + t * uy };
    if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h || distToSeg(p, A) > 12 || distToSeg(p, B) > 12) continue;
    if (!corners.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 8)) corners.push(p);
  }
  return { segs, corners, edgePx: edges.length / 2 };
}
