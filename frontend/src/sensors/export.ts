import { NAMES, SESSION_ID, Sample, Snapshot, SensorKey } from "./sensorManager";
import { deviceInfo } from "./deviceInfo";

const COL: Record<SensorKey, string[]> = { acc: ["ax", "ay", "az"], gyro: ["gx", "gy", "gz"], ori: ["alpha", "beta", "gamma"], mag: ["mx", "my", "mz"], cmp: ["compass_heading"] };
const HEAD = ["timestamp_iso", "t_ms", "sensor", "source", "kind", "unit", "session_id", "permission", "ax", "ay", "az", "gx", "gy", "gz", "alpha", "beta", "gamma", "mx", "my", "mz", "compass_heading"];

const permFor = (k: SensorKey, p: Record<string, string>) =>
  (k === "acc" ? p.accelerometer : k === "gyro" ? p.gyroscope : k === "mag" ? p.magnetometer : p.iosOrientation) || "unknown";

export function toCSV(rows: Sample[], perm: Record<string, string>): string {
  const out = [HEAD.join(",")];
  for (const r of rows) {
    const o: Record<string, unknown> = { timestamp_iso: r.iso, t_ms: r.t.toFixed(2), sensor: NAMES[r.k], source: r.src, kind: r.kind, unit: r.unit, session_id: SESSION_ID, permission: permFor(r.k, perm) };
    COL[r.k].forEach((c, i) => { o[c] = r.v[i]; });
    out.push(HEAD.map((h) => (o[h] == null ? "" : '"' + String(o[h]).replace(/"/g, '""') + '"')).join(","));
  }
  return out.join("\n");
}

export function toJSON(rows: Sample[], snap: Snapshot): string {
  const availability: Record<string, unknown> = {};
  for (const v of snap.views) availability[v.name] = { status: v.status, readings_received: v.count, source: v.src || null, kind: v.kind || null, unit: v.unit || null, rate_hz: v.hz, last_update: v.last || null, error: v.error || null };
  const device: Record<string, string> = {};
  deviceInfo(snap.perm).forEach(([k, v]) => { device[k] = v; });
  return JSON.stringify({
    exported_at: new Date().toISOString(), session_id: SESSION_ID, device, availability, errors: snap.errors,
    samples: rows.map((r) => ({ timestamp_iso: r.iso, t_ms: +r.t.toFixed(2), sensor: NAMES[r.k], source: r.src, kind: r.kind, unit: r.unit, values: r.v.filter((x) => x !== null) }))
  }, null, 1);
}

export function download(name: string, data: string, mime: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: mime }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
