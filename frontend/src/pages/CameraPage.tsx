import { useState, useSyncExternalStore } from "react";
import CameraView from "../components/CameraView";
import CalibControls from "../components/CalibControls";
import FloorMap2D from "../components/FloorMap2D";
import { apply, inv3 } from "../vision/geometry";
import { tileAt } from "../tracking/grid";
import { FLOOR } from "../tracking/tracker";
import { camera } from "../camera/cameraManager";
import { vision } from "../vision/engine";
import { MarkerDef, markerRegistry, markerSvg, DICTIONARY } from "../vision/markers";
import { useDisplay } from "../tracking/fusion";

const f = (v: number, d = 0) => v.toFixed(d);
const hd = (v: number) => String(Math.round(v) % 360);

export default function CameraPage() {
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot);
  const v = useSyncExternalStore(vision.subscribe, vision.getSnapshot);
  const defs = useSyncExternalStore(markerRegistry.subscribe, markerRegistry.getSnapshot);
  const d = useDisplay();
  const [region, setRegion] = useState<string>("all");
  const live = cam.status === "live";
  const setDef = (i: number, k: keyof MarkerDef, val: number) => markerRegistry.set(defs.map((m, j) => (j === i ? { ...m, [k]: Number.isFinite(val) ? val : 0 } : m)));
  const nextId = () => { let i = 0; while (defs.some((m) => m.id === i)) i++; return i; };
  const fix = v.fix;

  return (
    <>
      <section>
        <h2>1. Live camera</h2>
        <div className="split" style={{ marginTop: 0 }}>
          <div>
            <CameraView />
            <div className="row">
              <button disabled={cam.status === "starting" || live} onClick={() => camera.start()}>Start Camera</button>
              <button className="alt" disabled={cam.status === "idle"} onClick={() => camera.stop()}>Stop Camera</button>
              <button className="alt" disabled={!live} onClick={() => camera.switchCamera()}>{cam.facing === "environment" ? "Switch to front camera" : "Switch to rear camera"}</button>
            </div>
            {v.manual.active && <p className="warnbox">Frame frozen. {v.msg}</p>}
          </div>
          <div className="side">
            <table><tbody>
              <tr><td>Secure context (HTTPS)</td><td className={cam.secure ? "ok" : "bad"}>{cam.secure ? "yes" : "NO — camera is blocked on plain http:// (except localhost)"}</td></tr>
              <tr><td>getUserMedia available</td><td className={cam.supported ? "ok" : "bad"}>{cam.supported ? "yes" : "no"}</td></tr>
              <tr><td>Permission</td><td>{cam.permission}</td></tr>
              <tr><td>Connection</td><td className={live ? "ok" : cam.status === "error" ? "bad" : "mute"}>{{ idle: "off", starting: "starting…", live: "live (frames arriving)", error: "error" }[cam.status]}</td></tr>
              <tr><td>Device</td><td>{cam.label || "–"}</td></tr>
              <tr><td>Facing requested / reported</td><td>{cam.facing} / {cam.reportedFacing}</td></tr>
              <tr><td>Resolution</td><td>{live ? `${cam.width}×${cam.height}` : "–"}</td></tr>
              <tr><td>Last frame</td><td>{live && cam.frameAge !== null ? `${cam.frameAge} ms ago` : "–"}</td></tr>
              <tr><td>Vision frame rate</td><td>{live ? `${f(v.fps, 1)} /s (processed at ${v.procW}×${v.procH})` : "–"}</td></tr>
            </tbody></table>
            {cam.error && <p className="note bad">{cam.error}</p>}
            <p className="note">A desktop or laptop shows its webcam here, which is fine for testing the pipeline. The rear camera is chosen first on phones; the “reported” facing shows what the browser actually gave you.</p>
          </div>
        </div>
      </section>

      <section>
        <h2>1b. Floor calibration (manual four corners → homography)</h2>
        <CalibControls />
        <div className="split">
          <div>
            <table><tbody>
              <tr><td>Calibration</td><td className={v.calib.phase === "locked" ? "ok" : ""}>{{ off: "not calibrated", tap: `tapping corners (${v.calib.pts.length}/4)`, edit: "adjusting – not locked yet", locked: v.lost ? "locked, but tracking LOST (static grid shown)" : "locked (grid follows the floor by optical flow)" }[v.calib.phase]}</td></tr>
              <tr><td>Automatic grout detection</td><td>{v.calib.phase !== "locked" ? "runs after locking" : !v.grout.v && !v.grout.h ? "checking…" : `vertical line: ${v.grout.v?.ok ? `found, ${v.grout.v.offPx.toFixed(1)} px from the grid (${v.grout.v.why})` : `not confident – ${v.grout.v?.why ?? "…"}`} · horizontal line: ${v.grout.h?.ok ? `found, ${v.grout.h.offPx.toFixed(1)} px from the grid (${v.grout.h.why})` : `not confident – ${v.grout.h?.why ?? "…"}`}`}</td></tr>
              <tr><td>Tracking</td><td>{v.calib.phase !== "locked" ? "–" : v.lost ? "LOST – position held at last fix" : v.fix?.source === "flow" ? `optical flow, ${v.flowFeatures} features, ${f(v.flowPathMm)} mm moved since the fix (drifts)` : "calibration fix"}</td></tr>
              <tr><td>Floor point under image centre</td><td>{(() => { const H = v.H; const Hi = H && !v.lost ? inv3(H) : null; if (!Hi || !v.procW) return "–"; const p = apply(Hi, { x: v.procW / 2, y: v.procH / 2 }); const t = tileAt(FLOOR, p.x, p.y); return `X ${f(p.x)} / Y ${f(p.y)} mm${t ? ` (${t.id})` : " (outside)"} – where the camera LOOKS, not where the phone is`; })()}</td></tr>
              <tr><td>Phone position (camera pose)</td><td>{fix && v.calib.phase === "locked" ? `${f(fix.phone.x)} / ${f(fix.phone.y)} mm, height ${f(fix.cam.z)} mm, ±${f(fix.sigma)} mm` : "–"}</td></tr>
            </tbody></table>
            <p className="note">Phone position needs the camera focal length. It is currently the <b>default estimate ({v.fScale} × image width), not a calibrated value</b>, so absolute phone X/Y is approximate and gets worse when the phone is tilted. The grid and the floor coordinates above do not depend on it. Hold the phone roughly flat. Tap the video after locking to read the floor X/Y of any point. Automatic grout detection only <i>checks</i> the grid: it never moves it unless you press “Snap to detected grout”, and it reports “not confident” on plain or reflective marble.</p>
          </div>
          <div className="side"><FloorMap2D /></div>
        </div>
      </section>

      <section>
        <h2>2. Detection and result</h2>
        <div className="row">
          <label className="inline"><input type="checkbox" checked={v.detectTiles} onChange={(e) => vision.setDetectTiles(e.target.checked)} /> Detect tile boundaries (candidate lines, cyan)</label>
          <label className="inline"><input type="checkbox" checked={v.flowOn} onChange={(e) => vision.setFlow(e.target.checked)} /> Optical-flow fallback (drifts)</label>
        </div>
        <p className="note">Tile-boundary detection finds straight edges (Sobel + Hough) and draws them for you to check. It is <b>not</b> used to compute position: a tile outline alone does not say which tile you are looking at or how far you are from it. Position comes from registered markers or from corners you tap. The optical-flow fallback follows the floor from the last marker or manual fix; its position and scale <b>drift</b> and it is off by default.</p>
        <table><tbody>
          <tr><td>Markers in view</td><td>{live ? (v.markers.length ? v.markers.map((m) => `ID ${m.id}${m.known ? " (registered)" : " (not registered)"}`).join(", ") : "none") : "–"}</td></tr>
          <tr><td>Candidate tile lines</td><td>{live && v.detectTiles ? `${v.segs.length} lines, ${v.lineCorners.length} intersections` : "off"}</td></tr>
          <tr><td>Position source</td><td>{!fix ? "none" : v.lost ? "LOST — holding last fix" : fix.source === "marker" ? "registered marker(s)" : fix.source === "manual" ? "manual tile corners" : "optical flow (drifts)"}</td></tr>
          <tr><td>Phone X / Y</td><td>{fix ? `${f(fix.phone.x)} mm / ${f(fix.phone.y)} mm` : "–"}{d.zone && fix ? ` · ${d.zone.id} (Zone ${d.zone.zone})` : d.outside && fix ? " · outside the floor" : ""}</td></tr>
          <tr><td>Camera height above floor</td><td>{fix ? `${f(fix.cam.z)} mm (tilt ${f(fix.tiltDeg)}° from straight down)` : "–"}</td></tr>
          <tr><td>Heading (image up)</td><td>{fix ? `${hd(fix.heading)}° clockwise from +Y` : "–"}</td></tr>
          <tr><td>Fit quality</td><td>{!fix ? "–" : fix.rmsPx !== null ? `marker fit error ${f(fix.rmsPx, 2)} px, ${fix.nMarkers} marker(s)` : fix.source === "flow" ? `${fix.inliers ?? 0} flow inliers; error grows with distance` : "four tapped corners (no redundancy)"}</td></tr>
          <tr><td>Uncertainty</td><td>{fix ? `±${f(fix.sigma)} mm (simple model, not measured)` : "–"}</td></tr>
          <tr><td>Status</td><td className={v.lost ? "bad" : ""}>{live ? v.msg : "Camera off."}</td></tr>
          {v.flowOn && <tr><td>Optical flow</td><td>{v.flowFeatures} features · {f(v.flowPathMm)} mm travelled since last marker/manual fix (drift grows with this)</td></tr>}
        </tbody></table>
        <div className="row"><button className="alt" onClick={() => vision.clearAnchor()}>Clear camera fix and trail</button></div>

        <h2 style={{ marginTop: 16 }}>Camera model</h2>
        <div className="fields">
          <label>Focal length (× image width)<input type="number" step="0.01" min="0.3" max="2" value={v.fScale} onChange={(e) => vision.setFScale(+e.target.value)} /></label>
          <span />
          <label>Camera offset right of phone centre (mm)<input type="number" value={v.offset.x} onChange={(e) => vision.setOffset({ x: +e.target.value, y: v.offset.y })} /></label>
          <label>Camera offset toward top edge (mm)<input type="number" value={v.offset.y} onChange={(e) => vision.setOffset({ x: v.offset.x, y: +e.target.value })} /></label>
        </div>
        <p className="note">The default focal length 0.75 × image width suits most phone main cameras (about 68° wide). Looking straight down at a marker, position does not depend on it; on tilted views it does, so hold the phone roughly flat. The offsets move the result from the camera lens to the phone’s centre (the lens is usually 20–40 mm from centre; measure yours or leave 0).</p>
      </section>

      <section>
        <h2>3. Advanced: single-tile corner fix (old method)</h2>
        <p className="note" style={{ marginTop: 0 }}>Use this when no marker is visible or when the floor’s tile lines cannot be found automatically. Choose what you can see, press Select, then tap its four corners on the frozen frame in this order: bottom-left, bottom-right, top-right, top-left of the <i>floor plan</i> (X to the right, Y up). Taps snap to a nearby cyan intersection if one exists.</p>
        <div className="row">
          <label className="inline">Region
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="all">Whole floor (4 tiles, 1200 × 1200 mm)</option>
              {[0, 1, 2, 3].map((i) => <option key={i} value={i}>Tile R{Math.floor(i / 2) + 1}C{(i % 2) + 1}</option>)}
            </select>
          </label>
          <button disabled={!live || v.manual.active} onClick={() => { vision.beginManual(region === "all" ? "all" : +region); document.querySelector("[data-camview]")?.scrollIntoView({ block: "center", behavior: "smooth" }); }}>Select corners</button>
          <button className="alt" disabled={!v.manual.active || !v.manual.pts.length} onClick={() => vision.undoManual()}>Undo last</button>
          <button className="alt" disabled={!v.manual.active} onClick={() => vision.cancelManual()}>Cancel</button>
        </div>
        <p className="note">Four taps define the plane exactly, so there is no redundancy to check them against; tap carefully. The fix is valid for that frame. Turn on the optical-flow fallback to follow the floor afterwards, or move a registered marker into view.</p>
      </section>

      <section>
        <h2>4. Marker calibration (known floor coordinates)</h2>
        <p className="note" style={{ marginTop: 0 }}>Dictionary {DICTIONARY} (ArUco, IDs 0–249). Register where each printed marker’s <b>centre</b> lies on the floor (origin at the bottom-left corner of the floor, X right, Y up, mm), its printed side length, and the direction its top edge faces (° clockwise from +Y). Stored in this browser only.</p>
        <div className="mtable">
          <div className="mrow mhead"><span>ID</span><span>X (mm)</span><span>Y (mm)</span><span>Size (mm)</span><span>Top edge (°)</span><span /></div>
          {defs.map((m, i) => (
            <div className="mrow" key={i}>
              <input type="number" min="0" max="249" value={m.id} onChange={(e) => setDef(i, "id", Math.max(0, Math.min(249, Math.round(+e.target.value))))} aria-label="ID" />
              <input type="number" value={m.x} onChange={(e) => setDef(i, "x", +e.target.value)} aria-label="X" />
              <input type="number" value={m.y} onChange={(e) => setDef(i, "y", +e.target.value)} aria-label="Y" />
              <input type="number" min="10" value={m.size} onChange={(e) => setDef(i, "size", Math.max(10, +e.target.value))} aria-label="Size" />
              <input type="number" value={m.rot} onChange={(e) => setDef(i, "rot", +e.target.value)} aria-label="Rotation" />
              <button className="alt" onClick={() => markerRegistry.set(defs.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
        </div>
        <div className="row">
          <button className="alt" onClick={() => markerRegistry.set([...defs, { id: nextId(), x: 600, y: 600, size: 100, rot: 0 }])}>Add marker</button>
          <button className="alt" onClick={() => markerRegistry.reset()}>Reset to the four tile centres</button>
        </div>
        <p className="note">Default: IDs 0–3 at the centres of tiles R1C1, R1C2, R2C1, R2C2, 100 mm, top edge facing +Y. If you tape a marker elsewhere, edit its row. A wrong coordinate gives a wrong position and a large “fit error”.</p>
      </section>

      <section className="printable">
        <h2>5. Printable markers</h2>
        <div className="row noprint"><button onClick={() => window.print()}>Print markers</button></div>
        <p className="note noprint">Print at 100% scale (no “fit to page”) and measure one black square with a ruler: it must match the size in the table. Stick each marker flat on the floor with its top edge facing the registered direction, centre on the registered point. Matte paper avoids glare.</p>
        <div className="sheet">
          {defs.map((m) => (
            <figure key={m.id}>
              <div dangerouslySetInnerHTML={{ __html: markerSvg(m.id, m.size) }} />
              <figcaption>ID {m.id} · centre X {m.x}, Y {m.y} mm · black square {m.size} mm · top edge ↑ {m.rot}°</figcaption>
            </figure>
          ))}
        </div>
      </section>
    </>
  );
}
