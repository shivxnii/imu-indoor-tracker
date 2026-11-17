import { manager, Sample } from "../sensors/sensorManager";
import { Config, Pt, gridSize } from "./grid";

/*
 * POSITIONING ENGINE (reads only the real samples published by sensors/sensorManager.ts)
 *
 * Heading H is in degrees, clockwise from the floor's +Y axis:  X += d*sin(H),  Y += d*cos(H).
 * The starting position and starting heading are DECLARED by the user. An IMU cannot discover an absolute location.
 *
 * Heading   : gyroscope yaw rate (about the phone's Z axis) is integrated, then pulled gently toward the
 *             orientation-sensor yaw (alpha) and, weakly, toward the compass. Only used while the phone is held roughly flat.
 * Movement  : "walking" mode detects steps from the accelerometer and advances the position one step at a time.
 *             "sliding" mode never changes the position automatically, because step detection does not measure sliding.
 * Uncertainty: a simple model (step-length error + heading bias). It is a planning figure, NOT a measured accuracy.
 *
 * All step parameters below are untested starting values. Replace this class with a camera/AprilTag estimator later
 * by keeping the same TState fields and methods.
 */

export type Status = "not-calibrated" | "ready" | "tracking" | "paused";
export type MoveMode = "walking" | "sliding";
export interface ReturnCheck { dx: number; dy: number; dist: number; steps: number; at: string }
export interface TState {
  cfg: Config; cols: number; rows: number;
  start: Pt; startHeading: number;
  status: Status; busy: boolean; msg: string;
  pos: Pt | null; heading: number | null; headingSrc: string; compassUsed: boolean;
  trail: Pt[]; steps: number; distance: number; sigma: number | null;
  mode: MoveMode; stepLen: number; clamped: boolean; returnCheck: ReturnCheck | null;
}

