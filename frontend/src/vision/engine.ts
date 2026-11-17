import { Mat3, P2, Pose, apply, homography, inv3, mul3, poseFromHomography, ransacHomography, rmsError } from "./geometry";
import { Detected, MarkerDef, detectMarkers, markerRegistry, markerWorldCorners } from "./markers";
import { Gray, detectFeatures, pyramid, toGray, trackLK } from "./flow";
import { LineResult, detectLines } from "./lines";
import { FLOOR } from "../tracking/tracker";
import { CORNER_LABEL, Grout, convexQuad, detectGrout, fitCalib, worldCorners, worldMids } from "./calib";

/*
 * VISION ENGINE: turns real camera frames into floor coordinates.
 *   marker  : registered ArUco markers at known floor positions -> homography -> camera pose (absolute, no drift)
 *   manual  : the user taps the 4 corners of a tile (or of the whole floor) on a frozen frame -> homography -> pose (absolute at that moment)
 *   flow    : optical-flow tracking of the floor plane from the latest marker/manual anchor. RELATIVE: it drifts, and its scale
 *             depends on the anchor. It is switched off by default and always labelled as drifting.
 * Tile-line detection (Hough) is an overlay only; it never feeds position.
 * Nothing here is simulated: every number is computed from frames delivered by getUserMedia.
 */
export type FixSource = "marker" | "manual" | "flow";
export interface CamFix {
  id: number; t: number; source: FixSource;
  phone: P2;               // phone-centre position on the floor, mm
  cam: { x: number; y: number; z: number }; heading: number; tiltDeg: number;
  rmsPx: number | null;    // reprojection error of the marker/manual fit (null for flow)
  nMarkers: number; sigma: number; inliers: number | null;
}
export interface VisionState {
  running: boolean; fps: number; procW: number; procH: number; frames: number;
  markers: { id: number; known: boolean; corners: P2[] }[];
  segs: LineResult["segs"]; lineCorners: P2[]; detectTiles: boolean;
  flowOn: boolean; flowFeatures: number; flowPathMm: number;
  anchor: "marker" | "manual" | null; fix: CamFix | null; fixCount: number; lastFixAt: number; lost: boolean; msg: string;
  trail: P2[]; fScale: number; offset: P2;
  manual: { active: boolean; region: number | "all"; pts: P2[] };
  H: Mat3 | null; frozen: HTMLCanvasElement | null;
  /** Manual floor calibration: tap -> edit (drag handles) -> locked (grid follows the floor by optical flow). */
  calib: { phase: "off" | "tap" | "edit" | "locked"; pts: P2[]; mids: (P2 | null)[]; frozen: boolean };
  calibH: Mat3 | null;                       // floor->image homography at the moment of locking / snapping (static reference)
  grout: { v: Grout | null; h: Grout | null; at: number };
  probe: P2 | null;                          // a floor point (mm) the user tapped; it is re-projected every frame
}

const MAX_W = 640, MIN_DT = 70, LOST_MS = 1200, RMS_MAX = 4, TRAIL_MAX = 3000;
const LS = "imu-tracker.vision.v1";
const wrap360 = (d: number) => ((d % 360) + 360) % 360;

class VisionEngine {
  private st: VisionState;
  private listeners = new Set<() => void>(); private frameCbs = new Set<() => void>();
  private video: HTMLVideoElement | null = null; private raf = 0; private lastRun = 0; private lastEmit = 0; private lastLines = 0; private lastGrout = 0;
  private cv = document.createElement("canvas"); private ctx = this.cv.getContext("2d", { willReadFrequently: true })!;
  private prevPyr: Gray[] | null = null; private pts: P2[] = []; private Hcur: Mat3 | null = null; private lastGood = 0; private lastCamXY: P2 | null = null;
  private fixId = 0; private fpsT: number[] = [];
  private snap: { pyr: Gray[]; img: ImageData } | null = null;

