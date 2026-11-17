import { useState } from "react";
import Diagnostics from "./pages/Diagnostics";
import Live3D from "./pages/Live3D";
import CameraPage from "./pages/CameraPage";
import Guided from "./pages/Guided";
import ModeSelector from "./components/ModeSelector";

export default function App() {
  const [tab, setTab] = useState<"guide" | "live" | "cam" | "diag">("guide");
  return (
    <main>
      <header>
        <h1>IMU Indoor Tracker</h1>
        <p className="lead">Everything shown here comes from the sensors of the phone running this page. Nothing is simulated, and nothing leaves the device.</p>
        <ModeSelector />
        <nav role="tablist">
          <button role="tab" aria-selected={tab === "guide"} className={tab === "guide" ? "" : "alt"} onClick={() => setTab("guide")}>Start here</button>
          <button role="tab" aria-selected={tab === "live"} className={tab === "live" ? "" : "alt"} onClick={() => setTab("live")}>Live 3D position tracking</button>
          <button role="tab" aria-selected={tab === "cam"} className={tab === "cam" ? "" : "alt"} onClick={() => setTab("cam")}>Camera &amp; calibration</button>
          <button role="tab" aria-selected={tab === "diag"} className={tab === "diag" ? "" : "alt"} onClick={() => setTab("diag")}>Sensor diagnostics</button>
        </nav>
      </header>
      {tab === "guide" ? <Guided /> : tab === "live" ? <Live3D /> : tab === "cam" ? <CameraPage /> : <Diagnostics />}
    </main>
  );
}
