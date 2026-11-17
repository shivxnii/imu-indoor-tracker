import { useSyncExternalStore } from "react";
import CameraView from "../components/CameraView";
import CalibControls from "../components/CalibControls";
import FloorMap2D from "../components/FloorMap2D";
import Floor3D from "../components/Floor3D";
import { camera } from "../camera/cameraManager";
import { vision } from "../vision/engine";
import { modeStore } from "../tracking/mode";
import { useDisplay } from "../tracking/fusion";

const f0 = (v: number) => v.toFixed(0);

/* One screen, three steps: 1 start camera, 2 calibrate the floor (4 taps + lock), 3 move the phone and read X / Y / Z. */
export default function Guided() {
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot);
  const v = useSyncExternalStore(vision.subscribe, vision.getSnapshot);
  const mode = useSyncExternalStore(modeStore.subscribe, modeStore.getSnapshot);
  const d = useDisplay();
  const live = cam.status === "live", locked = v.calib.phase === "locked", fix = v.fix;
  const step = !live ? 1 : !locked ? 2 : 3;
  const Step = ({ n, title, done }: { n: number; title: string; done: boolean }) => (
    <span style={{ padding: "4px 10px", borderRadius: 14, fontWeight: 600, background: step === n ? "var(--accent, #2563eb)" : "transparent", color: step === n ? "#fff" : done ? "#16a34a" : "inherit", border: "1px solid var(--line)" }}>{done ? "✓ " : `${n}. `}{title}</span>
  );
  const big = { fontSize: 28, fontWeight: 700, lineHeight: 1.2 } as const;
  return (
    <section>
      <h2>Start here</h2>
      <div className="row"><Step n={1} title="Start camera" done={live} /><Step n={2} title="Calibrate floor" done={locked} /><Step n={3} title="Move and read X / Y / Z" done={false} /></div>

      {step === 1 && <>
        <p className="warnbox">Step 1. Press the button, allow the camera, and point the phone at your 4 tiles from about 0.5–1 m up. You do not need the sensors for this.</p>
        <div className="row"><button onClick={() => { modeStore.set("camera"); camera.start(); }} disabled={cam.status === "starting"}>Start camera</button></div>
        {cam.error && <p className="note bad">{cam.error}</p>}
      </>}
      {step >= 2 && <>
        {mode === "imu" && <p className="note warn">Mode is IMU only, so the camera result will not show. <button className="alt" onClick={() => modeStore.set("camera")}>Switch to camera tracking</button></p>}
        <CalibControls />
      </>}

      <CameraView />

      {step === 3 && <div style={{ margin: "10px 0", padding: 12, border: "1px solid var(--line)", borderRadius: 6 }}>
        <div className="row" style={{ gap: 24 }}>
          <div><div className="note">X</div><div style={big}>{fix ? f0(fix.phone.x) : "–"} mm</div></div>
          <div><div className="note">Y</div><div style={big}>{fix ? f0(fix.phone.y) : "–"} mm</div></div>
          <div><div className="note">Z (camera height)</div><div style={big}>{fix ? f0(fix.cam.z) : "–"} mm</div></div>
          <div><div className="note">Tile</div><div style={big}>{d.zone ? d.zone.id : d.outside ? "outside" : "–"}</div></div>
        </div>
        <p className={v.lost ? "note bad" : "note"}>{v.lost ? "TRACKING LOST: the camera lost the floor. Position is held. Point at the tiles again or press Edit corners / lines." : `Source: ${d.source}. Optical flow drifts the longer you move; re-calibrate when it looks off. Z and X/Y use a default focal length, so they are approximate.`}</p>
      </div>}

      <div className="split">
        <div><h2>3D map</h2><Floor3D t={d.view} onPick={() => { /* start point is not used by camera mode */ }} /></div>
        <div className="side"><h2>Floor plan</h2><FloorMap2D /></div>
      </div>
      <p className="note">Want IMU or hybrid tracking? Pick it in the Tracking mode box at the top, then use the “Live 3D position tracking” tab to start the sensors.</p>
    </section>
  );
}
