import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Geometry, Position } from "./geo-math.js";
import {
  resolveFromCandidates, stackComponents, type GeoCandidate,
} from "./geo-resolve.js";

// Fixture cascade (#38 acceptance): nested squares stand in for Texas
// (0..40), Travis (10..30), Austin (14..26), transit district (12..28,
// overlapping city + county) — downtown point (20,20) is inside all four.
const box = (lo: number, hi: number): Geometry => ({
  type: "Polygon",
  coordinates: [[[lo, lo], [hi, lo], [hi, hi], [lo, hi], [lo, lo]] as Position[]],
});
const cand = (slug: string, name: string, level: string, lo: number, hi: number): GeoCandidate => ({
  slug, name, level, geoKind: "boundary",
  bbox: { minLat: lo, maxLat: hi, minLng: lo, maxLng: hi },
  boundary: box(lo, hi), geometryHash: `hash-${slug}`,
});
const CANDIDATES: GeoCandidate[] = [
  cand("us-tx", "Texas", "state", 0, 40),
  cand("us-tx-travis", "Travis County", "county", 10, 30),
  cand("us-tx-austin", "Austin", "city", 14, 26),
  cand("us-tx-mta-3227999", "Austin MTA", "special_district", 12, 28),
  cand("us-tx-city-buda", "Buda", "city", 2, 8),
  { slug: "us-tx-spd-x", name: "Centroid Only SPD", level: "special_district", geoKind: "centroid", bbox: null, boundary: null, geometryHash: "hash-spd" },
];

describe("resolveFromCandidates (GEO-PIP fixtures)", () => {
  it("downtown point resolves the full cascade in level-rank order", () => {
    const { applicable } = resolveFromCandidates(CANDIDATES, 20, 20);
    assert.deepEqual(applicable.map((a) => a.slug), ["us-tx", "us-tx-travis", "us-tx-austin", "us-tx-mta-3227999"]);
    assert.ok(applicable.every((a) => a.geometryHash));
  });
  it("Buda-area point is in state + Buda, outside Travis/Austin", () => {
    const { applicable } = resolveFromCandidates(CANDIDATES, 5, 5);
    assert.deepEqual(applicable.map((a) => a.slug), ["us-tx", "us-tx-city-buda"]);
  });
  it("outside-Texas point resolves empty; centroid-only never claims", () => {
    const { applicable, centroidOnly } = resolveFromCandidates(CANDIDATES, 50, 50);
    assert.deepEqual(applicable, []);
    assert.deepEqual(centroidOnly, ["us-tx-spd-x"]);
  });
  it("boundary point counts inside and is flagged", () => {
    const { applicable } = resolveFromCandidates(CANDIDATES, 14, 20);
    const austin = applicable.find((a) => a.slug === "us-tx-austin");
    assert.equal(austin?.onBoundary, true);
  });
  it("re-performance: identical inputs reproduce identical resolution", () => {
    const a = resolveFromCandidates(CANDIDATES, 20, 20);
    const b = resolveFromCandidates(CANDIDATES, 20, 20);
    assert.deepEqual(a, b);
  });
});

describe("stackComponents (RATE-STACK fixtures)", () => {
  it("Austin fixture sums exactly 8.25 (6.25 + 1.00 + 1.00)", () => {
    const { combinedPercent } = stackComponents([
      { slug: "us-tx", rateValue: 6.25, rateUnit: "percent", appliesTo: null },
      { slug: "us-tx-austin", rateValue: 1, rateUnit: "percent", appliesTo: null },
      { slug: "us-tx-mta-3227999", rateValue: 1, rateUnit: "percent", appliesTo: null },
    ]);
    assert.equal(combinedPercent, 8.25);
  });
  it("non-percent components are listed, never summed into percent", () => {
    const { combinedPercent, nonPercent } = stackComponents([
      { slug: "us-tx", rateValue: 6.25, rateUnit: "percent", appliesTo: null },
      { slug: "us-tx", rateValue: 0.2, rateUnit: "usd_per_gallon", appliesTo: null },
    ]);
    assert.equal(combinedPercent, 6.25);
    assert.equal(nonPercent.length, 1);
  });
});
