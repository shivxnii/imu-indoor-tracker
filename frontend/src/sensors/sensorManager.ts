// Single real-sensor acquisition module. Both the diagnostics page and the tile tracker read from here.
// Every value comes from an event fired by the phone's browser. Nothing is generated.

export type SensorKey = "acc" | "gyro" | "ori" | "mag" | "cmp";
export type Tone = "ok" | "warn" | "bad" | "mute";
export const NAMES: Record<SensorKey, string> = {
  acc: "Accelerometer",
  gyro: "Gyroscope",
  ori: "Device orientation",
  mag: "Magnetometer",
  cmp: "Compass heading"
};
export const KEYS = Object.keys(NAMES) as SensorKey[];
export const MAX_ROWS = 100000;
export const SESSION_ID: string =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "s" + Date.now().toString(36) + Math.random().toString(36).slice(2);

export type Vec = (number | null)[];
export interface Sample { k: SensorKey; src: string; kind: string; unit: string; v: Vec; t: number; iso: string }
export type Collected = Record<SensorKey, Vec[]>;

interface Internal { n: number; last: number; times: number[]; src: string; kind: string; unit: string; v: Vec; wall: string; err: string }
export interface SensorView {
  key: SensorKey; name: string; status: string; tone: Tone; v: Vec; unit: string; src: string;
  kind: string; hz: number | null; count: number; last: string; error: string; hint: string;
}
export interface Snapshot { running: boolean; views: SensorView[]; errors: string[]; perm: Record<string, string>; logOn: boolean; logCount: number }

const fresh = (): Internal => ({ n: 0, last: 0, times: [], src: "", kind: "", unit: "", v: [null, null, null], wall: "", err: "" });
const freshAll = (): Record<SensorKey, Internal> => ({ acc: fresh(), gyro: fresh(), ori: fresh(), mag: fresh(), cmp: fresh() });
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const GENERIC: Partial<Record<SensorKey, string>> = { acc: "Accelerometer", gyro: "Gyroscope", mag: "Magnetometer" };

class SensorManager {
  private S = freshAll();
  private running = false;
  private startedAt = 0;
  private errors: string[] = [];
  private gens: { stop(): void }[] = [];
  private perm: Record<string, string> = {};
  private logOn = false;
  rows: Sample[] = [];
  private listeners = new Set<() => void>();
  private sampleListeners = new Set<(s: Sample) => void>();
  private snap: Snapshot;

  constructor() {
    this.snap = this.build();
    setInterval(() => { this.snap = this.build(); this.listeners.forEach((l) => l()); }, 200);
  }

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.snap;
  onSample(l: (s: Sample) => void) { this.sampleListeners.add(l); return () => { this.sampleListeners.delete(l); }; }
  isRunning() { return this.running; }
  unit(k: SensorKey) { return this.S[k].unit; }

  private rec(k: SensorKey, src: string, a: number | null, b: number | null, c: number | null, kind: string, unit: string) {
    const s = this.S[k];
    if (s.src && s.src !== src) return; // first source to deliver wins; sources are never mixed
    s.src = src;
    const now = performance.now();
    s.v = [a, b, c]; s.kind = kind || s.kind; s.unit = unit || s.unit; s.n++; s.last = now; s.wall = new Date().toISOString();
    s.times.push(now); if (s.times.length > 60) s.times.shift();
    const smp: Sample = { k, src, kind: s.kind, unit: s.unit, v: [a, b, c], t: now, iso: s.wall };
    if (this.logOn && this.rows.length < MAX_ROWS) this.rows.push(smp);
    this.sampleListeners.forEach((l) => l(smp));
  }

  private addErr(k: SensorKey, api: string, msg: string) {
    const line = new Date().toLocaleTimeString() + "  " + api + ": " + msg;
    if (!this.errors.includes(line) && this.errors.length < 30) this.errors.push(line);
    this.S[k].err = msg;
  }

  private onMotion = (e: DeviceMotionEvent) => {
    const a = e.acceleration, g = e.accelerationIncludingGravity, r = e.rotationRate;
    if (a && isNum(a.x) && isNum(a.y) && isNum(a.z)) this.rec("acc", "DeviceMotion", a.x, a.y, a.z, "gravity removed", "m/s²");
    else if (g && isNum(g.x) && isNum(g.y) && isNum(g.z)) this.rec("acc", "DeviceMotion", g.x, g.y, g.z, "gravity included", "m/s²");
    // DeviceMotion rotationRate: beta = about X, gamma = about Y, alpha = about Z (degrees/second)
    if (r && isNum(r.alpha) && isNum(r.beta) && isNum(r.gamma)) this.rec("gyro", "DeviceMotion", r.beta, r.gamma, r.alpha, "", "°/s");
  };
  private onOrient = (e: DeviceOrientationEvent) => {
    if (isNum(e.alpha) && isNum(e.beta) && isNum(e.gamma)) this.rec("ori", "deviceorientation", e.alpha, e.beta, e.gamma, e.absolute ? "absolute" : "relative to arbitrary start", "°");
    const h = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
    if (isNum(h)) this.rec("cmp", "webkitCompassHeading (iOS)", h, null, null, "magnetic heading from the device", "°");
  };
  private onOrientAbs = (e: DeviceOrientationEvent) => {
    if (e.absolute && isNum(e.alpha)) this.rec("cmp", "deviceorientationabsolute", (360 - e.alpha) % 360, null, null, "derived from absolute alpha (phone held flat)", "°");
  };

