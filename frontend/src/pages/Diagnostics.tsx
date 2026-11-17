import { useState } from "react";
import { manager, SensorView, Tone } from "../sensors/sensorManager";
import { useSensors } from "../sensors/useSensors";
import { deviceInfo } from "../sensors/deviceInfo";
import { toCSV, toJSON, download } from "../sensors/export";
import { TESTS, runTest } from "../sensors/validation";

const f = (v: number | null, d: number) => (v === null ? "–" : v.toFixed(d));
function liveText(v: SensorView): string {
  if (!v.count) return "–";
  if (v.key === "ori") return `α ${f(v.v[0], 1)} · β ${f(v.v[1], 1)} · γ ${f(v.v[2], 1)} ${v.unit}`;
  if (v.key === "cmp") return `${f(v.v[0], 0)} ${v.unit}`;
  const d = v.key === "mag" ? 1 : 2;
  return `X ${f(v.v[0], d)} · Y ${f(v.v[1], d)} · Z ${f(v.v[2], d)} ${v.unit}`;
}

export default function Diagnostics() {
  const snap = useSensors();
  const [results, setResults] = useState<Record<string, [Tone, string]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [ref, setRef] = useState<{ at: string; v: Record<string, (number | null)[]> } | null>(null);
  const [cmp, setCmp] = useState("");

  const run = async (id: string) => {
    const t = TESTS.find((x) => x.id === id)!;
    if (busy) return;
    setBusy(id);
    setResults((r) => ({ ...r, [id]: ["mute", `Recording for ${t.secs} s. ${t.say}`] }));
    const res = await runTest(t);
    setResults((r) => ({ ...r, [id]: res }));
    setBusy(null);
  };
  const view = (k: string) => snap.views.find((v) => v.key === k)!;
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

  return (
    <>
      {window.self !== window.top && <div className="warnbox">This page is inside a frame, which can block sensors. If nothing arrives, open it directly in your phone’s browser.</div>}
      <section>
        <h2>Sensor diagnostics</h2>
        <div className="row">
          <button disabled={snap.running} onClick={() => manager.start()}>Start Sensors</button>
          <button className="alt" disabled={!snap.running} onClick={() => manager.stop()}>Stop Sensors</button>
        </div>
        {snap.views.map((v) => (
          <div className="sx" key={v.key}>
            <div className="h"><span>{v.name}</span><span className={`badge ${v.tone}`}>{v.status}</span></div>
            <div className="val">{liveText(v)}</div>
            <div className="meta">
              {v.count > 0 ? [`Source: ${v.src}`, v.kind, v.hz ? `${v.hz.toFixed(1)} Hz` : "", `${v.count} readings`, `last update ${v.last.slice(11, 23)} UTC`].filter(Boolean).join(" · ") : v.error || v.hint}
            </div>
          </div>
        ))}
        {snap.errors.length > 0 && <pre className="errs">{snap.errors.join("\n")}</pre>}
      </section>

      <section>
        <h2>Device and permissions</h2>
        <table><tbody>{deviceInfo(snap.perm).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
      </section>

      <section>
        <h2>Validation tests</h2>
        <p className="note">Start the sensors, then run each test and follow the instruction. Results come from the readings received during the test.</p>
        {TESTS.map((t) => (
          <div className="t" key={t.id}>
            <b>{t.name}</b><span className="meta">{t.say}</span>
            <div><button className="alt" disabled={!!busy} onClick={() => run(t.id)}>Run ({t.secs} s)</button></div>
            {results[t.id] && <span className={`val ${results[t.id][0]}`}>{results[t.id][1]}</span>}
          </div>
        ))}
        <div className="t">
          <b>5. Return to the starting position</b>
          <span className="meta">Save the current state, move the phone, put it back, then compare. This only reports the new readings. It makes no position correction.</span>
          <div className="row">
            <button className="alt" onClick={() => {
              const acc = view("acc"), ori = view("ori");
              if (!snap.running || (!acc.count && !ori.count)) { setCmp("Start the sensors and wait for readings first."); return; }
              setRef({ at: new Date().toLocaleTimeString(), v: { acc: acc.v, ori: ori.v } }); setCmp("Reference saved.");
            }}>Save reference</button>
            <button className="alt" onClick={() => {
              if (!ref) { setCmp("Save a reference first."); return; }
              const acc = view("acc"), ori = view("ori"), d = (a: number | null, b: number | null, n: number) => (a === null || b === null ? "–" : (a - b).toFixed(n));
              setCmp(`Compared with the reference from ${ref.at}. No position correction applied.\nAcceleration change: ΔX ${d(acc.v[0], ref.v.acc[0], 2)}, ΔY ${d(acc.v[1], ref.v.acc[1], 2)}, ΔZ ${d(acc.v[2], ref.v.acc[2], 2)} m/s²\nOrientation change: Δα ${d(ori.v[0], ref.v.ori[0], 1)}°, Δβ ${d(ori.v[1], ref.v.ori[1], 1)}°, Δγ ${d(ori.v[2], ref.v.ori[2], 1)}° (α wraps at 360°)\nCurrent: ${liveText(acc)} | ${liveText(ori)}`);
            }}>Compare now</button>
          </div>
          {cmp && <span className="val pre">{cmp}</span>}
        </div>
      </section>

      <section>
        <h2>Data logging</h2>
        <div className="row">
          <button onClick={() => manager.setLog(!snap.logOn)}>{snap.logOn ? "Stop recording" : "Start recording"}</button>
          <button className="alt" onClick={() => manager.clearLog()}>Clear</button>
          <button className="alt" disabled={!snap.logCount} onClick={() => download(`sensor-log-${stamp()}.csv`, toCSV(manager.rows, snap.perm), "text/csv")}>Export CSV</button>
          <button className="alt" disabled={!snap.logCount} onClick={() => download(`sensor-log-${stamp()}.json`, toJSON(manager.rows, snap), "application/json")}>Export JSON</button>
        </div>
        <p className="note">{snap.logCount} samples recorded{snap.logOn ? " (recording)" : ""}. Each row is one real sensor event; columns for other sensors stay empty on that row.</p>
      </section>
    </>
  );
}
