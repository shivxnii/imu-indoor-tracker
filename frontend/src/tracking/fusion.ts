import { useMemo, useSyncExternalStore } from "react";
import { tracker, TState } from "./tracker";
import { vision, CamFix, VisionState } from "../vision/engine";
import { camera } from "../camera/cameraManager";
import { Mode, modeStore } from "./mode";
import { Pt, TileHit, tileAt } from "./grid";

/*
 * FUSION / DISPLAY LAYER
 *  IMU mode    : shows the IMU engine only.
 *  Camera mode : shows camera fixes only (registered markers, manual tile corners, optional drifting optical flow). No IMU involvement.
 *  Hybrid mode : the IMU engine moves the position between camera observations; each absolute camera fix (marker or manual corners) is blended
 *                into it with a gain from the two uncertainties and also corrects the IMU heading. Optical-flow fixes are NOT used for correction.
 * Every update is logged with its source (IMU, Camera or Hybrid).
 */
export type Src = "IMU" | "Camera" | "Hybrid";
export interface LogEntry { t: number; src: Src; text: string }
export interface FusionState { lastSrc: Src | null; lastAt: number; counts: Record<Src, number>; log: LogEntry[]; lastGain: number | null }

class Fusion {
  private st: FusionState = { lastSrc: null, lastAt: 0, counts: { IMU: 0, Camera: 0, Hybrid: 0 }, log: [], lastGain: null };
  private listeners = new Set<() => void>(); private lastFixId = 0; private lastSteps = 0; private lastApply = 0;
  constructor() {
    vision.subscribe(() => this.onVision()); tracker.subscribe(() => this.onTracker());
    modeStore.subscribe(() => { this.lastSteps = tracker.getSnapshot().steps; });
  }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.st;
  private push(src: Src, text: string, gain: number | null = this.st.lastGain) {
    const t = Date.now(), counts = { ...this.st.counts, [src]: this.st.counts[src] + 1 };
    // camera/hybrid fixes arrive ~10 times a second: count every one, but list at most one per second
    const dup = src !== "IMU" && this.st.log[0]?.src === src && t - this.st.log[0].t < 1000;
    const log = dup ? this.st.log : [{ t, src, text }, ...this.st.log].slice(0, 8);
    this.st = { lastSrc: src, lastAt: t, counts, log, lastGain: gain }; this.listeners.forEach((l) => l());
  }
  clear() { this.st = { lastSrc: null, lastAt: 0, counts: { IMU: 0, Camera: 0, Hybrid: 0 }, log: [], lastGain: null }; this.listeners.forEach((l) => l()); }
  private onTracker() {
    const mode = modeStore.getSnapshot(), s = tracker.getSnapshot();
    if (s.steps > this.lastSteps && mode !== "camera") this.push("IMU", `step ${s.steps} (IMU dead reckoning)`);
    this.lastSteps = s.steps;
  }
  private onVision() {
    const v = vision.getSnapshot(), fix = v.fix; if (!fix || fix.id === this.lastFixId) return;
    this.lastFixId = fix.id; const mode = modeStore.getSnapshot();
    const how = fix.source === "marker" ? `${fix.nMarkers} marker${fix.nMarkers > 1 ? "s" : ""}` : fix.source === "manual" ? "manual tile corners" : "optical flow";
    if (mode === "camera") { if (fix.id % 5 === 0 || fix.source !== "flow") this.push("Camera", `${how} → X ${fix.phone.x.toFixed(0)}, Y ${fix.phone.y.toFixed(0)} mm`); return; }
    if (mode === "hybrid" && fix.source !== "flow") {
      const now = performance.now(); if (now - this.lastApply < 250) return; this.lastApply = now;
      const r = tracker.applyExternalFix({ pos: fix.phone, sigma: fix.sigma, heading: fix.heading });
      this.lastSteps = tracker.getSnapshot().steps;
      if (r.kind === "init") this.push("Camera", `initialised from ${how}: X ${fix.phone.x.toFixed(0)}, Y ${fix.phone.y.toFixed(0)} mm`, 1);
      else if (r.kind === "reacquire") this.push("Camera", `IMU and camera disagreed by ${r.innovation.toFixed(0)} mm (beyond 3σ): position re-acquired from ${how}`, 1);
      else this.push("Hybrid", `${how} blended in (camera weight ${(r.gain * 100).toFixed(0)}%, jump ${r.innovation.toFixed(0)} mm)`, r.gain);
    }
  }
}
export const fusion = new Fusion();