  private gen(k: SensorKey, opt: Record<string, unknown>, unit: string, kind: string) {
    const cls = GENERIC[k]!;
    const Ctor = (window as any)[cls];
    if (!Ctor) return;
    try {
      const s = new Ctor(opt);
      s.addEventListener("reading", () => this.rec(k, "Generic Sensor API", s.x, s.y, s.z, kind, unit));
      s.addEventListener("error", (ev: any) => this.addErr(k, cls, (ev.error?.name || "Error") + ": " + (ev.error?.message || "sensor error")));
      s.start();
      this.gens.push(s);
    } catch (er: any) { this.addErr(k, cls, (er?.name || "Error") + ": " + (er?.message || String(er))); }
  }

  private queryPerms() {
    for (const n of ["accelerometer", "gyroscope", "magnetometer"]) {
      try {
        navigator.permissions.query({ name: n as PermissionName }).then(
          (r) => { this.perm[n] = r.state; r.onchange = () => { this.perm[n] = r.state; }; },
          () => { this.perm[n] = "not queryable in this browser"; }
        );
      } catch { this.perm[n] = "not queryable in this browser"; }
    }
  }

  async start() {
    if (this.running) return;
    this.errors = [];
    const w = window as any;
    // iOS Safari: permission must be requested directly from the tap handler, before anything else is awaited.
    if (w.DeviceMotionEvent && typeof w.DeviceMotionEvent.requestPermission === "function") {
      try { this.perm.iosMotion = await w.DeviceMotionEvent.requestPermission(); } catch (er: any) { this.perm.iosMotion = "error: " + er?.message; }
      if (w.DeviceOrientationEvent && typeof w.DeviceOrientationEvent.requestPermission === "function") {
        try { this.perm.iosOrientation = await w.DeviceOrientationEvent.requestPermission(); } catch (er: any) { this.perm.iosOrientation = "error: " + er?.message; }
      }
      if (this.perm.iosMotion !== "granted") { this.addErr("acc", "iOS permission", "Motion access was " + this.perm.iosMotion + ". Close the tab and reopen it to be asked again."); return; }
    } else { this.perm.iosMotion = "not required (not iOS)"; this.perm.iosOrientation = "not required (not iOS)"; }
    if (!window.isSecureContext) { this.addErr("acc", "Page", "Sensors need HTTPS or localhost. This page is not in a secure context."); return; }
    this.S = freshAll();
    this.running = true; this.startedAt = performance.now();
    this.queryPerms();
    window.addEventListener("devicemotion", this.onMotion);
    window.addEventListener("deviceorientation", this.onOrient);
    window.addEventListener("deviceorientationabsolute", this.onOrientAbs as EventListener);
    this.gen("acc", { frequency: 60 }, "m/s²", "gravity included");
    this.gen("gyro", { frequency: 60 }, "rad/s", "");
    this.gen("mag", { frequency: 30 }, "µT", "");
  }

  stop() {
    this.running = false;
    window.removeEventListener("devicemotion", this.onMotion);
    window.removeEventListener("deviceorientation", this.onOrient);
    window.removeEventListener("deviceorientationabsolute", this.onOrientAbs as EventListener);
    this.gens.forEach((g) => { try { g.stop(); } catch { /* ignore */ } });
    this.gens = [];
  }

  /** Collect the real samples that arrive during the next `ms` milliseconds. */
  collect(ms: number): Promise<Collected> {
    const out: Collected = { acc: [], gyro: [], ori: [], mag: [], cmp: [] };
    return new Promise((resolve) => {
      const off = this.onSample((s) => out[s.k].push(s.v));
      setTimeout(() => { off(); resolve(out); }, ms);
    });
  }

  setLog(on: boolean) { this.logOn = on; }
  clearLog() { this.rows = []; }

  private hz(s: Internal) {
    if (s.times.length < 3) return null;
    const d = (s.times[s.times.length - 1] - s.times[0]) / 1000;
    return d > 0 ? (s.times.length - 1) / d : null;
  }
  private status(k: SensorKey): [string, Tone] {
    const s = this.S[k], now = performance.now();
    if (s.n > 0) {
      if (!this.running) return ["Stopped", "mute"];
      const age = now - s.last;
      return age < 1500 ? ["Available · live", "ok"] : ["Stalled · no data for " + (age / 1000).toFixed(1) + " s", "warn"];
    }
    if (!this.running) return ["Not started", "mute"];
    if (/NotAllowed|Security|denied/i.test(s.err)) return ["Permission denied", "bad"];
    if (s.err) return ["Error", "bad"];
    if (now - this.startedAt < 3000) return ["Waiting for readings…", "mute"];
    return ["Not supported by this browser/device", "bad"];
  }
  private build(): Snapshot {
    const views = KEYS.map((k): SensorView => {
      const s = this.S[k], [status, tone] = this.status(k);
      return {
        key: k, name: NAMES[k], status, tone, v: s.v, unit: s.unit, src: s.src, kind: s.kind,
        hz: tone === "ok" ? this.hz(s) : null, count: s.n, last: s.wall, error: s.err,
        hint: k === "mag" && this.running && !s.n ? "Chrome on Android may keep this sensor off unless “Generic Sensor Extra Classes” is enabled at chrome://flags." : ""
      };
    });
    return { running: this.running, views, errors: this.errors.slice(), perm: { ...this.perm }, logOn: this.logOn, logCount: this.rows.length };
  }
}

export const manager = new SensorManager();
