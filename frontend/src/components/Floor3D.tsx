import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TState } from "../tracking/tracker";
import { Pt, tileAt } from "../tracking/grid";

// Scene units are millimetres. Room X -> scene x, room Y -> scene -z (so +Y points "up" on a top view).
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";

function textPlane(lines: string[], w: number, h: number, color: string): THREE.Mesh {
  const c = document.createElement("canvas"); c.width = 256; c.height = Math.round(256 * h / w);
  const g = c.getContext("2d")!; g.fillStyle = color; g.textAlign = "center"; g.textBaseline = "middle";
  lines.forEach((t, i) => { g.font = `${i ? 30 : 56}px system-ui,sans-serif`; g.fillText(t, 128, c.height * (lines.length === 1 ? 0.5 : i ? 0.72 : 0.36)); });
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; return m;
}

export default function Floor3D({ t, onPick }: { t: TState; onPick: (p: Pt) => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const stRef = useRef(t); stRef.current = t;
  const pickRef = useRef(onPick); pickRef.current = onPick;
  const view = useRef<(v: "top" | "iso") => void>(() => {});
  const [err, setErr] = useState("");

  useEffect(() => {
    const el = mount.current!, cfg = stRef.current.cfg, cols = stRef.current.cols, rows = stRef.current.rows;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch { setErr("3D view is unavailable: this browser could not start WebGL."); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(css("--tile"));
    const cam = new THREE.PerspectiveCamera(40, 1, 10, 12000);
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(600, 1800, 400); scene.add(sun);
    const cx = cfg.roomL / 2, cz = -cfg.roomB / 2;
    const ink = css("--ink");

    const base = new THREE.Mesh(new THREE.BoxGeometry(cfg.roomL + 30, 6, cfg.roomB + 30), new THREE.MeshStandardMaterial({ color: 0x2a313c }));
    base.position.set(cx, -3, cz); scene.add(base);

    const GAP = 10, TH = 16, idle = [0xd9dde3, 0xc6ccd5];
    const tiles: THREE.Mesh[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(cfg.tileL - GAP, TH, cfg.tileB - GAP), new THREE.MeshStandardMaterial({ color: idle[(r + c) % 2] }));
      const x = c * cfg.tileL + cfg.tileL / 2, y = r * cfg.tileB + cfg.tileB / 2;
      m.position.set(x, TH / 2, -y); scene.add(m); tiles.push(m);
      const lab = textPlane([`R${r + 1}C${c + 1}`, `Zone ${r * cols + c + 1}`], 360, 180, "#1c2230");
      lab.position.set(x, TH + 1, -y); scene.add(lab);
    }
    // axis tick labels, in mm
    for (let i = 0; i <= cols; i++) { const l = textPlane([String(i * cfg.tileL)], 120, 60, ink); l.position.set(i * cfg.tileL, 1, 55); scene.add(l); }
    for (let i = 0; i <= rows; i++) { const l = textPlane([String(i * cfg.tileB)], 120, 60, ink); l.position.set(-75, 1, -i * cfg.tileB); scene.add(l); }
    const ax = textPlane(["X (mm)"], 200, 60, ink); ax.position.set(cx, 1, 120); scene.add(ax);
    const ay = textPlane(["Y (mm)"], 200, 60, ink); ay.position.set(-135, 1, cz); ay.rotation.z = Math.PI / 2; scene.add(ay);

    // start marker
    const startM = new THREE.Mesh(new THREE.RingGeometry(18, 28, 32), new THREE.MeshBasicMaterial({ color: 0x1c2230, side: THREE.DoubleSide }));
    startM.rotation.x = -Math.PI / 2; startM.position.y = TH + 2; scene.add(startM);
    // uncertainty disc
    const unc = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: 0x0b6e8a, transparent: true, opacity: 0.16, depthWrite: false }));
    unc.rotation.x = -Math.PI / 2; unc.position.y = TH + 2; unc.visible = false; scene.add(unc);
    // trail
    const trailLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xe8590c }));
    const trailPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xe8590c, size: 14, sizeAttenuation: true }));
    trailLine.visible = false; trailPts.visible = false; scene.add(trailLine, trailPts);
    // phone (75 x 150 x 8 mm) with a heading arrow
    const phone = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(75, 8, 150), new THREE.MeshStandardMaterial({ color: 0x1b2029 }));
    const screen = new THREE.Mesh(new THREE.BoxGeometry(67, 1, 136), new THREE.MeshStandardMaterial({ color: 0x4fc1de, emissive: 0x0b6e8a, emissiveIntensity: 0.6 }));
    screen.position.y = 4.2;
    const cam2 = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 2, 16), new THREE.MeshBasicMaterial({ color: 0xffd43b })); cam2.position.set(0, 5.2, -64); // top edge marker
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 6, -80), 190, 0xe8590c, 60, 44);
    phone.add(body, screen, cam2, arrow); phone.position.set(cx, TH + 4, cz); phone.visible = false; scene.add(phone);

    const controls = new OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true; controls.screenSpacePanning = true; controls.maxPolarAngle = Math.PI / 2.05; controls.minDistance = 300; controls.maxDistance = 4500;
    const setView = (v: "top" | "iso") => {
      controls.target.set(cx, 0, cz);
      if (v === "top") cam.position.set(cx, 2300, cz + 40); else cam.position.set(cx - 900, 1250, cz + 1350);
      cam.lookAt(controls.target); controls.update();
    };
    view.current = setView; setView("iso");

    const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); cam.aspect = w / Math.max(h, 1); cam.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();

    // tap on the floor (not a drag) selects the start point
    let down: { x: number; y: number; t: number } | null = null;
    const dom = renderer.domElement, ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TH);
    const pd = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
    const pu = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 500) return;
      const b = dom.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), cam);
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(plane, hit) && hit.x >= 0 && hit.x <= cfg.roomL && -hit.z >= 0 && -hit.z <= cfg.roomB) pickRef.current({ x: hit.x, y: -hit.z });
    };
    dom.addEventListener("pointerdown", pd); dom.addEventListener("pointerup", pu);

    let lastTrail: unknown = null, lastIdx = -2, raf = 0, lastRot = 0;
    const hi = new THREE.Color(0x2fb5a0);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = stRef.current;
      startM.position.set(s.start.x, TH + 2, -s.start.y);
      if (s.pos) {
        phone.visible = true;
        phone.position.x += (s.pos.x - phone.position.x) * 0.25; phone.position.z += (-s.pos.y - phone.position.z) * 0.25; phone.position.y = TH + 4;
        const want = -((s.heading ?? 0) * Math.PI) / 180; let d = want - lastRot; d = Math.atan2(Math.sin(d), Math.cos(d)); lastRot += d * 0.3; phone.rotation.y = lastRot;
      } else phone.visible = false;
      const hit = s.pos ? tileAt(s.cfg, s.pos.x, s.pos.y) : null, idx = hit ? hit.row * cols + hit.col : -1;
      if (idx !== lastIdx) {
        tiles.forEach((m, i) => { const mat = m.material as THREE.MeshStandardMaterial; if (i === idx) { mat.color.copy(hi); mat.emissive.set(0x0f5f52); } else { mat.color.set(idle[(Math.floor(i / cols) + (i % cols)) % 2]); mat.emissive.set(0x000000); } });
        lastIdx = idx;
      }
      if (s.trail !== lastTrail) {
        lastTrail = s.trail;
        const arr = new Float32Array(s.trail.length * 3); s.trail.forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = TH + 3; arr[i * 3 + 2] = -p.y; });
        trailLine.geometry.dispose(); trailPts.geometry.dispose();
        trailLine.geometry = new THREE.BufferGeometry(); trailLine.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
        trailPts.geometry = new THREE.BufferGeometry(); trailPts.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
        trailLine.visible = s.trail.length > 1; trailPts.visible = s.trail.length > 0;
      }
      if (s.sigma !== null && s.pos && s.status !== "not-calibrated") { unc.visible = true; unc.scale.set(s.sigma, s.sigma, 1); unc.position.set(s.pos.x, TH + 2, -s.pos.y); } else unc.visible = false;
      controls.update(); renderer.render(scene, cam);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      dom.removeEventListener("pointerdown", pd); dom.removeEventListener("pointerup", pu);
      renderer.dispose(); if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div>
      <div className="three" ref={mount} />
      {err && <p className="note bad">{err}</p>}
      <div className="row">
        <button className="alt" onClick={() => view.current("top")}>Top view</button>
        <button className="alt" onClick={() => view.current("iso")}>Isometric 3D view</button>
      </div>
      <p className="note">Drag to rotate, pinch or scroll to zoom, two-finger drag (or right-drag) to pan. Tap the floor to choose the start point before calibrating.</p>
    </div>
  );
}
