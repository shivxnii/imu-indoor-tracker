import { useSyncExternalStore } from "react";
import CameraView from "./CameraView";
import CalibControls from "./CalibControls";
import { camera } from "../camera/cameraManager";
import { vision } from "../vision/engine";
import { fusion, useDisplay } from "../tracking/fusion";

const f0 = (v: number) => v.toFixed(0);

/** Camera preview + controls + status, shown beside the 3D map. */
export default function CameraPanel() {
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot);
  const v = useSyncExternalStore(vision.subscribe, vision.getSnapshot);
  const fu = useSyncExternalStore(fusion.subscribe, fusion.getSnapshot);
  const d = useDisplay();
  const live = cam.status === "live";
  return (
    <div className="split">
      <div>
        <h2>Live camera</h2>
        <CameraView compact />
        <div className="row">
          <button disabled={cam.status === "starting" || live} onClick={() => camera.start()}>Start Camera</button>
          <button className="alt" disabled={cam.status === "idle"} onClick={() => camera.stop()}>Stop Camera</button>
          <button className="alt" disabled={!live} onClick={() => camera.switchCamera()}>{cam.facing === "environment" ? "Use front camera" : "Use rear camera"}</button>
        </div>
        {cam.status === "error" && <p className="note bad">{cam.error}</p>}
        <CalibControls />
        <p className="note">Green = registered marker, orange = unregistered marker, cyan = candidate tile boundaries (overlay only), yellow = the four tiles projected from the current fix. Calibration, manual tile corners and marker printing are on the “Camera &amp; calibration” tab.</p>
      </div>
      <div className="side">
        <h2>Tracking sources</h2>
        <table><tbody>
          <tr><td>Camera</td><td className={live ? (d.lost ? "bad" : "ok") : "mute"}>{d.cameraStatus}</td></tr>
          <tr><td>IMU</td><td>{d.imuStatus}</td></tr>
          <tr><td>Markers in view</td><td>{live ? (v.markers.length ? v.markers.map((m) => `ID ${m.id}${m.known ? "" : " (not registered)"}`).join(", ") : "none") : "–"}</td></tr>
          <tr><td>Fit quality</td><td>{d.quality}</td></tr>
          <tr><td>Last update source</td><td>{fu.lastSrc ? `${fu.lastSrc} · ${new Date(fu.lastAt).toLocaleTimeString()}` : "none yet"}</td></tr>
          <tr><td>Updates so far</td><td>IMU {fu.counts.IMU} · Camera {fu.counts.Camera} · Hybrid {fu.counts.Hybrid}</td></tr>
          <tr><td>Vision rate</td><td>{live ? `${v.fps.toFixed(1)} frames/s at ${v.procW}×${v.procH}` : "–"}</td></tr>
        </tbody></table>
        <p className="val pre">{live ? v.msg : "Camera is off."}</p>
        {fu.log.length > 0 && <>
          <p className="note" style={{ marginBottom: 2 }}>Recent position updates</p>
          <ul className="log">{fu.log.map((l, i) => <li key={i}><b>{l.src}</b> {new Date(l.t).toLocaleTimeString()} · {l.text}</li>)}</ul>
          <div className="row"><button className="alt" onClick={() => fusion.clear()}>Clear log</button></div>
        </>}
        {d.pos && <p className="note">Position now: X {f0(d.pos.x)} mm, Y {f0(d.pos.y)} mm.</p>}
      </div>
    </div>
  );
}
