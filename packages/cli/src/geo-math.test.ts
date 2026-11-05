import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bboxOf, geometryCentroid, geometryHash, interiorPoint, pointInGeometry, ringCentroid,
  type Geometry, type Position,
} from "./geo-math.js";

// Unit square [lng 0..10] x [lat 0..10], donut square with hole 4..6.
const square: Geometry = {
  type: "Polygon",
  coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]] as Position[]],
};
const donut: Geometry = {
  type: "Polygon",
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]] as Position[],
    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]] as Position[],
  ],
};

describe("bboxOf / centroids", () => {
  it("bbox reads GeoJSON [lng,lat] order correctly", () => {
    assert.deepEqual(bboxOf(square), { minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 });
  });
  it("ring centroid of a square is its center", () => {
    const c = ringCentroid(square.coordinates[0]!);
    assert.equal(c.lng, 5);
    assert.equal(c.lat, 5);
  });
  it("geometry centroid subtracts holes symmetrically", () => {
    const c = geometryCentroid(donut);
    assert.equal(c.lat, 5);
    assert.equal(c.lng, 5);
  });
  it("multipolygon centroid is area-weighted", () => {
    const multi: Geometry = {
      type: "MultiPolygon",
      coordinates: [
        [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]] as Position[]],
        [[[10, 0], [11, 0], [11, 1], [10, 1], [10, 0]] as Position[]],
      ],
    };
    const c = geometryCentroid(multi);
    // areas 4 and 1, centers lng 1 and 10.5 -> (4 + 10.5) / 5 = 2.9
    assert.equal(c.lng, 2.9);
  });
});

describe("interiorPoint (#68)", () => {
  // C-shaped polygon: block [0..10]x[0..10] minus notch [4..10]x[4..6]
  // opening east — the area centroid lands in the notch (outside).
  const cShape: Geometry = {
    type: "Polygon",
    coordinates: [[[0, 0], [10, 0], [10, 4], [4, 4], [4, 6], [10, 6], [10, 10], [0, 10], [0, 0]] as Position[]],
  };
  it("true centroid of a C-shape falls outside; interiorPoint stays inside", () => {
    const c = geometryCentroid(cShape);
    assert.equal(pointInGeometry(cShape, c.lat, c.lng), "outside");
    const p = interiorPoint(cShape);
    assert.notEqual(pointInGeometry(cShape, p.lat, p.lng), "outside");
  });
  it("convex shapes keep the true centroid", () => {
    assert.deepEqual(interiorPoint(square), geometryCentroid(square));
  });
});

describe("pointInGeometry (GEO-PIP)", () => {
  it("inside / outside / boundary", () => {
    assert.equal(pointInGeometry(square, 5, 5), "inside");
    assert.equal(pointInGeometry(square, 15, 5), "outside");
    assert.equal(pointInGeometry(square, 0, 5), "boundary");
    assert.equal(pointInGeometry(square, 5, 0), "boundary");
  });
  it("hole points are outside, hole edge is boundary", () => {
    assert.equal(pointInGeometry(donut, 5, 5), "outside");
    assert.equal(pointInGeometry(donut, 5, 2), "inside");
    assert.equal(pointInGeometry(donut, 4, 5), "boundary");
  });
});

describe("geometryHash", () => {
  it("is stable under object key reordering", () => {
    const reordered = { coordinates: square.coordinates, type: "Polygon" } as unknown as Geometry;
    assert.equal(geometryHash(reordered), geometryHash(square));
  });
  it("changes when a vertex moves", () => {
    const moved: Geometry = {
      type: "Polygon",
      coordinates: [[[0, 0], [11, 0], [10, 10], [0, 10], [0, 0]] as Position[]],
    };
    assert.notEqual(geometryHash(moved), geometryHash(square));
  });
});
