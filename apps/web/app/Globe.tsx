"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { clampZoom, focusAngles, shortestAngleDelta, ZOOM_HOME, zoomBy } from "./globeControls";

export type GlobePoint = {
  slug: string; name: string; lat: number | null; lng: number | null;
  status: "verified" | "populated" | "blocked" | "held" | "skeleton";
  typeCount: number; verifiedQueue: number; publishedCount: number;
  geoStatus?: string; level?: string;
};

const COLORS: Record<GlobePoint["status"], number> = {
  verified: 0x35e08a, populated: 0x2ea3e8, blocked: 0xff6b6b, held: 0xffc857, skeleton: 0x7fa8c9,
};
const TEXAS = { lat: 30.6, lng: -98.4 };

// Equirectangular landmass texture drawn from the bundled Natural Earth
// asset (public domain, /ne-countries-110m.geojson) — no runtime CDN.
// Palette is deliberately high-contrast: pale land on deep ocean so
// coastlines read at demo distance (operator feedback #21).
async function makeLandTexture(): Promise<THREE.Texture | null> {
  try {
    const r = await fetch("/ne-countries-110m.geojson");
    if (!r.ok) return null;
    const fc = (await r.json()) as { features: { geometry: { type: string; coordinates: unknown } }[] };
    const W = 2048, H = 1024;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#0e3358");
    grad.addColorStop(0.5, "#0a2745");
    grad.addColorStop(1, "#071d33");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#4a7fa8";
    ctx.strokeStyle = "rgba(200,230,255,0.9)";
    ctx.lineWidth = 1.1;
    ctx.lineJoin = "round";
    const px = (lng: number) => ((lng + 180) / 360) * W;
    const py = (lat: number) => ((90 - lat) / 180) * H;
    for (const f of fc.features) {
      const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as number[][][][];
      for (const poly of polys) {
        const path = new Path2D();
        for (const ring of poly) {
          let started = false;
          let prevLng = 0;
          for (const [lng, lat] of ring as [number, number][]) {
            if (!started || Math.abs(lng - prevLng) > 180) { path.moveTo(px(lng), py(lat)); started = true; }
            else path.lineTo(px(lng), py(lat));
            prevLng = lng;
          }
          path.closePath();
        }
        ctx.fill(path, "evenodd");
        ctx.stroke(path);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  } catch { return null; }
}

function makeAtmosphere(radius: number): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vNormal;
      void main() {
        float intensity = pow(0.68 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
        gl_FragColor = vec4(0.2, 0.52, 0.85, 1.0) * intensity * 1.25;
      }`,
    blending: THREE.AdditiveBlending, side: THREE.BackSide, transparent: true, depthWrite: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 48), mat);
}

// Soft round sprite so markers never render as hard squares.
function makeSprite(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.95)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function latLngToVec3(lat: number, lng: number, radius: number): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lng + 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

type Controls = { zoom: (f: number) => void; reset: () => void; focusTexas: () => void };

export default function Globe({ points, onSelect, onPoint }: { points: GlobePoint[]; onSelect: (p: GlobePoint) => void; onPoint?: (lat: number, lng: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onPointRef = useRef(onPoint);
  onPointRef.current = onPoint;
  const controlsRef = useRef<Controls | null>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const zoomPctRef = useRef(100);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      canvas.insertAdjacentHTML("afterend", '<p class="err">WebGL unavailable in this browser; the data panels still work.</p>');
      return;
    }
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 16 / 10, 0.1, 100);
    let camDist = ZOOM_HOME;
    let camTarget = ZOOM_HOME;
    camera.position.z = camDist;

    const R = 1;
    const group = new THREE.Group();
    scene.add(group);

    // Ocean sphere — material color must go white once the map lands,
    // or navy multiplies the texture and kills contrast (#21).
    const sphereMat = new THREE.MeshStandardMaterial({ color: 0x0a2745, roughness: 0.8, metalness: 0.05 });
    let alive = true;
    void makeLandTexture().then((tex) => {
      if (tex && alive) { sphereMat.map = tex; sphereMat.color.setHex(0xffffff); sphereMat.needsUpdate = true; }
    });
    const stars = (() => {
      const n = 1100;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const v = new THREE.Vector3().randomDirection().multiplyScalar(30);
        pos.set([v.x, v.y, v.z], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbfe0ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.9 }));
    })();
    scene.add(stars);
    scene.add(makeAtmosphere(R * 1.16));
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 64), sphereMat);
    group.add(sphere);

    // Graticule — subtle now that real coastlines carry the geography.
    const graticuleMat = new THREE.LineBasicMaterial({ color: 0x3d6f9e, transparent: true, opacity: 0.28 });
    for (let lat = -75; lat <= 75; lat += 15) {
      const pts: THREE.Vector3[] = [];
      for (let lng = -180; lng <= 180; lng += 5) pts.push(latLngToVec3(lat, lng, R * 1.002));
      group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), graticuleMat));
    }
    for (let lng = -180; lng < 180; lng += 15) {
      const pts: THREE.Vector3[] = [];
      for (let lat = -90; lat <= 90; lat += 5) pts.push(latLngToVec3(lat, lng, R * 1.002));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), graticuleMat));
    }

    // Jurisdiction markers by level bucket (zoom level-of-detail):
    // world pins always, counties mid-zoom, cities close-zoom — with
    // 1,400+ Texas points published, one undifferentiated cloud is mush.
    const sprite = makeSprite();
    const mkMarkers = (list: GlobePoint[], size: number) => {
      const positions = new Float32Array(list.length * 3);
      const colors = new Float32Array(list.length * 3);
      const color = new THREE.Color();
      list.forEach((p, i) => {
        const v = latLngToVec3(p.lat!, p.lng!, R * 1.012);
        positions.set([v.x, v.y, v.z], i * 3);
        color.setHex(COLORS[p.status]);
        colors.set([color.r, color.g, color.b], i * 3);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({
        size, map: sprite, vertexColors: true, transparent: true, opacity: 0.95,
        depthWrite: false, sizeAttenuation: true,
      }));
      pts.userData.points = list;
      group.add(pts);
      return pts;
    };
    const withCoords = pointsRef.current.filter((p) => p.lat !== null && p.lng !== null);
    const worldMarkers = mkMarkers(withCoords.filter((p) => p.level !== "county" && p.level !== "city"), 0.05);
    const countyMarkers = mkMarkers(withCoords.filter((p) => p.level === "county"), 0.034);
    const cityMarkers = mkMarkers(withCoords.filter((p) => p.level === "city"), 0.026);
    const markerSets = [worldMarkers, countyMarkers, cityMarkers];
    countyMarkers.visible = false;
    cityMarkers.visible = false;

    // Lookup pin: ring dropped wherever the operator clicks a point.
    const pin = new THREE.Mesh(
      new THREE.RingGeometry(0.012, 0.02, 40),
      new THREE.MeshBasicMaterial({ color: 0xffc857, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    pin.visible = false;
    group.add(pin);
    const dropPin = (lat: number, lng: number) => {
      const v = latLngToVec3(lat, lng, R * 1.008);
      pin.position.copy(v);
      pin.lookAt(v.clone().multiplyScalar(2));
      pin.visible = true;
    };

    // Published boundary overlays: amber Texas outline, pale counties,
    // cities lazy-loaded the first time the operator zooms in close.
    const addBoundaryLines = async (level: string, colorHex: number, opacity: number) => {
      try {
        const r = await fetch(`/api/geo/boundaries?level=${level}`);
        if (!r.ok || !alive) return;
        const fc = (await r.json()) as { features: { geometry: { type: string; coordinates: unknown } }[] };
        const mat = new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity });
        for (const f of fc.features) {
          const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as number[][][][];
          for (const poly of polys) {
            for (const ring of poly) {
              const pts = ring.map(([lng, lat]) => latLngToVec3(lat!, lng!, R * 1.006));
              group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat));
            }
          }
        }
      } catch { /* overlay is best-effort; globe keeps working */ }
    };
    void addBoundaryLines("state", 0xffc857, 0.95);
    void addBoundaryLines("county", 0xa8d2ff, 0.55);
    let cityLinesLoaded = false;

    scene.add(new THREE.AmbientLight(0xd6e9ff, 1.7));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(5, 3, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x7fb2e5, 0.7);
    fill.position.set(-4, -2, -3);
    scene.add(fill);

    // Camera controls: drag rotate (1 pointer), pinch zoom (2 pointers),
    // wheel zoom, double-click step zoom; buttons via controlsRef.
    let focus: { x: number; y: number; dist: number } | null = null;
    controlsRef.current = {
      zoom: (f) => { camTarget = zoomBy(camTarget, f); },
      reset: () => { focus = { x: 0, y: group.rotation.y, dist: ZOOM_HOME }; camTarget = ZOOM_HOME; },
      focusTexas: () => {
        const a = focusAngles(TEXAS.lat, TEXAS.lng);
        focus = { x: a.x, y: a.y, dist: 1.9 };
        camTarget = 1.9;
      },
    };

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinchDist = 0;
    let hovering = false;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const onDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      focus = null;
      canvas.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (pinchDist > 0 && d > 0) camTarget = zoomBy(camTarget, pinchDist / d);
        pinchDist = d;
        moved += Math.abs(dx) + Math.abs(dy);
        return;
      }
      moved += Math.abs(dx) + Math.abs(dy);
      group.rotation.y += dx * 0.005;
      group.rotation.x = THREE.MathUtils.clamp(group.rotation.x + dy * 0.005, -1.2, 1.2);
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (moved > 4 || pointers.size > 0) return;
      const rect = canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      (ray.params.Points as { threshold: number }).threshold = 0.04;
      ray.setFromCamera(mouse, camera);
      for (const set of markerSets) {
        if (!set.visible) continue;
        const hit = ray.intersectObject(set)[0];
        if (hit && hit.index !== undefined) {
          const p = (set.userData.points as GlobePoint[])[hit.index];
          if (p) { onSelectRef.current(p); return; }
        }
      }
      if (onPointRef.current) {
        const sp = ray.intersectObject(sphere)[0];
        if (sp) {
          const local = group.worldToLocal(sp.point.clone()).normalize();
          const phi = Math.acos(THREE.MathUtils.clamp(local.y, -1, 1));
          const theta = Math.atan2(local.z, -local.x);
          let lngDeg = THREE.MathUtils.radToDeg(theta) - 180;
          if (lngDeg < -180) lngDeg += 360;
          const latDeg = 90 - THREE.MathUtils.radToDeg(phi);
          dropPin(latDeg, lngDeg);
          onPointRef.current(Number(latDeg.toFixed(6)), Number(lngDeg.toFixed(6)));
        }
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camTarget = zoomBy(camTarget, Math.exp(e.deltaY * 0.0011));
    };
    const onDblClick = () => { camTarget = zoomBy(camTarget, 0.65); };
    const onEnter = () => { hovering = true; };
    const onLeave = () => { hovering = false; pointers.clear(); };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("pointerenter", onEnter);
    canvas.addEventListener("pointerleave", onLeave);

    const resize = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    const tick = () => {
      if (focus) {
        group.rotation.x += shortestAngleDelta(group.rotation.x, focus.x) * 0.07;
        group.rotation.y += shortestAngleDelta(group.rotation.y, focus.y) * 0.07;
        camTarget = focus.dist;
        if (Math.abs(shortestAngleDelta(group.rotation.y, focus.y)) < 0.002 && Math.abs(group.rotation.x - focus.x) < 0.002) focus = null;
      } else if (pointers.size === 0 && !hovering && !reduceMotion && camDist > 2.7) {
        group.rotation.y += 0.0016;
      }
      camDist += (clampZoom(camTarget) - camDist) * 0.09;
      camera.position.z = camDist;
      countyMarkers.visible = camDist < 2.9;
      cityMarkers.visible = camDist < 2.15;
      if (camDist < 2.3 && !cityLinesLoaded) { cityLinesLoaded = true; void addBoundaryLines("city", 0x8be0c8, 0.45); }
      const pct = Math.round((ZOOM_HOME / camDist) * 100);
      if (pct !== zoomPctRef.current) { zoomPctRef.current = pct; setZoomPct(pct); }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      alive = false;
      controlsRef.current = null;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDblClick);
      canvas.removeEventListener("pointerenter", onEnter);
      canvas.removeEventListener("pointerleave", onLeave);
      renderer.dispose();
    };
  }, []); // points loaded before mount (page gates render until fetch resolves)

  const c = () => controlsRef.current;
  return (
    <div className="globe-wrap">
      <canvas ref={canvasRef} className="globe" aria-label="Jurisdictional globe: drag to rotate, scroll or pinch to zoom, click a marker or point for detail" />
      <div className="globe-tools" role="group" aria-label="Globe controls">
        <button type="button" className="btn" data-testid="globe-zoom-in" onClick={() => c()?.zoom(0.7)} title="Zoom in">+</button>
        <button type="button" className="btn" data-testid="globe-zoom-out" onClick={() => c()?.zoom(1.45)} title="Zoom out">−</button>
        <button type="button" className="btn secondary" data-testid="globe-focus-texas" onClick={() => c()?.focusTexas()}>Texas</button>
        <button type="button" className="btn secondary" data-testid="globe-reset" onClick={() => c()?.reset()}>Reset</button>
        <span className="globe-zoom-pct" aria-label={`Zoom ${zoomPct} percent`}>{zoomPct}%</span>
      </div>
      <p className="globe-hint">Drag to rotate · scroll / pinch / double-click to zoom · counties appear as you zoom in, cities closer still · click the globe to look up that point</p>
    </div>
  );
}
