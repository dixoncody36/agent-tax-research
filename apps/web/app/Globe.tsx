"use client";
import { useEffect, useRef } from "react";
import * as THREE from "three";

export type GlobePoint = {
  slug: string; name: string; lat: number | null; lng: number | null;
  status: "verified" | "populated" | "blocked" | "held" | "skeleton";
  typeCount: number; verifiedQueue: number; publishedCount: number;
};

const COLORS: Record<GlobePoint["status"], number> = {
  verified: 0x2ecc71, populated: 0x0085ca, blocked: 0xe05d5d, held: 0xf0b429, skeleton: 0x3d5a7a,
};

// Soft round sprite so markers never render as hard squares.
function makeSprite(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.9)");
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

export default function Globe({ points, onSelect }: { points: GlobePoint[]; onSelect: (p: GlobePoint) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

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
    camera.position.z = 3.2;

    const R = 1;
    const group = new THREE.Group();
    scene.add(group);

    // Ocean sphere
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(R, 64, 64),
      new THREE.MeshStandardMaterial({ color: 0x0a2238, roughness: 0.9, metalness: 0.05 }),
    );
    group.add(sphere);

    // Graticule (lat/lng lines) drawn as line loops
    const graticuleMat = new THREE.LineBasicMaterial({ color: 0x1e4a6b, transparent: true, opacity: 0.55 });
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

    // Jurisdiction markers
    const withCoords = pointsRef.current.filter((p) => p.lat !== null && p.lng !== null);
    const positions = new Float32Array(withCoords.length * 3);
    const colors = new Float32Array(withCoords.length * 3);
    const color = new THREE.Color();
    withCoords.forEach((p, i) => {
      const v = latLngToVec3(p.lat!, p.lng!, R * 1.012);
      positions.set([v.x, v.y, v.z], i * 3);
      color.setHex(COLORS[p.status]);
      colors.set([color.r, color.g, color.b], i * 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const markers = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.035, map: makeSprite(), vertexColors: true, transparent: true,
      depthWrite: false, sizeAttenuation: true,
    }));
    markers.userData.points = withCoords;
    group.add(markers);

    scene.add(new THREE.AmbientLight(0xbfd8f2, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(5, 3, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x5e8ab4, 0.5);
    fill.position.set(-4, -2, -3);
    scene.add(fill);

    // Interaction: drag to rotate; click selects nearest marker (raycast points).
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    let dragging = false;
    let moved = 0;
    let px = 0, py = 0;
    let hovering = false;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const onDown = (e: PointerEvent) => { dragging = true; moved = 0; px = e.clientX; py = e.clientY; canvas.setPointerCapture(e.pointerId); };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - px, dy = e.clientY - py;
      moved += Math.abs(dx) + Math.abs(dy);
      group.rotation.y += dx * 0.005;
      group.rotation.x = THREE.MathUtils.clamp(group.rotation.x + dy * 0.005, -1.2, 1.2);
      px = e.clientX; py = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      if (moved > 4) return;
      const rect = canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      (ray.params.Points as { threshold: number }).threshold = 0.04;
      ray.setFromCamera(mouse, camera);
      const hits = ray.intersectObject(markers);
      const hit = hits[0];
      if (hit && hit.index !== undefined) {
        const p = (markers.userData.points as GlobePoint[])[hit.index];
        if (p) onSelectRef.current(p);
      }
    };
    const onEnter = () => { hovering = true; };
    const onLeave = () => { hovering = false; };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
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
      // Slow auto-rotation for the demo (requested), paused on hover/drag/reduced-motion.
      if (!dragging && !hovering && !reduceMotion) group.rotation.y += 0.0016;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerenter", onEnter);
      canvas.removeEventListener("pointerleave", onLeave);
      renderer.dispose();
    };
  }, []); // points loaded before mount (page gates render until fetch resolves)

  return <canvas ref={canvasRef} className="globe" aria-label="Jurisdictional globe: drag to rotate, click a marker for detail" />;
}