export interface Display {
  mode: Mode; view: TState; pos: Pt | null; heading: number | null; zone: TileHit | null; outside: boolean;
  source: string; sourceNote: string; sigma: number | null; quality: string; lost: boolean; cameraStatus: string; imuStatus: string; trackStatus: string;
}

export function useDisplay(): Display {
  const t = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);
  const v = useSyncExternalStore(vision.subscribe, vision.getSnapshot);
  const f = useSyncExternalStore(fusion.subscribe, fusion.getSnapshot);
  const c = useSyncExternalStore(camera.subscribe, camera.getSnapshot);
  const mode = useSyncExternalStore(modeStore.subscribe, modeStore.getSnapshot);
  return useMemo(() => build(mode, t, v, f.lastSrc, c.status, c.error), [mode, t, v.fix, v.lost, v.trail, v.anchor, v.flowOn, v.running, f.lastSrc, c.status, c.error]); // eslint-disable-line react-hooks/exhaustive-deps
}

function build(mode: Mode, t: TState, v: VisionState, last: Src | null, camStatus: string, camErr: string): Display {
  const fix: CamFix | null = v.fix;
  const camLive = camStatus === "live";
  const cameraStatus = camStatus === "live" ? (v.lost ? "live — tracking LOST" : v.anchor ? `live — ${v.fix?.source === "flow" ? "optical flow (drifting)" : v.fix?.source === "manual" ? "manual-corner fix" : "marker fix"}` : "live — no fix yet") : camStatus === "starting" ? "starting…" : camStatus === "error" ? `error: ${camErr}` : "off";
  const imuStatus = { "not-calibrated": "not calibrated", ready: "calibrated", tracking: "tracking", paused: "paused" }[t.status];
  let view = t, pos: Pt | null = t.pos, heading = t.heading, sigma = t.sigma, source = "none", note = "", quality = "–", lost = false, trackStatus = imuStatus;
  if (mode === "imu") {
    source = !t.pos ? "none" : t.steps ? "IMU (start point + detected steps, unvalidated)" : "IMU (declared start point)";
    note = "Camera is ignored in this mode.";
  } else if (mode === "camera") {
    pos = fix?.phone ?? null; heading = fix?.heading ?? null; sigma = fix?.sigma ?? null; lost = !!fix && v.lost;
    source = !fix ? "none" : lost ? "Camera — LOST, holding last fix" : fix.source === "marker" ? "Camera (registered marker)" : fix.source === "manual" ? "Camera (manual tile corners)" : "Camera (optical flow — drifts)";
    note = !camLive ? "Start the camera." : !fix ? "Waiting for a registered marker or manual tile corners." : fix.source === "flow" ? "Absolute scale and position come from the last anchor and drift over time." : "";
    trackStatus = !camLive ? "camera off" : !fix ? "no fix" : lost ? "lost" : "tracking";
    view = { ...t, pos, heading, trail: v.trail, sigma, status: fix ? "tracking" : "not-calibrated", clamped: false, mode: "walking" };
    quality = fix ? (fix.rmsPx !== null ? `marker fit error ${fix.rmsPx.toFixed(2)} px, ${fix.nMarkers} marker(s)` : fix.source === "flow" ? `${fix.inliers ?? 0} flow inliers; error grows with distance` : "four tapped corners (exact fit, no redundancy)") : "–";
  } else {
    lost = camLive && v.anchor !== null && v.lost;
    source = !t.pos ? "none" : last === "Hybrid" ? "Hybrid (IMU + camera blended)" : last === "Camera" ? "Camera (latest fix replaced the IMU estimate)" : "IMU (since last camera fix)";
    note = !camLive ? "Camera is off, so this is IMU only." : lost ? "Camera lost: IMU continues alone and will drift until a marker is seen." : "";
    trackStatus = !t.pos ? "waiting for first camera fix" : lost ? "camera lost, IMU only" : "tracking";
    quality = fix && fix.source !== "flow" ? `last camera fit: ${fix.rmsPx !== null ? fix.rmsPx.toFixed(2) + " px, " : ""}${fix.nMarkers ? fix.nMarkers + " marker(s)" : "manual corners"}` : "–";
  }
  const zone = pos ? tileAt(t.cfg, pos.x, pos.y) : null;
  return { mode, view, pos, heading, zone, outside: !!pos && !zone, source, sourceNote: note, sigma, quality, lost, cameraStatus, imuStatus, trackStatus };
}

