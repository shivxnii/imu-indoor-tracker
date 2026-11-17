import { manager, Collected, Tone, Vec } from "./sensorManager";

export interface TestDef { id: string; name: string; secs: number; say: string; evaluate: (c: Collected) => [Tone, string] }
const MIN = 8;
const mag3 = (v: Vec) => Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const rng = (a: number[]) => Math.max(...a) - Math.min(...a);
const toDeg = () => (manager.unit("gyro") === "rad/s" ? 57.29578 : 1);

export const TESTS: TestDef[] = [
  { id: "still", name: "1. Stay still", secs: 4, say: "Lay the phone flat and don’t touch it.",
    evaluate: (c) => {
      if (c.acc.length < MIN || c.gyro.length < MIN) return ["bad", `Not enough readings from the accelerometer and gyroscope (${c.acc.length} and ${c.gyro.length}). Cannot judge stability.`];
      const a = sd(c.acc.map(mag3)), g = mean(c.gyro.map(mag3)) * toDeg(), ok = a < 0.3 && g < 5;
      return [ok ? "ok" : "warn", `Acceleration varied by ${a.toFixed(3)} m/s² and rotation averaged ${g.toFixed(2)} °/s. ` + (ok ? "Readings were stable, within normal sensor noise." : "Readings moved more than expected. Was the phone still?")];
    } },
  { id: "tilt", name: "2. Tilt the phone", secs: 5, say: "Tip the phone forward, back and sideways by about 45°.",
    evaluate: (c) => {
      if (c.ori.length < MIN) return ["bad", `No orientation readings arrived (${c.ori.length}). Cannot judge.`];
      const b = rng(c.ori.map((v) => v[1] ?? 0)), g = rng(c.ori.map((v) => v[2] ?? 0)), m = Math.max(b, g);
      return [m >= 15 ? "ok" : "warn", `Beta changed by ${b.toFixed(1)}° and gamma by ${g.toFixed(1)}°. ` + (m >= 15 ? "Orientation responded." : "No clear change. Tilt further and retry.")];
    } },
  { id: "rotate", name: "3. Rotate the phone", secs: 5, say: "Turn the phone around quickly, like steering a wheel.",
    evaluate: (c) => {
      if (c.gyro.length < MIN) return ["bad", `No gyroscope readings arrived (${c.gyro.length}). Cannot judge.`];
      const p = Math.max(...c.gyro.map(mag3)) * toDeg();
      return [p >= 30 ? "ok" : "warn", `Peak rotation was ${p.toFixed(1)} °/s. ` + (p >= 30 ? "Gyroscope responded." : "No clear rotation. Turn faster and retry.")];
    } },
  { id: "move", name: "4. Move the phone", secs: 5, say: "Walk a few steps, or swing the phone back and forth.",
    evaluate: (c) => {
      if (c.acc.length < MIN) return ["bad", `No accelerometer readings arrived (${c.acc.length}). Cannot judge.`];
      const r = rng(c.acc.map(mag3));
      return [r >= 1.5 ? "ok" : "warn", `Acceleration magnitude ranged over ${r.toFixed(2)} m/s². ` + (r >= 1.5 ? "Accelerometer responded." : "No clear movement. Move more briskly and retry.")];
    } }
];

export async function runTest(t: TestDef): Promise<[Tone, string]> {
  if (!manager.isRunning()) return ["bad", "Start the sensors first."];
  return t.evaluate(await manager.collect(t.secs * 1000));
}
