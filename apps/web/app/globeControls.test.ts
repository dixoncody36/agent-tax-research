import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampZoom, focusAngles, latLngToVec, shortestAngleDelta, zoomBy } from "./globeControls";

// Regression/guard tests for globe zoom + focus math (#21 reopen).
// Run from repo root:
//   pnpm --filter @agent-tax-research/cli exec tsx --test ../../apps/web/app/globeControls.test.ts

const rad = (d: number) => (d * Math.PI) / 180;
function applyFocus(lat: number, lng: number) {
  const v = latLngToVec(lat, lng, 1);
  const { x: beta, y: alpha } = focusAngles(lat, lng);
  // Ry(alpha) then Rx(beta), matching three.js Euler XYZ application.
  const x1 = v[0] * Math.cos(alpha) + v[2] * Math.sin(alpha);
  const z1 = -v[0] * Math.sin(alpha) + v[2] * Math.cos(alpha);
  const y2 = v[1] * Math.cos(beta) - z1 * Math.sin(beta);
  const z2 = v[1] * Math.sin(beta) + z1 * Math.cos(beta);
  return [x1, y2, z2] as const;
}

describe("clampZoom / zoomBy", () => {
  it("clamps camera distance to the usable band", () => {
    assert.equal(clampZoom(0.5), 1.45);
    assert.equal(clampZoom(99), 6);
    assert.equal(clampZoom(3.2), 3.2);
  });
  it("zoomBy scales and clamps", () => {
    assert.equal(zoomBy(3, 0.5), 1.5);
    assert.equal(zoomBy(1.5, 0.1), 1.45);
    assert.equal(zoomBy(5, 3), 6);
  });
});

describe("focusAngles", () => {
  it("brings Austin to the front (+Z)", () => {
    const [x, y, z] = applyFocus(30.2672, -97.7431);
    assert.ok(Math.abs(x) < 1e-9, `x=${x}`);
    assert.ok(Math.abs(y) < 1e-9, `y=${y}`);
    assert.ok(Math.abs(z - 1) < 1e-9, `z=${z}`);
  });
  it("brings Sydney to the front (southern/eastern hemispheres)", () => {
    const [x, y, z] = applyFocus(-33.87, 151.21);
    assert.ok(Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 && Math.abs(z - 1) < 1e-9);
  });
  it("latLngToVec matches the render convention (equator/prime meridian)", () => {
    const v = latLngToVec(0, 0, 2);
    assert.ok(Math.abs(v[0] - 2) < 1e-9 && Math.abs(v[1]) < 1e-9 && Math.abs(v[2]) < 1e-9, v.join(","));
    void rad;
  });
});

describe("shortestAngleDelta", () => {
  it("wraps across the ±π seam", () => {
    const d = shortestAngleDelta(Math.PI - 0.1, -Math.PI + 0.1);
    assert.ok(Math.abs(Math.abs(d) - 0.2) < 1e-9, `d=${d}`);
  });
});