export const FLOOR: Config = { roomL: 1200, roomB: 1200, tileL: 600, tileB: 600 };
const STEP_THRESHOLD = 1.2;   // m/s² above the slow baseline
const STEP_MIN_GAP_MS = 350;
const REF_AMPLITUDE = 3;      // m/s² peak-to-valley that maps to the nominal step length
const START_SIGMA = 50;       // mm, tolerance of placing the phone on the declared start point
const MAX_TRAIL = 5000;
const PROCESS_NOISE = 40;     // mm per sqrt(second): how fast the IMU-only estimate loses certainty (used only when fusing with a camera)
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const wrap360 = (d: number) => ((d % 360) + 360) % 360;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class Tracker {
  private st: TState;
  private listeners = new Set<() => void>();
  private a0: number | null = null; private c0: number | null = null; private h0 = 0; private H = 0;
  private be = 0; private ga = 0; private al: number | null = null;
  private lastG = 0; private lastEmit = 0; private sigmaT = 0;
  private base = 0; private baseInit = false; private sm = 0; private above = false; private lastStep = 0; private wMax = -1e9; private wMin = 1e9;

  constructor() {
    const { cols, rows } = gridSize(FLOOR);
    this.st = {
      cfg: FLOOR, cols, rows, start: { x: 300, y: 300 }, startHeading: 0, status: "not-calibrated", busy: false,
      msg: "Not calibrated. Position is unknown until you calibrate.", pos: null, heading: null, headingSrc: "–", compassUsed: false,
      trail: [], steps: 0, distance: 0, sigma: null, mode: "walking", stepLen: 600, clamped: false, returnCheck: null
    };
    manager.onSample((s) => this.onSample(s));
  }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.st;
  private set(p: Partial<TState>) { this.st = { ...this.st, ...p }; this.listeners.forEach((l) => l()); }

  /* ---- setup ---- */
  setStart(p: Pt) {
    if (this.st.status === "tracking") return;
    const { roomL, roomB } = this.st.cfg;
    this.set({ start: { x: Math.round(clamp(p.x, 0, roomL)), y: Math.round(clamp(p.y, 0, roomB)) } });
  }
  setStartHeading(deg: number) { if (this.st.status !== "tracking") this.set({ startHeading: wrap360(Number.isFinite(deg) ? deg : 0) }); }
  setStepLen(mm: number) { if (mm > 0) this.set({ stepLen: mm }); }
  setMode(m: MoveMode) {
    this.set({ mode: m, sigma: m === "walking" && this.st.status !== "not-calibrated" ? this.st.sigma ?? START_SIGMA : null,
      msg: m === "sliding" ? "Sliding mode: step detection is off. Position changes only when you place it manually. Use a camera or AprilTag reference for real sliding tracking." : this.st.msg });
  }

  /* ---- calibration ---- */
  private flat() { return Math.abs(this.be) < 50 && Math.abs(this.ga) < 50; }

  async calibrate() {
    if (!manager.isRunning()) { this.set({ msg: "Start the sensors first." }); return; }
    this.set({ busy: true, status: "not-calibrated", msg: "Hold the phone still and flat on the start point, top edge facing the chosen heading. Reading for 2 s…" });
    const d = await manager.collect(2000);
    if (d.ori.length < 5 || d.acc.length < 5) { this.set({ busy: false, msg: `Not enough live readings (orientation ${d.ori.length}, accelerometer ${d.acc.length}). Calibration was not completed.` }); return; }
    const spread = sd(d.acc.map((v) => Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0)));
    if (spread > 0.5) { this.set({ busy: false, msg: `The phone moved during calibration (variation ${spread.toFixed(2)} m/s²). Hold it still and try again.` }); return; }
    const o = d.ori[d.ori.length - 1];
    if (Math.abs(o[1] ?? 0) > 30 || Math.abs(o[2] ?? 0) > 30) { this.set({ busy: false, msg: "Hold the phone flat (screen up) during calibration, then try again." }); return; }
    this.a0 = o[0] as number; this.al = this.a0; this.be = o[1] as number; this.ga = o[2] as number;
    this.c0 = d.cmp.length ? (d.cmp[d.cmp.length - 1][0] as number) : null;
    this.h0 = this.st.startHeading; this.H = this.h0; this.lastG = 0;
    this.set({
      busy: false, status: "ready", pos: { ...this.st.start }, heading: this.h0, headingSrc: "calibrated", compassUsed: false,
      trail: [{ ...this.st.start }], steps: 0, distance: 0, sigma: this.st.mode === "walking" ? START_SIGMA : null, clamped: false, returnCheck: null,
      msg: `Calibrated at X ${this.st.start.x}, Y ${this.st.start.y} mm facing ${this.h0.toFixed(0)}°. ` + (this.c0 === null ? "No compass reading, so heading uses gyroscope and orientation only." : "Compass reference captured.")
    });
  }
  recalibrate() { this.set({ status: "not-calibrated", pos: null, heading: null, trail: [], steps: 0, distance: 0, sigma: null, returnCheck: null, msg: "Choose a start point and heading, place the phone there, then calibrate." }); }

  /* ---- tracking control ---- */
  startTracking() {
    if (this.st.status !== "ready") return;
    this.baseInit = false; this.sm = 0; this.above = false; this.wMax = -1e9; this.wMin = 1e9;
    this.set({ status: "tracking", msg: this.st.mode === "walking" ? "Tracking. Carry the phone flat in front of you and walk." : "Tracking in sliding mode: position does not change automatically." });
  }
  pause() { if (this.st.status === "tracking") this.set({ status: "paused", msg: "Paused. Steps are ignored." }); }
  resume() { if (this.st.status === "paused") { this.baseInit = false; this.set({ status: "tracking", msg: "Tracking resumed." }); } }
  resetPosition() {
    if (this.st.status === "not-calibrated") return;
    const s = this.st.start;
    this.H = this.a0 !== null && this.al !== null && this.flat() ? wrap360(this.h0 + wrap180(this.a0 - this.al)) : this.h0;
    this.set({ status: "ready", pos: { ...s }, trail: [{ ...s }], steps: 0, distance: 0, sigma: this.st.mode === "walking" ? START_SIGMA : null, clamped: false, returnCheck: null, heading: this.H, msg: "Position reset to the calibration start point. Press Start Tracking to continue." });
  }
  clearTrail() { this.set({ trail: this.st.pos ? [{ ...this.st.pos }] : [] }); }
  setManual(p: Pt) {
    if (this.st.status === "not-calibrated") return;
    const q = { x: Math.round(clamp(p.x, 0, this.st.cfg.roomL)), y: Math.round(clamp(p.y, 0, this.st.cfg.roomB)) };
    this.set({ pos: q, trail: [...this.st.trail, q].slice(-MAX_TRAIL), sigma: null, clamped: false, msg: "Position placed manually." });
  }
  /**
   * Absolute position observation from the camera (a registered marker or manually selected tile corners).
   * If the engine has no position yet it is initialised from the camera. Otherwise the fix is blended in proportion to the two
   * uncertainties (a 2-D Kalman-style gain), and the camera heading pulls the IMU heading. The IMU orientation reference (h0) is shifted by
   * the same amount, so the correction is not undone by the orientation sensor on the next sample.
   */
  applyExternalFix(f: { pos: Pt; sigma: number; heading: number | null }): { kind: "init" | "blend" | "reacquire"; gain: number; innovation: number } {
    const st = this.st, { roomL, roomB } = st.cfg;
    const q = { x: clamp(f.pos.x, 0, roomL), y: clamp(f.pos.y, 0, roomB) };
    if (st.status === "not-calibrated" && !st.busy) {
      this.a0 = this.al; this.c0 = null; this.h0 = f.heading ?? st.startHeading; this.H = this.h0; this.lastG = 0;
      this.baseInit = false; this.sm = 0; this.above = false; this.wMax = -1e9; this.wMin = 1e9; this.sigmaT = performance.now();
      this.set({ status: "tracking", pos: q, heading: this.H, headingSrc: "camera fix", compassUsed: false, trail: [q], steps: 0, distance: 0, sigma: f.sigma, clamped: false, returnCheck: null,
        msg: `Initialised from a camera fix at X ${q.x.toFixed(0)}, Y ${q.y.toFixed(0)} mm. IMU steps now continue from here.` });
      return { kind: "init", gain: 1, innovation: 0 };
    }
    if (!st.pos) return { kind: "blend", gain: 0, innovation: 0 };
    // Without a camera fix the IMU estimate becomes less certain with time even when no step is detected (sliding, missed steps).
    const now = performance.now(), dt = Math.min(30, Math.max(0, (now - this.sigmaT) / 1000)); this.sigmaT = now;
    const sT = Math.sqrt((st.sigma ?? 150) ** 2 + PROCESS_NOISE ** 2 * dt);
    const innovation = Math.hypot(q.x - st.pos.x, q.y - st.pos.y);
    if (f.heading !== null) { const d = 0.5 * wrap180(f.heading - this.H); this.H = wrap360(this.H + d); this.h0 = wrap360(this.h0 + d); }
    // Gate: if IMU and camera disagree by more than 3 combined standard deviations, the IMU estimate is not credible; take the camera.
    if (innovation > 3 * Math.sqrt(sT * sT + f.sigma * f.sigma)) {
      this.set({ pos: q, trail: [...st.trail, q].slice(-MAX_TRAIL), sigma: f.sigma, clamped: false, heading: this.H, headingSrc: f.heading !== null ? "IMU corrected by camera" : st.headingSrc });
      return { kind: "reacquire", gain: 1, innovation };
    }
    const gain = (sT * sT) / (sT * sT + f.sigma * f.sigma);
    const p = { x: st.pos.x + gain * (q.x - st.pos.x), y: st.pos.y + gain * (q.y - st.pos.y) };
    this.set({ pos: p, trail: [...st.trail, p].slice(-MAX_TRAIL), sigma: Math.sqrt((sT * sT * f.sigma * f.sigma) / (sT * sT + f.sigma * f.sigma)), clamped: false, heading: this.H, headingSrc: f.heading !== null ? "IMU corrected by camera" : st.headingSrc });
    return { kind: "blend", gain, innovation };
  }
  recordReturnCheck() {
    const { pos, start, steps } = this.st;
    if (!pos || this.st.status === "not-calibrated") return;
    const dx = pos.x - start.x, dy = pos.y - start.y;
    this.set({ returnCheck: { dx, dy, dist: Math.hypot(dx, dy), steps, at: new Date().toLocaleTimeString() } });
  }

  /* ---- sensor input ---- */
  private onSample(s: Sample) {
    if (this.st.status === "not-calibrated" && !this.st.busy) { if (s.k === "ori") this.trackAttitude(s); return; }
    if (s.k === "ori") this.onOri(s);
    else if (s.k === "gyro") this.onGyro(s);
    else if (s.k === "cmp") this.onCmp(s);
    else if (s.k === "acc") this.onAcc(s);
  }
  private trackAttitude(s: Sample) { this.al = s.v[0]; this.be = s.v[1] ?? 0; this.ga = s.v[2] ?? 0; }
  private emitHeading(t: number, src: string) {
    if (t - this.lastEmit < 100) return;
    this.lastEmit = t; this.set({ heading: this.H, headingSrc: src });
  }
  private onOri(s: Sample) {
    if (s.v[0] === null) return;
    this.al = s.v[0]; this.be = s.v[1] ?? 0; this.ga = s.v[2] ?? 0;
    if (this.a0 === null || this.st.status === "not-calibrated") return;
    if (!this.flat()) { this.emitHeading(s.t, "held (phone not flat)"); return; }
    const ho = this.h0 + wrap180(this.a0 - s.v[0]); // alpha grows counter-clockwise; heading grows clockwise
    this.H = wrap360(this.H + 0.03 * wrap180(ho - this.H));
    this.emitHeading(s.t, this.c0 !== null ? "gyroscope + orientation + compass" : "gyroscope + orientation");
  }
  private onGyro(s: Sample) {
    if (this.st.status === "not-calibrated" || s.v[2] === null) return;
    const dt = (s.t - this.lastG) / 1000; this.lastG = s.t;
    if (dt <= 0 || dt > 0.2 || !this.flat()) return;
    const dps = manager.unit("gyro") === "rad/s" ? s.v[2] * 57.29578 : s.v[2]; // rate about the phone's Z axis, counter-clockwise positive
    this.H = wrap360(this.H - dps * dt);
  }
  private onCmp(s: Sample) {
    if (this.c0 === null || s.v[0] === null || this.st.status === "not-calibrated" || !this.flat()) return;
    const hc = this.h0 + wrap180(s.v[0] - this.c0);
    const diff = wrap180(hc - this.H);
    if (Math.abs(diff) < 30) { this.H = wrap360(this.H + 0.01 * diff); if (!this.st.compassUsed) this.set({ compassUsed: true }); } // large disagreements are treated as magnetic disturbance
  }
  private onAcc(s: Sample) {
    const st = this.st;
    if (st.status !== "tracking" || st.mode !== "walking" || !st.pos || this.al === null) return;
    const m = Math.hypot(s.v[0] ?? 0, s.v[1] ?? 0, s.v[2] ?? 0);
    if (!this.baseInit) { this.base = m; this.baseInit = true; }
    this.base += 0.02 * (m - this.base);
    this.sm += 0.3 * (m - this.base - this.sm);
    this.wMax = Math.max(this.wMax, this.sm); this.wMin = Math.min(this.wMin, this.sm);
    const up = this.sm > STEP_THRESHOLD;
    const fire = up && !this.above && s.t - this.lastStep > STEP_MIN_GAP_MS;
    this.above = up;
    if (!fire) return;
    this.lastStep = s.t;
    const amp = Math.max(0.5, this.wMax - this.wMin); this.wMax = -1e9; this.wMin = 1e9;
    const L = st.stepLen * clamp(Math.pow(amp / REF_AMPLITUDE, 0.25), 0.7, 1.3); // step length scales weakly with bounce amplitude
    const th = (this.H * Math.PI) / 180;
    const nx = st.pos.x + L * Math.sin(th), ny = st.pos.y + L * Math.cos(th);
    const p = { x: clamp(nx, 0, st.cfg.roomL), y: clamp(ny, 0, st.cfg.roomB) };
    const sigma = Math.sqrt((st.sigma ?? START_SIGMA) ** 2 + (0.15 * L) ** 2) + 0.05 * L;
    this.sigmaT = performance.now();
    this.set({ pos: p, trail: [...st.trail, p].slice(-MAX_TRAIL), steps: st.steps + 1, distance: st.distance + L, sigma, clamped: p.x !== nx || p.y !== ny, heading: this.H });
  }
}

export const tracker = new Tracker();
