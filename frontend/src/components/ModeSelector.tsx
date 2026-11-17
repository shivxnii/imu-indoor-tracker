import { useSyncExternalStore } from "react";
import { MODE_LABEL, Mode, modeStore } from "../tracking/mode";
import { camera } from "../camera/cameraManager";

export default function ModeSelector() {
  const mode = useSyncExternalStore(modeStore.subscribe, modeStore.getSnapshot);
  const pick = (m: Mode) => { modeStore.set(m); if (m !== "imu" && camera.getSnapshot().status === "idle") camera.start(); };
  return (
    <fieldset className="modes">
      <legend>Tracking mode</legend>
      {(["imu", "camera", "hybrid"] as Mode[]).map((m, i) => (
        <label key={m} className={"inline modeopt" + (mode === m ? " on" : "")}>
          <input type="radio" name="trackmode" checked={mode === m} onChange={() => pick(m)} /> {i + 1}. {MODE_LABEL[m]}
        </label>
      ))}
    </fieldset>
  );
}
