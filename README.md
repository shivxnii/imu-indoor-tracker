# IMU Indoor Tracker

A web app (Vite + React + TypeScript) that reads the **real** motion sensors of the phone it is opened on, shows them in a diagnostics dashboard, and shows the estimated phone position live on a 3D model of a 2 × 2 tile floor. There is no backend: everything runs in the browser and no sensor data leaves the phone unless you export it yourself.

## Project layout

```
imu-indoor-tracker/
├── frontend/
│   ├── public/                 favicon
│   ├── src/
│   │   ├── sensors/            sensorManager.ts (the single real-sensor module), export, validation, device info
│   │   ├── tracking/           grid.ts (tile maths), tracker.ts (IMU engine), fusion.ts (hybrid + display), mode.ts
│   │   ├── camera/             cameraManager.ts (getUserMedia, permission + status, front/rear switch)
│   │   ├── vision/             engine.ts (marker pose, manual corners, optical flow), geometry.ts, markers.ts, flow.ts, lines.ts
│   │   ├── vendor/             js-aruco2 (MIT) ArUco detector, vendored as an ES module
│   │   ├── components/         Floor3D.tsx, CameraView.tsx (video + overlay), CameraPanel.tsx, ModeSelector.tsx
│   │   ├── pages/              Live3D.tsx, CameraPage.tsx, Diagnostics.tsx
│   │   └── App.tsx, main.tsx, styles.css
│   └── package.json, vite.config.ts, tsconfig.json, index.html
├── .env.example                optional settings (port, HTTPS, base path)
├── netlify.toml                public deploy settings
├── run.bat / run.ps1           start everything on Windows
└── .gitignore
```
A Python backend is not needed, so there is no `backend/` folder or `requirements.txt`.

## 1. Run on Windows (PowerShell)

Requirements: Node.js 18 or newer (`winget install OpenJS.NodeJS.LTS`, then reopen PowerShell).

```powershell
cd path\to\imu-indoor-tracker
powershell -ExecutionPolicy Bypass -File .\run.ps1
```
Or double-click `run.bat`. The first run installs dependencies, then prints a laptop URL and a phone URL. Open `https://localhost:5173` in Chrome or Edge and accept the self-signed certificate warning (Advanced, then Proceed).

Manual alternative:
```powershell
cd frontend
npm install
npm run dev
```

## 2. Open it on your Android phone (same Wi-Fi)

1. Connect the phone and laptop to the same Wi-Fi network.
2. Run `run.ps1`. It prints lines like `https://192.168.1.23:5173`.
3. On the phone, open that address in Chrome and choose Advanced, then Proceed (unsafe). The certificate is self-signed, and HTTPS is required for sensor access.
4. Tap **Start Sensors** and allow any sensor prompt.
5. If the phone cannot connect, allow Node.js through Windows Firewall for Private networks (a prompt appears the first time), and check that the Wi-Fi does not isolate clients (some guest or office networks do).

Plain `http://192.168.x.x` will **not** deliver sensor data in Chrome because it is not a secure context. Keep `HTTPS=1` (the default).

### Alternative: secure tunnel (any network, no certificate warning)
Copy `.env.example` to `.env` and set `HTTPS=0` (the tunnel provides HTTPS), start the dev server, then in a second PowerShell window:
```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:5173
```
It prints a public `https://….trycloudflare.com` URL that works on any phone until you close the command.

## 3. Deploy publicly so your manager can open it from anywhere

Deploy the built site to any static HTTPS host. Each phone runs the app itself and reads its own sensors, so two phones never share a stream.

**Netlify**
1. Push this folder to a GitHub repository.
2. In Netlify choose Add new site, then Import from Git, and pick the repository. `netlify.toml` already sets base `frontend`, the build command and the publish folder `dist`.
3. Send your manager the `https://….netlify.app` URL.

**Netlify drag-and-drop**: run `npm run build` in `frontend`, then drag the `dist` folder onto https://app.netlify.com/drop.

**Vercel**: import the repository, set Root Directory to `frontend`, preset Vite, deploy.

**Cloudflare Pages**: root directory `frontend`, build command `npm run build`, output directory `dist`.

