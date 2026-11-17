import { useEffect, useRef, useSyncExternalStore } from "react";
import { tileAt } from "../tracking/grid";
import { camera } from "../camera/cameraManager";
import { vision } from "../vision/engine";
import { Mat3, apply } from "../vision/geometry";
import { CORNER_LABEL, worldCorners, worldMids } from "../vision/calib";
import { FLOOR } from "../tracking/tracker";

/* Live camera preview (real getUserMedia stream) with the vision overlay on top:
 * registered markers (green), unregistered markers (orange), candidate tile boundaries (cyan, automatic),
 * the 4-tile grid projected from the current fix (yellow), and manually tapped corners (magenta). */
export default function CameraView({ compact = false }: { compact?: boolean }) {
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot);
  const v = useSyncExternalStore(vision.subscribe, vision.getSnapshot);
  const vref = useRef<HTMLVideoElement>(null), cref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = vref.current; if (!el) return;
    if (el.srcObject !== cam.stream) el.srcObject = cam.stream;
    if (cam.stream) el.play().catch(() => { /* autoplay can be blocked until interaction */ });
  }, [cam.stream]);

  useEffect(() => {
    const draw = () => {
      const c = cref.current; if (!c) return; const s = vision.getSnapshot();
      if (c.width !== s.procW || c.height !== s.procH) { c.width = s.procW || 640; c.height = s.procH || 480; }
      const g = c.getContext("2d")!; g.clearRect(0, 0, c.width, c.height);
      if (s.frozen) g.drawImage(s.frozen, 0, 0, c.width, c.height);
      g.lineJoin = "round"; g.lineCap = "round";
      const poly = (pts: { x: number; y: number }[], col: string, lw: number, fill?: string) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } g.strokeStyle = col; g.lineWidth = lw; g.stroke(); };
      const text = (t: string, x: number, y: number, col: string) => { g.font = "bold 18px system-ui,sans-serif"; g.lineWidth = 4; g.strokeStyle = "rgba(0,0,0,.75)"; g.strokeText(t, x, y); g.fillStyle = col; g.fillText(t, x, y); };
      // candidate tile boundaries (automatic)
      g.strokeStyle = "#22d3ee"; g.lineWidth = 2;
      if (s.calib.phase !== "locked") s.segs.forEach((sg) => { g.beginPath(); g.moveTo(sg.a.x, sg.a.y); g.lineTo(sg.b.x, sg.b.y); g.stroke(); });
      if (s.calib.phase !== "locked") s.lineCorners.forEach((p) => { g.beginPath(); g.arc(p.x, p.y, 5, 0, 7); g.fillStyle = "#22d3ee"; g.fill(); });
      // projected four-tile grid from the current fix
      if (s.H && !s.lost && s.calib.phase === "off") {
        const { tileL, tileB, roomL, roomB } = FLOOR;
        for (let r = 0; r < roomB / tileB; r++) for (let q = 0; q < roomL / tileL; q++) {
          const corners = [[q, r], [q + 1, r], [q + 1, r + 1], [q, r + 1]].map(([i, j]) => apply(s.H!, { x: i * tileL, y: j * tileB }));
          poly(corners, "#facc15", 2.5, "rgba(250,204,21,.10)");
          const c = apply(s.H!, { x: q * tileL + tileL / 2, y: r * tileB + tileB / 2 }); text(`R${r + 1}C${q + 1}`, c.x - 22, c.y + 6, "#facc15");
        }
      }
      // calibrated floor grid (manual four-corner calibration -> homography -> 4 tiles) drawn ON the live video
      const cs = s.calib, sc = Math.max(1, c.width / (c.clientWidth || c.width));
      const drawGrid = (H: Mat3, col: string, dash: boolean, label: boolean) => {
        const { tileL, tileB, roomL, roomB } = FLOOR; g.save(); if (dash) g.setLineDash([10, 8]);
        for (let r = 0; r < roomB / tileB; r++) for (let q = 0; q < roomL / tileL; q++) {
          const corners = [[q, r], [q + 1, r], [q + 1, r + 1], [q, r + 1]].map(([i, j]) => apply(H, { x: i * tileL, y: j * tileB }));
          if (!corners.every((p) => Number.isFinite(p.x + p.y))) continue;
          poly(corners, col, 2, dash ? undefined : "rgba(250,204,21,.08)");
          if (label) { const m = apply(H, { x: q * tileL + tileL / 2, y: r * tileB + tileB / 2 }); g.setLineDash([]); text(`R${r + 1}C${q + 1}`, m.x - 24, m.y, col); text(`Zone ${r * (roomL / tileL) + q + 1}`, m.x - 30, m.y + 20, col); if (dash) g.setLineDash([10, 8]); }
        }
        g.setLineDash([]);
        // the two internal tile boundaries, drawn heavier
        const A = worldMids(); g.strokeStyle = "#fb923c"; g.lineWidth = 3.5; if (dash) g.setLineDash([10, 8]);
        [[0, 2], [3, 1]].forEach(([i, j]) => { const a = apply(H, A[i]), b = apply(H, A[j]); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); });
        g.restore();
      };
      if (cs.phase === "locked") {
        if (s.H && !s.lost) drawGrid(s.H, "#facc15", false, true);
        else if (s.calibH) { drawGrid(s.calibH, "#9ca3af", true, true); text("STATIC GRID – camera moved / tracking lost", 12, c.height - 14, "#f87171"); }
        // detected grout lines (green dashed), only if confidently found
        if (s.H && !s.lost) ([["v", 0, 2], ["h", 3, 1]] as const).forEach(([k, i, j]) => {
          const gr = s.grout[k]; if (!gr?.ok) return; const A = worldMids(), a = apply(s.H!, A[i]), b = apply(s.H!, A[j]);
          g.save(); g.setLineDash([4, 6]); g.strokeStyle = "#4ade80"; g.lineWidth = 2.5; g.beginPath(); g.moveTo(a.x + gr.offPx * gr.n.x, a.y + gr.offPx * gr.n.y); g.lineTo(b.x + gr.offPx * gr.n.x, b.y + gr.offPx * gr.n.y); g.stroke(); g.restore();
        });
        if (s.probe && s.H) { const p = apply(s.H, s.probe); if (Number.isFinite(p.x + p.y)) { g.strokeStyle = "#f472b6"; g.lineWidth = 3; g.beginPath(); g.arc(p.x, p.y, 10 * sc, 0, 7); g.moveTo(p.x - 16 * sc, p.y); g.lineTo(p.x + 16 * sc, p.y); g.moveTo(p.x, p.y - 16 * sc); g.lineTo(p.x, p.y + 16 * sc); g.stroke(); const t = tileAt(FLOOR, s.probe.x, s.probe.y); text(`X ${s.probe.x.toFixed(0)} Y ${s.probe.y.toFixed(0)} mm${t ? " · " + t.id : " · outside"}`, p.x + 14 * sc, p.y - 12 * sc, "#f472b6"); } }
      } else if (cs.phase === "edit" || cs.phase === "tap") {
        const H = vision.calibEditH();
        if (H) drawGrid(H, "#facc15", false, true);
        else if (cs.pts.length >= 2) { g.strokeStyle = "#f0abfc"; g.lineWidth = 2.5; g.beginPath(); cs.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); if (cs.pts.length === 4) g.closePath(); g.stroke(); }
        const wm = worldMids();
        cs.pts.forEach((p, i) => { g.beginPath(); g.arc(p.x, p.y, 11 * sc, 0, 7); g.fillStyle = "rgba(240,171,252,.35)"; g.fill(); g.strokeStyle = "#f0abfc"; g.lineWidth = 3; g.stroke(); g.beginPath(); g.arc(p.x, p.y, 2 * sc, 0, 7); g.fillStyle = "#f0abfc"; g.fill(); text(`${i + 1} ${CORNER_LABEL[i]}`, p.x + 14 * sc, p.y - 10 * sc, "#f0abfc"); });
        if (cs.phase === "edit" && H) cs.mids.forEach((m, i) => { const p = m ?? apply(H, wm[i]); g.beginPath(); g.arc(p.x, p.y, 9 * sc, 0, 7); g.fillStyle = m ? "rgba(34,211,238,.55)" : "rgba(34,211,238,.25)"; g.fill(); g.strokeStyle = "#22d3ee"; g.lineWidth = 2.5; g.stroke(); });
      }
      if (cs.phase === "locked" && s.fix && !s.lost) { const fx = s.fix; text(`X ${fx.phone.x.toFixed(0)}  Y ${fx.phone.y.toFixed(0)}  Z ${fx.cam.z.toFixed(0)} mm`, 10, c.height - 36, "#4ade80"); }
      // status lines (calibration / detection / tracking) on the video
      { const calS = cs.phase === "locked" ? "locked" : cs.phase === "edit" ? "adjusting corners" : cs.phase === "tap" ? `tapping corners ${cs.pts.length}/4` : "not calibrated";
        const grS = cs.phase !== "locked" ? "–" : !s.grout.v && !s.grout.h ? "checking…" : `V ${s.grout.v?.ok ? "found" : "unsure"} · H ${s.grout.h?.ok ? "found" : "unsure"}`;
        const trS = cs.phase !== "locked" ? "–" : s.lost ? "LOST" : s.fix?.source === "flow" ? "optical flow (drifts)" : s.fix?.source === "marker" ? "marker" : "calibration fix";
        g.font = "bold 14px system-ui,sans-serif"; [`Calibration: ${calS}`, `Grout detection: ${grS}`, `Tracking: ${trS}`].forEach((t, i) => { g.lineWidth = 4; g.strokeStyle = "rgba(0,0,0,.8)"; g.strokeText(t, 10, 20 + i * 18); g.fillStyle = "#e5e7eb"; g.fillText(t, 10, 20 + i * 18); }); }
      // markers
      s.markers.forEach((m) => { poly(m.corners, m.known ? "#4ade80" : "#fb923c", 3); text(`ID ${m.id}${m.known ? "" : " (unregistered)"}`, m.corners[0].x, m.corners[0].y - 8, m.known ? "#4ade80" : "#fb923c"); });
      // manual corners
      s.manual.pts.forEach((p, i) => { g.strokeStyle = "#f0abfc"; g.lineWidth = 3; g.beginPath(); g.moveTo(p.x - 12, p.y); g.lineTo(p.x + 12, p.y); g.moveTo(p.x, p.y - 12); g.lineTo(p.x, p.y + 12); g.stroke(); text(String(i + 1), p.x + 10, p.y - 8, "#f0abfc"); });
      if (s.lost) text("TRACKING LOST", 12, 90, "#f87171");
    };
    draw(); const off = vision.onFrame(draw); return off;
  }, []);

  const drag = useRef<number | null>(null);
  const toImg = (e: React.PointerEvent) => { const c = cref.current!, b = c.getBoundingClientRect(); return { x: ((e.clientX - b.left) / b.width) * c.width, y: ((e.clientY - b.top) / b.height) * c.height, sc: c.width / b.width }; };
  const handles = () => { const cs = vision.getSnapshot().calib, H = vision.calibEditH(), wm = worldMids(); const h = cs.pts.map((p, i) => ({ i, p })); if (H) cs.mids.forEach((m, i) => h.push({ i: i + 4, p: m ?? apply(H, wm[i]) })); return h; };
  const onDown = (e: React.PointerEvent) => {
    const p = toImg(e), st = vision.getSnapshot(), ph = st.calib.phase;
    if (ph === "tap") { vision.calibTap(p); return; }
    if (ph === "edit") {
      let best = -1, bd = 34 * p.sc; for (const h of handles()) { const d = Math.hypot(h.p.x - p.x, h.p.y - p.y); if (d < bd) { bd = d; best = h.i; } }
      if (best >= 0) { drag.current = best; (e.target as Element).setPointerCapture(e.pointerId); vision.calibMove(best, p); } return;
    }
    if (ph === "locked") { vision.probeAt(p); return; }
    if (!v.manual.active) return;
    vision.addManualPoint(p);
  };
  const onMove = (e: React.PointerEvent) => { if (drag.current !== null) vision.calibMove(drag.current, toImg(e)); };
  const onUp = () => { drag.current = null; };
  const busy = v.manual.active || v.calib.phase === "tap" || v.calib.phase === "edit" || v.calib.phase === "locked";
  const aspect = cam.width && cam.height ? `${cam.width} / ${cam.height}` : "4 / 3";
  return (
    <div className="camwrap" data-camview="" style={{ aspectRatio: aspect, maxHeight: compact ? 300 : 520 }}>
      <video ref={vref} muted playsInline autoPlay />
      <canvas ref={cref} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} style={{ cursor: busy ? "crosshair" : "default", touchAction: v.calib.phase === "tap" || v.calib.phase === "edit" || v.manual.active ? "none" : "auto" }} />
      {cam.status !== "live" && <div className="camfill">{cam.status === "starting" ? "Starting camera…" : cam.status === "error" ? cam.error : "Camera is off. Press Start Camera."}</div>}
    </div>
  );
}
