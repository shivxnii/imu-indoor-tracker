import { AR } from "../vendor/aruco.js";
import type { P2 } from "./geometry";

/* Reference markers: ArUco ARUCO_MIP_36h12 (ids 0-249), the dictionary shipped with js-aruco2.
 * Each registered marker has a known centre on the floor (mm), a printed side length (black square, mm) and an
 * orientation: the direction its top edge faces, in degrees clockwise from the floor's +Y axis. */
export interface MarkerDef { id: number; x: number; y: number; size: number; rot: number }
export const DICTIONARY = "ARUCO_MIP_36h12";

export const defaultMarkers = (): MarkerDef[] => [
  { id: 0, x: 300, y: 300, size: 100, rot: 0 }, { id: 1, x: 900, y: 300, size: 100, rot: 0 },
  { id: 2, x: 300, y: 900, size: 100, rot: 0 }, { id: 3, x: 900, y: 900, size: 100, rot: 0 }
];

const KEY = "imu-tracker.markers.v1";
let defs: MarkerDef[] = (() => {
  try { const j = JSON.parse(localStorage.getItem(KEY) || "null"); if (Array.isArray(j) && j.every((m) => ["id", "x", "y", "size", "rot"].every((k) => Number.isFinite(m?.[k])))) return j; } catch { /* storage unavailable */ }
  return defaultMarkers();
})();
const subs = new Set<() => void>();
export const markerRegistry = {
  subscribe: (l: () => void) => { subs.add(l); return () => { subs.delete(l); }; },
  getSnapshot: () => defs,
  set(next: MarkerDef[]) { defs = next; try { localStorage.setItem(KEY, JSON.stringify(defs)); } catch { /* ignore */ } subs.forEach((l) => l()); },
  reset() { this.set(defaultMarkers()); }
};

/** Floor coordinates (mm) of a marker's corners in the order the detector reports them: TL, TR, BR, BL of the marker as printed. */
export function markerWorldCorners(m: MarkerDef): P2[] {
  const h = m.size / 2, th = (m.rot * Math.PI) / 180, s = Math.sin(th), c = Math.cos(th);
  return [[-h, h], [h, h], [h, -h], [-h, -h]].map(([a, b]) => ({ x: m.x + a * c + b * s, y: m.y - a * s + b * c }));
}

export interface Detected { id: number; corners: P2[]; dist: number }
let det: any = null;
export function detectMarkers(img: ImageData): Detected[] {
  det = det || new AR.Detector({ dictionaryName: DICTIONARY, maxHammingDistance: 5 });
  const out: Detected[] = [], seen = new Set<number>();
  for (const m of det.detect(img) as { id: number; corners: P2[]; hammingDistance: number }[]) {
    if (seen.has(m.id)) continue; seen.add(m.id);
    out.push({ id: m.id, corners: m.corners.map((c) => ({ x: c.x, y: c.y })), dist: m.hammingDistance });
  }
  return out;
}

/** SVG of a printable marker (white quiet zone included). 1 module = size/8 mm; the black square is `size` mm wide. */
export function markerSvg(id: number, sizeMm: number): string {
  const dict = new AR.Dictionary(DICTIONARY);
  const total = (sizeMm * 10) / 8;
  return dict.generateSVG(id).replace("<svg ", `<svg width="${total}mm" height="${total}mm" `);
}
