import { manager } from "../sensors/sensorManager";
import { useSensors } from "../sensors/useSensors";
import { useTracker } from "../tracking/useTracker";
import { tracker } from "../tracking/tracker";
import { tileAt } from "../tracking/grid";
import Floor3D from "../components/Floor3D";
import CameraPanel from "../components/CameraPanel";
import { useDisplay } from "../tracking/fusion";
import { MODE_LABEL } from "../tracking/mode";

const f0 = (v: number) => v.toFixed(0);
const HEADINGS: [string, number][] = [["+Y (up)", 0], ["+X (right)", 90], ["−Y (down)", 180], ["−X (left)", 270]];

export default function Live3D() {
  const t = useTracker();
  const snap = useSensors();
  const live = (k: string) => snap.views.find((v) => v.key === k)?.tone === "ok";
  const d = useDisplay();
  const tile = d.zone;
  const calibrated = t.status !== "not-calibrated";
  const canCal = snap.running && live("ori") && live("acc") && !t.busy && !calibrated;
  const statusText = { "not-calibrated": "Not calibrated", ready: "Calibrated, ready to track", tracking: "Tracking", paused: "Paused" }[t.status];
  const dx = t.pos ? t.pos.x - t.start.x : 0, dy = t.pos ? t.pos.y - t.start.y : 0;

  return (
    <section>
      <h2>LIVE 3D POSITION TRACKING</h2>
      <div className="split">
        <div><Floor3D t={d.view} onPick={(p) => tracker.setStart(p)} /></div>

        <div className="side">
          <table><tbody>
            <tr><td>Tracking mode</td><td><b>{MODE_LABEL[d.mode]}</b></td></tr>
            <tr><td>Current zone</td><td><b>{tile ? `${tile.id} (Zone ${tile.zone})` : d.outside ? "Outside the floor" : "Unknown"}</b></td></tr>
            <tr><td>X</td><td>{d.pos ? `${f0(d.pos.x)} mm` : "–"}</td></tr>
            <tr><td>Y</td><td>{d.pos ? `${f0(d.pos.y)} mm` : "–"}</td></tr>
            <tr><td>Heading</td><td>{d.heading === null ? "–" : `${Math.round(d.heading) % 360}° (0° = +Y, clockwise)`}</td></tr>
            <tr><td>Heading source</td><td>{d.mode === "camera" ? "camera (image up-direction)" : t.headingSrc}</td></tr>
            <tr><td>Position source</td><td>{d.source}{d.sourceNote ? ` — ${d.sourceNote}` : ""}</td></tr>
            <tr><td>Tracking status</td><td className={d.lost ? "bad" : ""}>{d.trackStatus}</td></tr>
            <tr><td>Camera</td><td>{d.cameraStatus}</td></tr>
            <tr><td>Camera fit</td><td>{d.quality}</td></tr>
            <tr><td>Steps detected</td><td>{t.steps}</td></tr>
            <tr><td>Distance estimated</td><td>{f0(t.distance)} mm travelled</td></tr>
            <tr><td>Uncertainty</td><td>{d.sigma === null ? "Not available in this mode" : `±${f0(d.sigma)} mm (model estimate, not measured)`}</td></tr>
            <tr><td>IMU engine status</td><td>{statusText}{t.clamped ? " · estimate held at the floor edge" : ""}</td></tr>
            <tr><td>Sensors</td><td>{snap.running ? ["acc", "gyro", "ori", "cmp"].map((k) => { const v = snap.views.find((x) => x.key === k)!; return `${v.name.split(" ")[0]}: ${v.tone === "ok" ? "live" : v.status}`; }).join(" · ") : "Off"}</td></tr>
          </tbody></table>
          <p className="val pre">{t.msg}</p>

          <div className="row">
            <button disabled={snap.running} onClick={() => manager.start()}>Start Sensors</button>
            <button className="alt" disabled={!snap.running} onClick={() => manager.stop()}>Stop Sensors</button>
          </div>
        </div>
      </div>

      <CameraPanel />

      <div className="split">
        <div>
          <h2>1. Choose start point and direction</h2>
          <div className="fields">
            <label>Start X (mm)<input type="number" disabled={t.status === "tracking"} value={t.start.x} onChange={(e) => tracker.setStart({ x: +e.target.value, y: t.start.y })} /></label>
            <label>Start Y (mm)<input type="number" disabled={t.status === "tracking"} value={t.start.y} onChange={(e) => tracker.setStart({ x: t.start.x, y: +e.target.value })} /></label>
          </div>
          <div className="row">{[0, 1, 2, 3].map((i) => {
            const r = Math.floor(i / 2), c = i % 2;
            return <button key={i} className="alt" disabled={t.status === "tracking"} onClick={() => tracker.setStart({ x: c * 600 + 300, y: r * 600 + 300 })}>R{r + 1}C{c + 1} centre</button>;
          })}</div>
          <label>Initial direction the phone’s top edge faces (° clockwise from +Y)
            <input type="number" disabled={t.status === "tracking"} value={t.startHeading} onChange={(e) => tracker.setStartHeading(+e.target.value)} /></label>
          <div className="row">{HEADINGS.map(([n, d]) => <button key={d} className="alt" disabled={t.status === "tracking"} onClick={() => tracker.setStartHeading(d)}>{n}</button>)}</div>
          <p className="note">The open circle on the floor marks the start point. You can also tap the floor in the 3D view. An IMU cannot discover where the phone is, so this declared start is what every later estimate builds on.</p>

          <h2 style={{ marginTop: 16 }}>Movement type</h2>
          <div className="row">
            <label className="inline"><input type="radio" name="mode" checked={t.mode === "walking"} onChange={() => tracker.setMode("walking")} /> Carried while walking (step detection)</label>
            <label className="inline"><input type="radio" name="mode" checked={t.mode === "sliding"} onChange={() => tracker.setMode("sliding")} /> Slid along the floor (no automatic distance)</label>
          </div>
          <label>Nominal step length (mm)<input type="number" min="1" value={t.stepLen} onChange={(e) => tracker.setStepLen(+e.target.value)} /></label>
          <p className="note">Step detection counts footsteps. It does not measure how far a phone is slid, so sliding mode leaves the position unchanged until a camera or AprilTag reference is added.</p>
        </div>

        <div>
          <h2>2. Calibrate and track</h2>
          <p className="note" style={{ marginTop: 0 }}>Place the phone flat on the start point, screen up, top edge facing the chosen direction. Start the sensors, then calibrate.</p>
          <div className="row">
            <button disabled={!canCal} onClick={() => tracker.calibrate()}>{t.busy ? "Calibrating…" : "Calibrate Starting Position"}</button>
            <button className="alt" disabled={!calibrated || t.busy} onClick={() => tracker.recalibrate()}>Recalibrate</button>
          </div>
          {!calibrated && !canCal && !t.busy && <p className="note warn">Calibration needs live accelerometer and orientation readings. {snap.running ? "Waiting for them." : "Start the sensors first."}</p>}
          <div className="row">
            <button disabled={t.status !== "ready"} onClick={() => tracker.startTracking()}>Start Tracking</button>
            <button className="alt" disabled={t.status !== "tracking"} onClick={() => tracker.pause()}>Pause</button>
            <button className="alt" disabled={t.status !== "paused"} onClick={() => tracker.resume()}>Resume</button>
          </div>
          <div className="row">
            <button className="alt" disabled={!calibrated} onClick={() => tracker.resetPosition()}>Reset Position</button>
            <button className="alt" disabled={!t.trail.length} onClick={() => tracker.clearTrail()}>Clear Movement Trail</button>
          </div>

          <h2 style={{ marginTop: 16 }}>3. Validation</h2>
          <ol className="note" style={{ paddingLeft: 18 }}>
            <li>Calibrate at a known tile position and start tracking.</li>
            <li>Walk the phone, held flat, into another tile. The marker and highlighted tile should follow.</li>
            <li>Walk back to the start point and press Record return check.</li>
          </ol>
          <div className="row"><button className="alt" disabled={!calibrated} onClick={() => tracker.recordReturnCheck()}>Record return check</button></div>
          {calibrated && <p className="val pre">{`Difference from start now: ΔX ${f0(dx)} mm, ΔY ${f0(dy)} mm, distance ${f0(Math.hypot(dx, dy))} mm`}</p>}
          {t.returnCheck && <p className="val pre">{`Return check at ${t.returnCheck.at}: ΔX ${f0(t.returnCheck.dx)} mm, ΔY ${f0(t.returnCheck.dy)} mm, error ${f0(t.returnCheck.dist)} mm after ${t.returnCheck.steps} steps. Nothing is corrected automatically.`}</p>}
        </div>
      </div>
    </section>
  );
}
