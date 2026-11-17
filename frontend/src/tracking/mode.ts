export type Mode = "imu" | "camera" | "hybrid";
export const MODE_LABEL: Record<Mode, string> = { imu: "IMU Tracking", camera: "Live Camera Tracking", hybrid: "Hybrid Tracking (Camera + IMU)" };
const KEY = "imu-tracker.mode.v1";
let mode: Mode = (() => { try { const m = localStorage.getItem(KEY); if (m === "imu" || m === "camera" || m === "hybrid") return m; } catch { /* ignore */ } return "imu"; })();
const subs = new Set<() => void>();
export const modeStore = {
  subscribe: (l: () => void) => { subs.add(l); return () => { subs.delete(l); }; },
  getSnapshot: () => mode,
  set(m: Mode) { mode = m; try { localStorage.setItem(KEY, m); } catch { /* ignore */ } subs.forEach((l) => l()); }
};
