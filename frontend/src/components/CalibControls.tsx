import { useSyncExternalStore } from "react";
import { camera } from "../camera/cameraManager";
import { vision } from "../vision/engine";

/** Buttons + instruction for the live four-corner floor calibration. Used on the camera page and next to the 3D map. */
export default function CalibControls() {
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot);
  const v = useSyncExternalStore(vision.subscribe, vision.getSnapshot);
  const live = cam.status === "live", c = v.calib, g = v.grout;
  const instr = !live ? "Start the camera, then press “Calibrate floor”."
    : c.phase === "off" ? "Press “Calibrate floor”, then tap the four outer corners of your 2×2 tile area."
    : c.phase === "tap" ? `Select the four outer corners of your 2×2 tile area. Tap the ${["top-left", "top-right", "bottom-right", "bottom-left"][c.pts.length]} corner (${c.pts.length}/4).`
    : c.phase === "edit" ? "Drag the pink corners onto the real corners. Drag the cyan handles to move the two internal tile lines onto the grout. Then Lock calibration."
    : "Calibration locked. Tap the video to read the floor X/Y of any point.";
  return (
    <div>
      <p className="warnbox">{instr}</p>
      <div className="row">
        <button disabled={!live || c.phase === "tap" || c.phase === "edit"} onClick={() => vision.beginCalib()}>{c.phase === "locked" ? "Calibrate again" : "Calibrate floor"}</button>
        {c.phase === "tap" && <button className="alt" disabled={!c.pts.length} onClick={() => vision.calibUndo()}>Undo last tap</button>}
        {c.phase === "edit" && <>
          <button onClick={() => vision.lockCalib()}>Lock calibration</button>
          <button className="alt" onClick={() => vision.setCalibFrozen(!c.frozen)}>{c.frozen ? "Unfreeze (live video)" : "Freeze frame"}</button>
          <button className="alt" onClick={() => vision.calibResetMids()}>Reset inside lines</button>
        </>}
        {(c.phase === "tap" || c.phase === "edit") && <button className="alt" onClick={() => vision.calibResetCorners()}>Reset corners</button>}
        {c.phase === "locked" && <>
          <button className="alt" onClick={() => vision.editCalib()}>Edit corners / lines</button>
          <button className="alt" disabled={!(g.v?.ok || g.h?.ok) || v.lost} onClick={() => vision.snapGrout()}>Snap to detected grout</button>
          <button className="alt" onClick={() => vision.clearAnchor()}>Clear calibration</button>
        </>}
      </div>
    </div>
  );
}