**GitHub Pages**: set `BASE=/your-repo-name/` in `.env`, run `npm run build` in `frontend`, and publish the `dist` folder.

## 4. Using the app

Two tabs share the same real-sensor module (`sensors/sensorManager.ts`):

**Live 3D position tracking** (opens first)
1. Tap **Start Sensors** and allow any prompt. Wait until accelerometer and orientation show "live".
2. Choose the start point: type X/Y in mm, press a tile-centre button, or tap the floor in the 3D view. The open circle marks it.
3. Choose the initial direction the phone's top edge faces: 0° = up the map (+Y), 90° = right (+X), clockwise.
4. Put the phone flat, screen up, on that spot facing that way, and press **Calibrate Starting Position** (hold still for 2 s).
5. Press **Start Tracking**, then carry the phone flat in front of you and walk. The marker, heading arrow, highlighted tile and orange trail follow the estimate. **Pause**, **Resume**, **Reset Position**, **Recalibrate** and **Clear Movement Trail** are available.
6. Validation: walk into another tile, walk back to the start and press **Record return check**. The app shows the measured difference and never corrects it automatically.

Floor: 1200 × 1200 mm, four 600 × 600 mm tiles, origin at the bottom-left. Zone 1 = R1C1 (X 0–600, Y 0–600), Zone 2 = R1C2 (X 600–1200, Y 0–600), Zone 3 = R2C1 (X 0–600, Y 600–1200), Zone 4 = R2C2. Column = floor(X / 600), row = floor(Y / 600). Position updates use X += d·sin(heading), Y += d·cos(heading), with heading in degrees clockwise from +Y.

**Sensor diagnostics** (unchanged): Start/Stop, per-sensor status, units, Hz, last update, permissions, validation tests, CSV/JSON export. The raw magnetometer is reported honestly as unavailable when the browser does not expose it.

### How the positioning engine works, and its limits
- **Start position is declared by you.** An IMU cannot find its absolute location, so everything is relative to the calibration point.
- **Heading** integrates the gyroscope yaw rate, is pulled toward the orientation sensor, and is weakly corrected by the compass when it agrees (within 30°). It is only updated while the phone is roughly flat. Otherwise it is held and says so.
- **Walking mode** detects steps from the filtered accelerometer, scales the nominal step length slightly with step bounce, and moves the position one step at a time. Positions are clamped to the floor.
- **Sliding mode** keeps the position unchanged. Step detection does not measure sliding distance. The engine in `tracking/tracker.ts` is a self-contained class, so it can be replaced by a camera or AprilTag estimator with the same state fields.
- **Uncertainty** comes from a simple model (15% step-length error plus a heading-bias term). It is a planning figure, not a measured accuracy, and is hidden in sliding mode.
- All thresholds (step threshold 1.2 m/s², minimum step gap 350 ms, filter gains) are untested starting values. A 1.2 m floor is only two or three steps wide, so expect coarse results; tune them from your logs.

## 4b. Live camera tracking (added in this version)

A **Tracking mode** selector at the top of every page chooses what drives the 3D marker:

1. **IMU Tracking**: the original engine only.
2. **Live Camera Tracking**: position comes only from camera fixes.
3. **Hybrid Tracking (Camera + IMU)**: the IMU moves the estimate between camera observations; every absolute camera fix is blended in using both uncertainties and also corrects the IMU heading. If the two disagree by more than 3σ, the camera wins ("re-acquired"). The source of each update (IMU, Camera or Hybrid) is shown and logged.

Selecting Camera or Hybrid starts the camera (the click is the user gesture the browser needs). The **Camera & calibration** tab has the full controls.

