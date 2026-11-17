import { useEffect, useRef, useSyncExternalStore } from "react";
import { vision } from "../vision/engine";
import { apply, inv3 } from "../vision/geometry";
import { FLOOR } from "../tracking/tracker";
import { useDisplay } from "../tracking/fusion";

/* Top-down floor plan in the SAME coordinates as the 3D map (X 0-1200, Y 0-1200 mm, origin bottom-left).
 * Shows the four zones, the part of the floor the camera currently sees (image frame projected through the homography),
 * the estimated phone position and a probe point. The camera video itself is never warped. */
export default function FloorMap2D() {
  const v = useSyncExternalStore(vision.subscribe, vision.getSnapshot);
  const d = useDisplay(), ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return; const g = c.getContext("2d")!, S = c.width, { roomL: W, roomB: B, tileL, tileB } = FLOOR, M = 0.25 * S;
    const k = (S - 2 * M) / W, X = (x: number) => M + x * k, Y = (y: number) => S - M - y * k;
    g.clearRect(0, 0, S, S); g.fillStyle = "#0b0e13"; g.fillRect(0, 0, S, S);
    g.font = "bold 13px system-ui,sans-serif";
    for (let r = 0; r < B / tileB; r++) for (let q = 0; q < W / tileL; q++) {
      const hit = d.zone && d.zone.row === r && d.zone.col === q;
      g.fillStyle = hit ? "rgba(250,204,21,.35)" : "rgba(226,214,190,.12)"; g.fillRect(X(q * tileL), Y((r + 1) * tileB), tileL * k, tileB * k);
      g.strokeStyle = "#e7dcc2"; g.lineWidth = 2; g.strokeRect(X(q * tileL), Y((r + 1) * tileB), tileL * k, tileB * k);
      g.fillStyle = hit ? "#facc15" : "#cbd5e1"; g.fillText(`R${r + 1}C${q + 1}`, X(q * tileL) + 8, Y(r * tileB) - 8);
    }
    const H = v.H ?? v.calibH, Hi = H && !v.lost ? inv3(H) : null;
    if (Hi && v.procW) {
      const fp = [[0, 0], [v.procW, 0], [v.procW, v.procH], [0, v.procH]].map(([x, y]) => apply(Hi, { x, y }));
      if (fp.every((p) => Number.isFinite(p.x + p.y) && Math.abs(p.x) < 6000 && Math.abs(p.y) < 6000)) {
        g.save(); g.beginPath(); g.rect(0, 0, S, S); g.clip(); g.beginPath(); fp.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y)))); g.closePath();
        g.fillStyle = "rgba(34,211,238,.12)"; g.fill(); g.strokeStyle = "#22d3ee"; g.lineWidth = 2; g.setLineDash([6, 4]); g.stroke(); g.restore();
      }
    }
    if (v.probe) { g.fillStyle = "#f472b6"; g.beginPath(); g.arc(X(v.probe.x), Y(v.probe.y), 5, 0, 7); g.fill(); }
    if (d.pos) { g.fillStyle = v.lost ? "#f87171" : "#4ade80"; g.beginPath(); g.arc(X(d.pos.x), Y(d.pos.y), 7, 0, 7); g.fill(); g.strokeStyle = "#000"; g.lineWidth = 2; g.stroke(); }
  }, [v.H, v.calibH, v.lost, v.probe, v.procW, v.procH, d.pos, d.zone]);
  return (
    <div>
      <canvas ref={ref} width={360} height={360} style={{ width: "100%", maxWidth: 360, background: "#0b0e13", border: "1px solid var(--line)", borderRadius: 4 }} />
      <p className="note">Floor plan (mm, origin bottom-left). Cyan dashed = the floor area the camera currently sees; green dot = estimated phone position (camera pose, not the image centre); pink = probe point.</p>
    </div>
  );
}
