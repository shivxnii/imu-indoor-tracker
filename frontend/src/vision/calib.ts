import { Mat3, P2, apply, homography } from "./geometry";
import type { Gray } from "./flow";
import { FLOOR } from "../tracking/tracker";

/* Manual floor calibration helpers.
 * Image corner order (what you tap on the screen): top-left, top-right, bottom-right, bottom-left of the 2x2 tile area.
 * Floor frame (same as the 3D map): origin = bottom-left corner of the floor, X right, Y up, mm. So image "top" = high Y.
 * The homography maps FLOOR -> IMAGE. It is fitted from the four corners (plus any internal-line handles you moved). */
export const CORNER_LABEL = ["top-left", "top-right", "bottom-right", "bottom-left"];
export const MID_LABEL = ["top middle", "right middle", "bottom middle", "left middle"];

export const worldCorners = (): P2[] => { const { roomL: W, roomB: B } = FLOOR; return [{ x: 0, y: B }, { x: W, y: B }, { x: W, y: 0 }, { x: 0, y: 0 }]; };
/** Where the two internal grout lines meet the outer edge: top, right, bottom, left (floor mm). */
export const worldMids = (): P2[] => { const { roomL: W, roomB: B, tileL, tileB } = FLOOR; return [{ x: tileL, y: B }, { x: W, y: tileB }, { x: tileL, y: 0 }, { x: 0, y: tileB }]; };

/** Convex, non-degenerate, clockwise on screen (i.e. tapped in the order TL, TR, BR, BL). */
export function convexQuad(p: P2[]): boolean {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4], cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 50) return false; const sg = Math.sign(cr); if (!s) s = sg; else if (sg !== s) return false;
  }
  return s > 0;
}

/** Floor -> image homography. Moved internal handles are added with extra weight so the grid line passes through them. */
export function fitCalib(pts: P2[], mids: (P2 | null)[]): Mat3 | null {
  if (pts.length < 4 || !convexQuad(pts)) return null;
  const wc = worldCorners(), wm = worldMids(), src = [...wc], dst = [...pts];
  mids.forEach((m, i) => { if (m) for (let k = 0; k < 3; k++) { src.push(wm[i]); dst.push(m); } });
  return homography(src, dst);
}

/* ---------- automatic grout-line detection (checks the calibrated grid, never replaces it) ---------- */
export interface Grout { ok: boolean; offPx: number; n: P2; agree: number; contrast: number; why: string }

const samp = (g: Gray, x: number, y: number) => {
  if (x < 0 || y < 0 || x >= g.w - 1 || y >= g.h - 1) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * g.w + x0, d = g.d;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + g.w] * (1 - fx) + d[i + g.w + 1] * fx) * fy;
};
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/**
 * Looks for a thin dark/bright ridge (grout) near the PREDICTED internal line of the calibrated grid.
 * Five chunks along the line are averaged over a few samples each and scanned perpendicular to the line (+-R px).
 * A ridge is only reported when >= 3 chunks agree on its position (within 3 px) and have the same sign and clear contrast.
 * Marble veining, reflections and shadows rarely agree like that, so low-confidence results are rejected rather than forced.
 */
export function detectGrout(g: Gray, H: Mat3, axis: "v" | "h"): Grout {
  const { roomL: W, roomB: B, tileL, tileB } = FLOOR;
  const at = (t: number): P2 => (axis === "v" ? { x: tileL, y: B * t } : { x: W * t, y: tileB });
  const R = Math.round(Math.max(14, 0.05 * Math.max(g.w, g.h))), K = 4, CH = 5, S = 7;
  const nOf = (t: number): P2 => { const a = apply(H, at(t - 0.01)), b = apply(H, at(t + 0.01)), dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1; return { x: -dy / L, y: dx / L }; };
  const nMid = nOf(0.5), fail = (why: string): Grout => ({ ok: false, offPx: 0, n: nMid, agree: 0, contrast: 0, why });
  const chunks: { off: number; sign: number; mag: number; ratio: number }[] = [];
  for (let c = 0; c < CH; c++) {
    const tc = 0.16 + (0.68 * c) / (CH - 1), prof = new Float64Array(2 * R + 1), cnt = new Int32Array(2 * R + 1);
    for (let s = 0; s < S; s++) {
      const t = tc + (s - (S - 1) / 2) * 0.012, p = apply(H, at(t)), n = nOf(t);
      if (!Number.isFinite(p.x + p.y + n.x + n.y)) return fail("grid is outside the image");
      for (let o = -R; o <= R; o++) { const v = samp(g, p.x + o * n.x, p.y + o * n.y); if (Number.isFinite(v)) { prof[o + R] += v; cnt[o + R]++; } }
    }
    let ok = true; const a = new Float64Array(2 * R + 1);
    for (let i = 0; i <= 2 * R; i++) { if (cnt[i] < S * 0.7) { ok = false; break; } a[i] = prof[i] / cnt[i]; }
    if (!ok) continue;
    const sm = new Float64Array(2 * R + 1); for (let i = 1; i < 2 * R; i++) sm[i] = (a[i - 1] + a[i] + a[i + 1]) / 3;
    const r: number[] = []; let best = -1, bi = -1;
    for (let i = K + 1; i <= 2 * R - K - 1; i++) { const v = (sm[i - K] + sm[i + K]) / 2 - sm[i]; r.push(Math.abs(v)); if (Math.abs(v) > best) { best = Math.abs(v); bi = i; } }
    if (bi < 0) continue;
    const sign = Math.sign((sm[bi - K] + sm[bi + K]) / 2 - sm[bi]), ratio = best / (median(r) + 0.5);
    chunks.push({ off: bi - R, sign, mag: best, ratio });
  }
  const strong = chunks.filter((c) => c.ratio >= 3 && c.mag >= 2);
  if (strong.length < 3) return fail(`no clear line (${strong.length}/5 chunks)`);
  const pos = strong.filter((c) => c.sign > 0).length, sign = pos * 2 >= strong.length ? 1 : -1, same = strong.filter((c) => c.sign === sign);
  const med = median(same.map((c) => c.off)), agree = same.filter((c) => Math.abs(c.off - med) <= 3);
  if (agree.length < 3) return fail(`chunks disagree (${agree.length}/5 agree)`);
  return { ok: true, offPx: agree.reduce((s, c) => s + c.off, 0) / agree.length, n: nMid, agree: agree.length, contrast: median(agree.map((c) => c.mag)), why: `${agree.length}/5 chunks agree` };
}