**How the camera finds where the phone is**
- **Registered ArUco markers (recommended, absolute, no drift).** Print the markers (tab section 5), stick them flat on the floor, and register each one's centre (X, Y in mm, origin bottom-left of the floor), printed size and direction in the calibration table (section 4). The default is IDs 0–3 at the centres of the four tiles, 100 mm, top edge facing +Y. One visible marker is enough: its four corners give a floor-to-image homography, from which the camera pose and so the phone's X/Y, height and heading follow. Markers whose fit error exceeds 4 px are rejected.
- **Manual tile corners (when no marker is visible).** Section 3: choose the whole floor or one tile, press Select corners, tap its four corners (bottom-left, bottom-right, top-right, top-left of the floor plan) on the frozen frame. That gives one absolute fix.
- **Optical-flow fallback (off by default, drifts).** Tick it to keep following the floor from the last marker or manual fix. Position and scale **drift** and the app labels it that way. In hybrid mode flow is not used for corrections.
- **Tile-boundary detection (cyan).** Straight edges (Sobel + Hough) drawn over the video as candidates. They are **not** used for position, because a tile outline alone cannot say which tile you are looking at or how far you are from it. Plain or low-contrast floors may give none; use markers or manual corners then.

**Camera model.** The camera's focal length is assumed to be 0.75 × the image width (editable). Looking straight down, X/Y does not depend on it; on tilted views it does, so hold the phone roughly flat. The heading is the direction of the image's "up" edge (phone held in portrait). The camera lens is not at the phone's centre: enter its offset in the Camera model section to correct for it.

**When tracking is lost.** If no registered marker has been seen for 1.2 s (and optical flow, if on, has too few matches), the app shows "TRACKING LOST" over the video and in the status rows, and holds the last camera position. In hybrid mode the IMU carries on alone and the status says so.

**Confidence.** The app shows measured fit quality (marker reprojection error in px, number of markers) and an uncertainty in mm from a simple error model, labelled as a model. It shows no percentage "confidence".

**Phone use.** Open the same HTTPS address on the phone (section 2); camera permission needs HTTPS. Point the rear camera at the floor, roughly flat and 20–50 cm above it, so a marker (100 mm) fills a good part of the view. Use the front-camera button only to test; its mirror geometry is not corrected.

## 5. Status of features

**Implemented and verified here**
- Type-check and production build pass; dev server serves over HTTPS
- Camera pipeline checked in desktop Chromium with a *fake camera device* playing a rendered floor scene (real `getUserMedia`, real frames, rendered markers at known poses). Marker fixes matched the known poses to roughly 2–10 mm in X/Y, height within about 1% and heading within 1°; manual four-corner selection matched within about 3 mm; the lost-tracking message, optical-flow follow, hybrid blending and re-acquisition behaved as designed. This tests the code, not a real phone camera or real floor.
- Tile mapping, calibration, heading convention, step-to-position maths checked with synthetic samples in a development-only test (not shipped)

**Not yet tested (please verify on your phone)**
- A real phone camera: permission prompt, rear-camera choice, marker detection under your lighting and at your distance, printed marker size, the focal-length default
- Hybrid with real IMU steps (the camera test above had no motion sensors)
- Tile-line detection on your actual floor (tile contrast and grout colour decide whether it finds anything)
- Optical-flow drift on your floor
- The 3D scene rendering and touch controls (OrbitControls) on your Android phone
- Step detection and heading behaviour with real walking, and all thresholds
- Compass correction on your device
- Windows scripts (`run.ps1`, `run.bat`) on Windows

**Not implemented**
- Validated accuracy figures on your floor (the uncertainty is a model, not a measurement).
- Automatic localisation from tile outlines alone (deliberately not done, see 4b). AprilTag-family dictionaries (ArUco 36h12 is used).
- Lens distortion correction (phone cameras are close to rectilinear; strong wide-angle lenses will add error near the image edges).
- No backend or database.

## Troubleshooting
- *No sensor data*: use HTTPS, open the page directly (not in an embedded frame), and tap Start Sensors. Desktop browsers have no motion sensors and will report "Not supported".
- *Camera blocked*: use the https:// address (a certificate warning is fine), allow the camera in the browser's site settings, and close other apps using the camera.
- *Markers not detected*: print at 100% scale, keep them flat and matte, make sure the whole black square and a white margin are in view, and register the same IDs in the table.
- *Port in use*: change `PORT` in `.env`.
- *`run.ps1` blocked*: use the `-ExecutionPolicy Bypass` command above, or `run.bat`.