  constructor() {
    let fScale = 0.75, ox = 0, oy = 0, flowOn = false, detectTiles = true;
    try { const j = JSON.parse(localStorage.getItem(LS) || "{}"); fScale = j.fScale ?? fScale; ox = j.ox ?? 0; oy = j.oy ?? 0; flowOn = !!j.flowOn; detectTiles = j.detectTiles ?? true; } catch { /* ignore */ }
    this.st = {
      running: false, fps: 0, procW: 0, procH: 0, frames: 0, markers: [], segs: [], lineCorners: [], detectTiles, flowOn, flowFeatures: 0, flowPathMm: 0,
      anchor: null, fix: null, fixCount: 0, lastFixAt: 0, lost: false, msg: "Camera off.", trail: [], fScale, offset: { x: ox, y: oy },
      manual: { active: false, region: "all", pts: [] }, H: null, frozen: null,
      calib: { phase: "off", pts: [], mids: [null, null, null, null], frozen: true }, calibH: null, grout: { v: null, h: null, at: 0 }, probe: null
    };
  }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.st;
  onFrame = (cb: () => void) => { this.frameCbs.add(cb); return () => { this.frameCbs.delete(cb); }; };
  private set(p: Partial<VisionState>) { this.st = { ...this.st, ...p }; this.listeners.forEach((l) => l()); }
  private save() { try { localStorage.setItem(LS, JSON.stringify({ fScale: this.st.fScale, ox: this.st.offset.x, oy: this.st.offset.y, flowOn: this.st.flowOn, detectTiles: this.st.detectTiles })); } catch { /* ignore */ } }

  /* ---- settings ---- */
  setFScale(v: number) { if (v > 0.2 && v < 3) { this.set({ fScale: v }); this.save(); } }
  setOffset(o: P2) { this.set({ offset: o }); this.save(); }
  setFlow(on: boolean) { this.set({ flowOn: on }); this.save(); if (!on) { this.prevPyr = null; this.pts = []; } }
  setDetectTiles(on: boolean) { this.set({ detectTiles: on, segs: on ? this.st.segs : [], lineCorners: on ? this.st.lineCorners : [] }); this.save(); }
  resetTrail() { this.set({ trail: [] }); }
  clearAnchor() { this.Hcur = null; this.prevPyr = null; this.pts = []; this.lastCamXY = null; this.snap = null; this.set({ anchor: null, fix: null, H: null, lost: false, flowPathMm: 0, trail: [], frozen: null, calib: { phase: "off", pts: [], mids: [null, null, null, null], frozen: true }, calibH: null, grout: { v: null, h: null, at: 0 }, probe: null, msg: "Anchor and floor calibration cleared. Calibrate the floor again or show a registered marker." }); this.frameCbs.forEach((cb) => cb()); }

  /* ---- video attach ---- */
  attach(video: HTMLVideoElement) {
    this.video = video; this.prevPyr = null; this.pts = []; this.lastGood = 0;
    this.set({ running: true, frames: 0, msg: "Looking for registered markers…", lost: false });
    cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.loop);
  }
  detach() {
    cancelAnimationFrame(this.raf); this.video = null; this.prevPyr = null; this.pts = []; this.snap = null;
    this.set({ running: false, fps: 0, markers: [], segs: [], lineCorners: [], flowFeatures: 0, lost: false, frozen: null, manual: { active: false, region: "all", pts: [] }, calib: { phase: "off", pts: [], mids: [null, null, null, null], frozen: true }, calibH: null, grout: { v: null, h: null, at: 0 }, probe: null, msg: "Camera off." });
    this.frameCbs.forEach((cb) => cb());
  }

