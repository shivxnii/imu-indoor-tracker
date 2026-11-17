import { vision } from "../vision/engine";

/* Real camera access through navigator.mediaDevices.getUserMedia. No prerecorded or simulated video is ever used:
 * status becomes "live" only after the video element reports decoded frames with a non-zero size. */
export type CamStatus = "idle" | "starting" | "live" | "error";
export type Facing = "environment" | "user";
export interface CamState {
  supported: boolean; secure: boolean; status: CamStatus; permission: string; facing: Facing; error: string;
  label: string; width: number; height: number; fps: number; reportedFacing: string; hasMultiple: boolean; frameAge: number | null; stream: MediaStream | null;
}

class CameraManager {
  private st: CamState;
  private listeners = new Set<() => void>();
  private video: HTMLVideoElement | null = null; private timer = 0; private lastT = -1; private lastAdvance = 0; private token = 0;

  constructor() {
    this.st = {
      supported: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia, secure: typeof window !== "undefined" && window.isSecureContext,
      status: "idle", permission: "unknown", facing: "environment", error: "", label: "", width: 0, height: 0, fps: 0, reportedFacing: "–", hasMultiple: false, frameAge: null, stream: null
    };
    this.refreshPermission();
  }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.st;
  private set(p: Partial<CamState>) { this.st = { ...this.st, ...p }; this.listeners.forEach((l) => l()); }

  private async refreshPermission() {
    try { const r = await navigator.permissions.query({ name: "camera" as PermissionName }); const upd = () => this.set({ permission: r.state }); upd(); r.onchange = upd; }
    catch { this.set({ permission: "not reported by this browser" }); }
  }

  async start(facing: Facing = this.st.facing) {
    if (this.st.status === "starting") return;
    this.stopTracks();
    const my = ++this.token;
    if (!this.st.secure) { this.set({ status: "error", error: "Camera access needs HTTPS (or localhost). Open the https:// address, not http://." }); return; }
    if (!this.st.supported) { this.set({ status: "error", error: "This browser does not provide navigator.mediaDevices.getUserMedia." }); return; }
    this.set({ status: "starting", error: "", facing });
    try {
      let stream: MediaStream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } }); }
      catch (e) { if ((e as DOMException).name === "OverconstrainedError" || (e as DOMException).name === "TypeError") stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true }); else throw e; }
      if (my !== this.token) { stream.getTracks().forEach((t) => t.stop()); return; }
      const track = stream.getVideoTracks()[0], s = track.getSettings();
      const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.autoplay = true;
      v.style.cssText = "position:fixed;left:-9999px;width:2px;height:2px;opacity:0"; document.body.appendChild(v); v.srcObject = stream; this.video = v;
      track.addEventListener("ended", () => { if (my === this.token) this.set({ status: "error", error: "The camera stream ended (camera unplugged, taken by another app, or the permission was revoked)." }); });
      await v.play();
      let devs: MediaDeviceInfo[] = []; try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"); } catch { /* ignore */ }
      this.set({ stream, label: track.label || "camera", reportedFacing: s.facingMode ?? "not reported", hasMultiple: devs.length > 1, permission: "granted" });
      this.lastT = -1; this.lastAdvance = performance.now();
      window.clearInterval(this.timer); this.timer = window.setInterval(() => this.watch(my), 400);
    } catch (e) {
      if (my !== this.token) return;
      const n = (e as DOMException).name;
      const msg = n === "NotAllowedError" || n === "PermissionDeniedError" ? "Camera permission was denied. Allow the camera for this site in the browser's site settings, then press Start Camera again."
        : n === "NotFoundError" || n === "DevicesNotFoundError" ? "No camera was found on this device."
        : n === "NotReadableError" || n === "TrackStartError" ? "The camera is in use by another app or tab, or could not be opened."
        : n === "SecurityError" ? "The browser blocked camera access for this page (needs HTTPS and a top-level page, not a restricted frame)."
        : `Could not start the camera: ${n || "unknown error"} ${(e as Error).message ?? ""}`;
      this.stopTracks(); this.set({ status: "error", error: msg, permission: n === "NotAllowedError" ? "denied" : this.st.permission });
    }
  }
  private watch(my: number) {
    const v = this.video; if (!v || my !== this.token) return;
    const t = v.currentTime, ok = v.videoWidth > 0 && v.readyState >= 2;
    if (t !== this.lastT) { this.lastT = t; this.lastAdvance = performance.now(); }
    const age = performance.now() - this.lastAdvance;
    if (ok && this.st.status !== "live") { this.set({ status: "live", width: v.videoWidth, height: v.videoHeight }); vision.attach(v); }
    if (this.st.status === "live") {
      const fps = (this.st.stream?.getVideoTracks()[0]?.getSettings().frameRate) ?? 0;
      this.set({ frameAge: Math.round(age), fps, width: v.videoWidth, height: v.videoHeight, error: age > 2500 ? "No new camera frames for over 2.5 s (stream stalled)." : "" });
    }
  }
  private stopTracks() {
    window.clearInterval(this.timer); vision.detach();
    this.st.stream?.getTracks().forEach((t) => t.stop());
    if (this.video) { this.video.srcObject = null; this.video.remove(); this.video = null; }
  }
  stop() { this.token++; this.stopTracks(); this.set({ status: "idle", error: "", stream: null, label: "", width: 0, height: 0, frameAge: null }); }
  switchCamera() { return this.start(this.st.facing === "environment" ? "user" : "environment"); }
}
export const camera = new CameraManager();
