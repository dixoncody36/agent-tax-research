// Pure globe camera/zoom math (#21): no three.js, unit-tested in
// globeControls.test.ts. latLngToVec mirrors Globe.tsx's render
// convention exactly — keep the two in sync.

export const ZOOM_MIN = 1.45;
export const ZOOM_MAX = 6;
export const ZOOM_HOME = 3.2;

const rad = (d: number) => (d * Math.PI) / 180;

export function clampZoom(d: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, d));
}

export function zoomBy(current: number, factor: number): number {
  return clampZoom(current * factor);
}

export function latLngToVec(lat: number, lng: number, radius: number): [number, number, number] {
  const phi = rad(90 - lat);
  const theta = rad(lng + 180);
  return [
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
}

/**
 * Euler angles (three.js XYZ order: Ry applied, then Rx) that rotate
 * the given lat/lng to face the camera (+Z). Derived in the tests.
 */
export function focusAngles(lat: number, lng: number): { x: number; y: number } {
  const [vx, vy, vz] = latLngToVec(lat, lng, 1);
  const y = -Math.atan2(vx, vz);
  const x = Math.atan2(vy, Math.hypot(vx, vz));
  return { x, y };
}

/** Signed shortest angular distance from `from` to `to` (radians). */
export function shortestAngleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