/* ---- live four-corner floor calibration ---- */
  private emptyCalib(phase: VisionState["calib"]["phase"], frozen = true): VisionState["calib"] { return { phase, pts: [], mids: [null, null, null, null], frozen }; }
  private freezeFrame() {
    const { img } = this.grab(), fz = document.createElement("canvas"); fz.width = img.width; fz.height = img.height; fz.getContext("2d")!.putImageData(img, 0, 0);
    this.snap = { img, pyr: pyramid(toGray(img), 3) }; return { fz, img };
  }
  beginCalib() {
    if (!this.video || this.video.videoWidth === 0) { this.set({ msg: "Start the camera first." }); return; }
    const { fz, img } = this.freezeFrame();
    this.set({ procW: img.width, procH: img.height, frozen: fz, calib: this.emptyCalib("tap"), grout: { v: null, h: null, at: 0 }, probe: null, msg: "Select the four outer corners of your 2×2 tile area. Tap the top-left corner first." });
    this.frameCbs.forEach((cb) => cb());
  }
  setCalibFrozen(on: boolean) {
    const c = this.st.calib; if (c.phase !== "edit" && c.phase !== "tap") return;
    if (on) { const { fz } = this.freezeFrame(); this.set({ frozen: fz, calib: { ...c, frozen: true }, msg: "Frame frozen at this moment. Corners stay where they are on the image; drag them onto the real corners." }); }
    else { this.snap = null; this.set({ frozen: null, calib: { ...c, frozen: false }, msg: "Live video. Hold the phone still while you drag the corners (or freeze the frame)." }); }
    this.frameCbs.forEach((cb) => cb());
  }
  calibTap(p: P2) {
    const c = this.st.calib; if (c.phase !== "tap" || c.pts.length >= 4) return;
    const pts = [...c.pts, p];
    if (pts.length < 4) this.set({ calib: { ...c, pts }, msg: `Tap the ${CORNER_LABEL[pts.length]} corner.` });
    else this.set({ calib: { ...c, pts, phase: "edit" }, msg: convexQuad(pts) ? "Drag any corner to fine-tune it. The two cyan handles on the edges adjust the internal tile lines. Then press Lock calibration." : "These points do not form a clockwise top-left → top-right → bottom-right → bottom-left quadrilateral. Drag the corners or press Reset corners." });
    this.frameCbs.forEach((cb) => cb());
  }
  calibUndo() { const c = this.st.calib; if (c.phase === "tap" && c.pts.length) this.set({ calib: { ...c, pts: c.pts.slice(0, -1) }, msg: `Tap the ${CORNER_LABEL[c.pts.length - 1]} corner.` }); this.frameCbs.forEach((cb) => cb()); }
  calibResetCorners() { const c = this.st.calib; if (c.phase === "edit" || c.phase === "tap") { this.set({ calib: { ...this.emptyCalib("tap", c.frozen) }, msg: "Tap the top-left corner of the 2×2 tile area." }); this.frameCbs.forEach((cb) => cb()); } }
  calibResetMids() { const c = this.st.calib; if (c.phase === "edit") { this.set({ calib: { ...c, mids: [null, null, null, null] } }); this.frameCbs.forEach((cb) => cb()); } }
  /** Handle i: 0-3 outer corners (TL,TR,BR,BL), 4-7 internal-line ends (top, right, bottom, left). */
  calibMove(i: number, p: P2) {
    const c = this.st.calib; if (c.phase !== "edit") return;
    const q = { x: Math.max(0, Math.min(this.st.procW, p.x)), y: Math.max(0, Math.min(this.st.procH, p.y)) };
    if (i < 4) { const pts = c.pts.slice(); pts[i] = q; this.set({ calib: { ...c, pts } }); }
    else { const mids = c.mids.slice(); mids[i - 4] = q; this.set({ calib: { ...c, mids } }); }
    this.frameCbs.forEach((cb) => cb());
  }
  /** Floor->image homography of the grid currently being edited (null if the quadrilateral is invalid). */
  calibEditH(): Mat3 | null { const c = this.st.calib; return c.pts.length === 4 ? fitCalib(c.pts, c.mids) : null; }
  lockCalib() {
    const c = this.st.calib; if (c.phase !== "edit") return;
    const H = this.calibEditH(); if (!H) { this.set({ msg: "The corners do not form a valid quadrilateral (order: top-left, top-right, bottom-right, bottom-left). Fix them first." }); return; }
    const pose = poseFromHomography(H, this.K()); if (!pose) { this.set({ msg: "These corners give an impossible camera pose. Check that they outline the floor in the right order." }); return; }
    const now = performance.now(); let pyr: Gray[];
    if (c.frozen && this.snap) pyr = this.snap.pyr; else { const { img } = this.grab(); pyr = pyramid(toGray(img), 3); }
    this.snap = null; this.Hcur = H; this.lastGood = now; this.lastCamXY = null; this.prevPyr = pyr; this.pts = detectFeatures(pyr[0], 90, 28);
    this.st.flowOn || this.setFlow(true);
    this.publishFix("manual", H, pose, null, 0, now, 40);
    this.set({ frozen: null, calib: { ...c, phase: "locked", frozen: false }, calibH: H, H, anchor: "manual", lost: false, flowPathMm: 0, grout: { v: null, h: null, at: 0 }, msg: "Calibration locked. The grid now follows the floor by optical flow (it can drift). Position fixed from your four corners." });
    this.frameCbs.forEach((cb) => cb());
  }
  /** Re-open the locked grid for editing: the corners are placed where the grid is on the current frame. */
  editCalib() {
    const H = this.Hcur ?? this.st.calibH; if (!H || !this.video) { this.set({ msg: "Nothing to edit. Calibrate the floor first." }); return; }
    const { fz, img } = this.freezeFrame(), wc = worldCorners();
    this.set({ procW: img.width, procH: img.height, frozen: fz, calib: { phase: "edit", pts: wc.map((w) => apply(H, w)), mids: [null, null, null, null], frozen: true }, msg: "Editing: the frame is frozen. Drag the handles onto the real tile corners and grout lines, then Lock calibration." });
    this.frameCbs.forEach((cb) => cb());
  }
  /** Apply the automatically detected grout lines (only those that were detected with confidence) to the current grid. */
  snapGrout() {
    const H = this.Hcur, g = this.st.grout; if (!H || !g.v && !g.h) return;
    const wc = worldCorners(), wm = worldMids(), src = [...wc], dst = wc.map((w) => apply(H, w));
    const lines: (Grout | null)[] = [g.v?.ok ? g.v : null, g.h?.ok ? g.h : null, g.v?.ok ? g.v : null, g.h?.ok ? g.h : null];
    let n = 0;
    wm.forEach((w, i) => { const gr = lines[i]; if (!gr) return; const p = apply(H, w); for (let k = 0; k < 3; k++) { src.push(w); dst.push({ x: p.x + gr.offPx * gr.n.x, y: p.y + gr.offPx * gr.n.y }); } n++; });
    if (!n) { this.set({ msg: "No grout line was detected with enough confidence, so the grid was left unchanged." }); return; }
    const H2 = homography(src, dst), pose = H2 ? poseFromHomography(H2, this.K()) : null;
    if (!H2 || !pose) { this.set({ msg: "Snapping would give an invalid grid; the grid was left unchanged." }); return; }
    this.Hcur = H2; this.lastCamXY = null; this.set({ H: H2, calibH: H2, grout: { v: null, h: null, at: 0 }, msg: `Grid moved onto ${n / 2} detected grout line${n > 2 ? "s" : ""}.` });
    this.frameCbs.forEach((cb) => cb());
  }
  /** Tap on the video after locking: maps that image point onto the floor plane with the current grid. */
  probeAt(p: P2) {
    const H = this.Hcur; if (!H) return; const Hi = inv3(H); if (!Hi) return;
    const f = apply(Hi, p); this.set({ probe: Number.isFinite(f.x + f.y) ? f : null }); this.frameCbs.forEach((cb) => cb());
  }
  clearProbe() { this.set({ probe: null }); this.frameCbs.forEach((cb) => cb()); }

  /* ---- manual corner selection ---- */
  beginManual(region: number | "all") {
    if (!this.video || this.video.videoWidth === 0) { this.set({ msg: "Start the camera first." }); return; }
    const { img } = this.grab();
    const fz = document.createElement("canvas"); fz.width = img.width; fz.height = img.height; fz.getContext("2d")!.putImageData(img, 0, 0);
    this.snap = { img, pyr: pyramid(toGray(img), 3) };
    const lr = this.st.detectTiles ? detectLines(this.snap.pyr[1]) : null;
    this.set({ manual: { active: true, region, pts: [] }, frozen: fz, segs: lr ? lr.segs.map((s) => ({ ...s, a: { x: s.a.x * 2, y: s.a.y * 2 }, b: { x: s.b.x * 2, y: s.b.y * 2 } })) : [], lineCorners: lr ? lr.corners.map((c) => ({ x: c.x * 2, y: c.y * 2 })) : [], msg: `Frame frozen. Tap the ${this.regionCorners(region).names[0]} corner first.` });
    this.frameCbs.forEach((cb) => cb());
  }
  cancelManual() { this.snap = null; this.set({ manual: { active: false, region: this.st.manual.region, pts: [] }, frozen: null, msg: "Manual selection cancelled." }); this.frameCbs.forEach((cb) => cb()); }
  undoManual() { const m = this.st.manual; if (m.active && m.pts.length) this.set({ manual: { ...m, pts: m.pts.slice(0, -1) } }); this.frameCbs.forEach((cb) => cb()); }
  /** Corner order: floor coordinates of the region's corners, bottom-left first, then counter-clockwise (as seen on the floor plan). */
  regionCorners(region: number | "all") {
    const { tileL, tileB, roomL, roomB } = FLOOR, cols = Math.ceil(roomL / tileL);
    let x0 = 0, y0 = 0, x1 = roomL, y1 = roomB, label = "the whole 1200 × 1200 mm floor";
    if (region !== "all") { const r = Math.floor(region / cols), c = region % cols; x0 = c * tileL; y0 = r * tileB; x1 = x0 + tileL; y1 = y0 + tileB; label = `tile R${r + 1}C${c + 1}`; }
    return { world: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], names: [`bottom-left (X ${x0}, Y ${y0})`, `bottom-right (X ${x1}, Y ${y0})`, `top-right (X ${x1}, Y ${y1})`, `top-left (X ${x0}, Y ${y1})`], label };
  }
  addManualPoint(p: P2) {
    const m = this.st.manual; if (!m.active || m.pts.length >= 4) return;
    let q = p, snapped = false;
    for (const c of this.st.lineCorners) if (Math.hypot(c.x - p.x, c.y - p.y) < 18 && (!snapped || Math.hypot(c.x - p.x, c.y - p.y) < Math.hypot(q.x - p.x, q.y - p.y))) { q = c; snapped = true; }
    const pts = [...m.pts, q], rc = this.regionCorners(m.region);
    if (pts.length < 4) { this.set({ manual: { ...m, pts }, msg: `Tap the ${rc.names[pts.length]} corner${snapped ? " (last tap snapped to a detected corner)" : ""}.` }); this.frameCbs.forEach((cb) => cb()); return; }
    const H = homography(rc.world, pts);
    const snap = this.snap; this.snap = null;
    if (!H) { this.set({ manual: { active: false, region: m.region, pts: [] }, frozen: null, msg: "Those four points do not form a valid quadrilateral. Try again." }); return; }
    const now = performance.now(), pose = poseFromHomography(H, this.K());
    if (!pose) { this.set({ manual: { active: false, region: m.region, pts: [] }, frozen: null, msg: "The tapped corners give an impossible camera pose (check the order: bottom-left, bottom-right, top-right, top-left)." }); return; }
    this.Hcur = H; this.lastGood = now;
    this.prevPyr = snap ? snap.pyr : null; this.pts = this.prevPyr ? detectFeatures(this.prevPyr[0], 90, 28) : [];
    this.lastCamXY = null;
    this.publishFix("manual", H, pose, null, 0, now, 40);
    this.set({ manual: { active: false, region: m.region, pts: [] }, frozen: null, anchor: "manual", H, lost: false, msg: `Position fixed from the four corners of ${rc.label}. ` + (this.st.flowOn ? "Optical flow now follows the floor from this fix (drifts)." : "Enable optical flow to keep following after you move.") });
    this.frameCbs.forEach((cb) => cb());
  }

  /* ---- processing ---- */
  private K() { const w = this.st.procW || 640, h = this.st.procH || 480; return { f: this.st.fScale * w, cx: w / 2, cy: h / 2 }; }
  private grab(): { img: ImageData } {
    const v = this.video!, w = Math.min(MAX_W, v.videoWidth), h = Math.round((v.videoHeight * w) / v.videoWidth);
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    this.ctx.drawImage(v, 0, 0, w, h);
    return { img: this.ctx.getImageData(0, 0, w, h) };
  }
  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const v = this.video; if (!v || v.readyState < 2 || v.videoWidth === 0 || now - this.lastRun < MIN_DT || this.st.manual.active || this.st.calib.phase === "tap" || (this.st.calib.phase === "edit" && this.st.calib.frozen)) return;
    this.lastRun = now;
    try { this.process(now); } catch (e) { this.set({ msg: "Vision error: " + (e as Error).message }); }
  };
  private process(now: number) {
    const { img } = this.grab(), w = img.width, h = img.height;
    this.fpsT.push(now); while (this.fpsT.length > 12) this.fpsT.shift();
    const fps = this.fpsT.length > 1 ? ((this.fpsT.length - 1) * 1000) / (now - this.fpsT[0]) : 0;
    const defs = markerRegistry.getSnapshot(), byId = new Map(defs.map((d) => [d.id, d]));
    const found: Detected[] = detectMarkers(img);
    const markers = found.map((m) => ({ id: m.id, known: byId.has(m.id), corners: m.corners }));
    const patch: Partial<VisionState> = { markers, procW: w, procH: h, fps, frames: this.st.frames + 1 };

    // grayscale pyramid for flow / lines
    const pyr = (this.st.flowOn || this.st.detectTiles || this.st.calib.phase === "locked") ? pyramid(toGray(img), 3) : null;
    if (this.st.detectTiles && pyr && now - this.lastLines > 450) {
      this.lastLines = now; const lr = detectLines(pyr[1]);
      // marker patterns produce many straight edges of their own; hide lines/corners that lie on a detected marker
      const box = markers.map((m) => { const xs = m.corners.map((c) => c.x), ys = m.corners.map((c) => c.y), pad = 0.25 * (Math.max(...xs) - Math.min(...xs)); return { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, y0: Math.min(...ys) - pad, y1: Math.max(...ys) + pad }; });
      const inBox = (p: P2) => box.some((b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1);
      patch.segs = lr.segs.map((s) => ({ ...s, a: { x: s.a.x * 2, y: s.a.y * 2 }, b: { x: s.b.x * 2, y: s.b.y * 2 } })).filter((s) => !(inBox(s.a) && inBox(s.b)));
      patch.lineCorners = lr.corners.map((c) => ({ x: c.x * 2, y: c.y * 2 })).filter((c) => !inBox(c));
    }

    // 1) absolute fix from registered markers
    const src: P2[] = [], dst: P2[] = []; let nUse = 0;
    for (const m of found) { const d = byId.get(m.id); if (!d) continue; nUse++; markerWorldCorners(d).forEach((p, i) => { src.push(p); dst.push(m.corners[i]); }); }
    let fixed = false;
    if (nUse) {
      const H = homography(src, dst), rms = H ? rmsError(H, src, dst) : Infinity, pose = H ? poseFromHomography(H, this.K()) : null;
      if (H && pose && rms <= RMS_MAX * (w / 640)) {
        this.Hcur = H; this.lastGood = now; fixed = true; this.lastCamXY = null;
        this.publishFix("marker", H, pose, rms, nUse, now, null, patch);
        patch.anchor = "marker"; patch.H = H; patch.lost = false; patch.msg = `Fix from ${nUse} registered marker${nUse > 1 ? "s" : ""} (reprojection error ${rms.toFixed(2)} px).`;
        if (pyr && this.st.flowOn) { this.prevPyr = pyr; this.pts = detectFeatures(pyr[0], 90, 28); }
      } else if (H && pose) patch.msg = `Marker fit rejected: reprojection error ${rms.toFixed(1)} px is too large (wrong marker coordinates or a misread marker).`;
    }

    // 2) optical-flow propagation from the latest anchor (drifts)
    if (!fixed && this.st.flowOn && this.Hcur && pyr) {
      const r = this.prevPyr && this.pts.length >= 8 ? this.flowStep(pyr) : null;
      if (r) {
        this.Hcur = mul3(r.Hrel, this.Hcur); const pose = poseFromHomography(this.Hcur, this.K());
        if (pose) {
          this.lastGood = now; fixed = true;
          const path = this.lastCamXY ? Math.hypot(pose.cam.x - this.lastCamXY.x, pose.cam.y - this.lastCamXY.y) : 0; this.lastCamXY = { x: pose.cam.x, y: pose.cam.y };
          const total = this.st.flowPathMm + path;
          this.publishFix("flow", this.Hcur, pose, null, 0, now, r.inliers, patch, 30 + 0.08 * total);
          patch.flowPathMm = total; patch.H = this.Hcur; patch.lost = false; patch.msg = "Following the floor by optical flow. Position drifts; show a registered marker to correct it.";
        }
        this.pts = r.next; if (this.pts.length < 40) this.pts = this.pts.concat(detectFeatures(pyr[0], 90 - this.pts.length, 28, this.pts));
        patch.flowFeatures = this.pts.length;
      } else { this.pts = detectFeatures(pyr[0], 90, 28); patch.flowFeatures = this.pts.length; }
      this.prevPyr = pyr;
    }
    // 3) lost?
    if (!fixed && this.st.anchor !== null || (!fixed && this.st.fix)) {
      if (now - this.lastGood > LOST_MS) {
        patch.lost = true; patch.H = null;
        patch.msg = this.st.flowOn ? "Camera tracking LOST: no registered marker in view and optical flow has too few matches. Position is held at the last fix." : "Camera tracking LOST: no registered marker in view. Position is held at the last fix.";
        if (!this.st.flowOn) this.Hcur = null;
      }
    } else if (!fixed && !this.st.fix) patch.msg = markers.length ? (markers.some((m) => m.known) ? patch.msg ?? this.st.msg : "Markers seen, but none is registered in the calibration table.") : "No marker in view. Show a registered marker or use manual tile corners.";
    // 4) automatic grout check of the locked grid (never moves the grid by itself)
    if (this.st.calib.phase === "locked" && pyr && this.Hcur && fixed && now - this.lastGrout > 500) {
      this.lastGrout = now; patch.grout = { v: detectGrout(pyr[0], this.Hcur, "v"), h: detectGrout(pyr[0], this.Hcur, "h"), at: Date.now() };
    }
    this.set(patch);
    this.frameCbs.forEach((cb) => cb());
  }
  private flowStep(next: Gray[]) {
    const { out, ok } = trackLK(this.prevPyr!, next, this.pts);
    const a: P2[] = [], b: P2[] = [];
    out.forEach((q, i) => { if (ok[i]) { a.push(this.pts[i]); b.push(q); } });
    const r = ransacHomography(a, b, 2.0 * (next[0].w / 640)); if (!r || r.n < 10) return null;
    // plausibility: a hand-held camera cannot jump more than ~35% of the frame between frames
    const c = apply(r.H, { x: next[0].w / 2, y: next[0].h / 2 }); if (Math.hypot(c.x - next[0].w / 2, c.y - next[0].h / 2) > next[0].w * 0.35) return null;
    return { Hrel: r.H, inliers: r.n, next: b.filter((_, i) => r.inliers[i]) };
  }
  private publishFix(source: FixSource, H: Mat3, pose: Pose, rms: number | null, nMarkers: number, now: number, inliers: number | null, patch?: Partial<VisionState>, sigmaOverride?: number) {
    const hd = (pose.heading * Math.PI) / 180, o = this.st.offset;
    // the camera is not at the phone's centre: move back by the offset expressed in the phone frame (x right, y toward the top edge)
    const phone = { x: pose.cam.x - (o.x * Math.cos(hd) + o.y * Math.sin(hd)), y: pose.cam.y - (-o.x * Math.sin(hd) + o.y * Math.cos(hd)) };
    const { f } = this.K(), z = pose.cam.z, tilt = Math.min(60, pose.tiltDeg);
    // simple error model (a planning figure, not a measurement): corner noise projected to the floor + marker placement + focal-length uncertainty on tilted views
    const sigma = sigmaOverride ?? Math.sqrt((2 * Math.max(0.7, rms ?? 1) * z / f) ** 2 + 10 ** 2 + (z * Math.tan((tilt * Math.PI) / 180) * 0.15) ** 2);
    const fix: CamFix = { id: ++this.fixId, t: Date.now(), source, phone, cam: pose.cam, heading: wrap360(pose.heading), tiltDeg: pose.tiltDeg, rmsPx: rms, nMarkers, sigma, inliers };
    const tr = this.st.trail, last = tr[tr.length - 1];
    const trail = !last || Math.hypot(last.x - phone.x, last.y - phone.y) > 5 ? [...tr, phone].slice(-TRAIL_MAX) : tr;
    const p = { fix, fixCount: this.st.fixCount + 1, lastFixAt: now, trail, anchor: this.st.anchor };
    if (patch) Object.assign(patch, p); else this.set(p);
  }
}

export const vision = new VisionEngine();
export type { MarkerDef };
