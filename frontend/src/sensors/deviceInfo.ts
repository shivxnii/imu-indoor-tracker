import { SESSION_ID } from "./sensorManager";

export function deviceInfo(perm: Record<string, string>): [string, string][] {
  let inFrame = false;
  try { inFrame = window.self !== window.top; } catch { inFrame = true; }
  const ua = (navigator as any).userAgentData;
  const has = (n: string) => (n in window ? "yes" : "no");
  return [
    ["Session ID (this page load only)", SESSION_ID],
    ["Browser", navigator.userAgent],
    ["Platform hints", ua ? `${ua.platform || "?"} · ${ua.mobile ? "mobile" : "not mobile"} · ${(ua.brands || []).map((b: any) => b.brand + " " + b.version).join(", ")}` : "Not provided by this browser"],
    ["Screen", `${screen.width}×${screen.height} @${window.devicePixelRatio || 1}x · touch points ${navigator.maxTouchPoints || 0}`],
    ["Secure context (HTTPS or localhost)", window.isSecureContext ? "Yes" : "No – sensors will not work"],
    ["Inside a frame", inFrame ? "Yes – the frame may block sensors" : "No"],
    ["API present: DeviceMotionEvent / DeviceOrientationEvent", `${has("DeviceMotionEvent")} / ${has("DeviceOrientationEvent")}`],
    ["API present: Accelerometer / Gyroscope / Magnetometer", `${has("Accelerometer")} / ${has("Gyroscope")} / ${has("Magnetometer")}`],
    ["Permission: accelerometer", perm.accelerometer || "unknown"],
    ["Permission: gyroscope", perm.gyroscope || "unknown"],
    ["Permission: magnetometer", perm.magnetometer || "unknown"],
    ["Permission: iOS motion prompt", perm.iosMotion || "not asked yet"],
    ["Permission: iOS orientation prompt", perm.iosOrientation || "not asked yet"]
  ];
}
