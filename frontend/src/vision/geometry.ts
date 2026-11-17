/* Planar geometry for floor localisation. All maths is plain TypeScript, no simulated data.
 * Floor frame: X right, Y up (mm), Z up out of the floor. Image frame: pixels, x right, y down. */
export interface P2 { x: number; y: number }
export type Mat3 = number[]; // row-major, length 9

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}
export function inv3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}
export function apply(H: Mat3, p: P2): P2 {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

function normT(pts: P2[]): { T: Mat3; q: P2[] } {
  const n = pts.length; let mx = 0, my = 0;
  pts.forEach((p) => { mx += p.x / n; my += p.y / n; });
  let d = 0; pts.forEach((p) => { d += Math.hypot(p.x - mx, p.y - my) / n; });
  const s = d > 1e-9 ? Math.SQRT2 / d : 1;
  return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1], q: pts.map((p) => ({ x: s * (p.x - mx), y: s * (p.y - my) })) };
}

/** Solve A x = b (n x n) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

/** Least-squares homography src -> dst (h33 = 1) with Hartley normalisation. Needs >= 4 points, no 3 collinear. */
export function homography(src: P2[], dst: P2[]): Mat3 | null {
  if (src.length < 4 || src.length !== dst.length) return null;
  const a = normT(src), b = normT(dst);
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0)), Atb = new Array(8).fill(0);
  for (let i = 0; i < src.length; i++) {
    const { x, y } = a.q[i], { x: u, y: v } = b.q[i];
    const r1 = [x, y, 1, 0, 0, 0, -u * x, -u * y], r2 = [0, 0, 0, x, y, 1, -v * x, -v * y];
    for (let p = 0; p < 8; p++) {
      Atb[p] += r1[p] * u + r2[p] * v;
      for (let q = 0; q < 8; q++) AtA[p][q] += r1[p] * r1[q] + r2[p] * r2[q];
    }
  }
  const h = solve(AtA, Atb); if (!h) return null;
  const Hn: Mat3 = [...h, 1], Ti = inv3(b.T); if (!Ti) return null;
  const H = mul3(mul3(Ti, Hn), a.T), s = H[8];
  if (!Number.isFinite(s) || Math.abs(s) < 1e-12) return null;
  return H.map((v) => v / s);
}

export function rmsError(H: Mat3, src: P2[], dst: P2[]): number {
  let s = 0; src.forEach((p, i) => { const q = apply(H, p); s += (q.x - dst[i].x) ** 2 + (q.y - dst[i].y) ** 2; });
  return Math.sqrt(s / src.length);
}

/** RANSAC homography for tracked feature pairs. Returns the model and the inlier mask. */
export function ransacHomography(src: P2[], dst: P2[], thresh: number, iters = 80): { H: Mat3; inliers: boolean[]; n: number } | null {
  const n = src.length; if (n < 8) return null;
  let best: boolean[] | null = null, bestN = 0;
  for (let it = 0; it < iters; it++) {
    const idx = new Set<number>(); while (idx.size < 4) idx.add(Math.floor(Math.random() * n));
    const ids = [...idx], H = homography(ids.map((i) => src[i]), ids.map((i) => dst[i])); if (!H) continue;
    const mask = src.map((p, i) => { const q = apply(H, p); return Math.hypot(q.x - dst[i].x, q.y - dst[i].y) < thresh; });
    const c = mask.filter(Boolean).length; if (c > bestN) { bestN = c; best = mask; }
  }
  if (!best || bestN < 8) return null;
  const H = homography(src.filter((_, i) => best![i]), dst.filter((_, i) => best![i])); if (!H) return null;
  return { H, inliers: best, n: bestN };
}

export interface Intrinsics { f: number; cx: number; cy: number }
export interface Pose {
  cam: { x: number; y: number; z: number };  // camera centre in floor coordinates, mm (z = height above the floor)
  heading: number;                            // degrees clockwise from +Y: direction of the image's "up" edge on the floor
  tiltDeg: number;                            // angle between the optical axis and straight down
}

/** Camera pose from the floor-to-image homography (floor plane Z = 0). Returns null for degenerate/behind-camera cases. */
export function poseFromHomography(H: Mat3, K: Intrinsics): Pose | null {
  const n = (c: number) => [(H[c] - K.cx * H[6 + c]) / K.f, (H[3 + c] - K.cy * H[6 + c]) / K.f, H[6 + c]];
  let h1 = n(0), h2 = n(1), h3 = n(2);
  const l1 = Math.hypot(...h1), l2 = Math.hypot(...h2); if (l1 < 1e-12 || l2 < 1e-12) return null;
  let lam = 2 / (l1 + l2);
  if (h3[2] * lam < 0) lam = -lam; // the floor must lie in front of the camera
  h1 = h1.map((v) => v * lam); h2 = h2.map((v) => v * lam); h3 = h3.map((v) => v * lam);
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const nrm = (a: number[]) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const r1 = nrm(h1); let r2 = h2.map((v, i) => v - dot(h2, r1) * r1[i]); r2 = nrm(r2);
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  const R = [r1, r2, r3]; // columns of R are r1,r2,r3 -> R[col][row]
  const Rm = (row: number, col: number) => R[col][row];
  const C = [0, 1, 2].map((i) => -(Rm(0, i) * h3[0] + Rm(1, i) * h3[1] + Rm(2, i) * h3[2]));
  if (!C.every(Number.isFinite) || C[2] < 1) return null;
  // image "up" (0,-1,0) in the camera frame, expressed in floor coordinates: R^T * (0,-1,0) = -row 1 of R
  const up = [-Rm(1, 0), -Rm(1, 1), -Rm(1, 2)];
  const axis = [Rm(2, 0), Rm(2, 1), Rm(2, 2)]; // optical axis (0,0,1) in floor coordinates
  const heading = (Math.atan2(up[0], up[1]) * 180) / Math.PI;
  const tiltDeg = (Math.acos(Math.max(-1, Math.min(1, -axis[2]))) * 180) / Math.PI;
  return { cam: { x: C[0], y: C[1], z: C[2] }, heading: ((heading % 360) + 360) % 360, tiltDeg };
}
