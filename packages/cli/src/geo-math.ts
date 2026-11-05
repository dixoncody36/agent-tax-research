import { createHash } from "node:crypto";

// Pure WGS84 GeoJSON math for M8 (#37 ingest, #38 resolve). GeoJSON
// positions are [lng, lat]; every public function here speaks lat/lng
// explicitly at its boundary so callers never swap them by accident.

export type Position = [number, number];
export type Polygon = { type: "Polygon"; coordinates: Position[][] };
export type MultiPolygon = { type: "MultiPolygon"; coordinates: Position[][][] };
export type Geometry = Polygon | MultiPolygon;
export type BBox = { minLat: number; maxLat: number; minLng: number; maxLng: number };

export function round6(n: number): number {
  return Number(n.toFixed(6));
}

function polygonsOf(g: Geometry): Position[][][] {
  return g.type === "Polygon" ? [g.coordinates] : g.coordinates;
}

export function bboxOf(g: Geometry): BBox {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const poly of polygonsOf(g)) {
    for (const ring of poly) {
      for (const [lng, lat] of ring) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
    }
  }
  return { minLat: round6(minLat), maxLat: round6(maxLat), minLng: round6(minLng), maxLng: round6(maxLng) };
}

/** Signed area + centroid of one ring (shoelace). Degenerate -> area 0. */
export function ringCentroid(ring: Position[]): { area: number; lng: number; lat: number } {
  let crossSum = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    const cross = x1 * y2 - x2 * y1;
    crossSum += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  const area = crossSum / 2;
  if (Math.abs(area) < 1e-12) return { area: 0, lng: ring[0]?.[0] ?? 0, lat: ring[0]?.[1] ?? 0 };
  return { area, lng: cx / (6 * area), lat: cy / (6 * area) };
}

/** Area-weighted centroid: outer rings add, holes subtract. */
export function geometryCentroid(g: Geometry): { lat: number; lng: number } {
  let totalArea = 0, sx = 0, sy = 0;
  for (const poly of polygonsOf(g)) {
    poly.forEach((ring, i) => {
      const { area, lng, lat } = ringCentroid(ring);
      const signed = i === 0 ? Math.abs(area) : -Math.abs(area);
      totalArea += signed;
      sx += lng * signed;
      sy += lat * signed;
    });
  }
  if (Math.abs(totalArea) < 1e-12) {
    const b = bboxOf(g);
    return { lat: round6((b.minLat + b.maxLat) / 2), lng: round6((b.minLng + b.maxLng) / 2) };
  }
  return { lat: round6(sy / totalArea), lng: round6(sx / totalArea) };
}

/**
 * A point guaranteed on the surface (#68): the true centroid when it falls
 * inside, else the midpoint of the widest inside segment across 19
 * scanlines. Ingest payloads use this for centroid_lat/lng (globe pins) —
 * an area centroid of a non-convex city can sit outside its own polygon
 * (Herington, Mulvane KS), which would pin the marker in another place.
 */
export function interiorPoint(g: Geometry): { lat: number; lng: number } {
  const c = geometryCentroid(g);
  if (pointInGeometry(g, c.lat, c.lng) !== "outside") return c;
  const b = bboxOf(g);
  let best: { lat: number; lng: number; width: number } | null = null;
  for (let i = 1; i < 20; i++) {
    const lat = b.minLat + ((b.maxLat - b.minLat) * i) / 20;
    const xs: number[] = [];
    for (const poly of polygonsOf(g)) {
      for (const ring of poly) {
        for (let k = 0; k < ring.length - 1; k++) {
          const [x1, y1] = ring[k]!;
          const [x2, y2] = ring[k + 1]!;
          if ((y1 > lat) !== (y2 > lat)) xs.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }
    xs.sort((a, z) => a - z);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const width = xs[k + 1]! - xs[k]!;
      if (!best || width > best.width) best = { lat, lng: (xs[k]! + xs[k + 1]!) / 2, width };
    }
  }
  return best ? { lat: round6(best.lat), lng: round6(best.lng) } : c;
}

export function inBBox(b: BBox, lat: number, lng: number): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

function onSegment(lat: number, lng: number, a: Position, b: Position): boolean {
  const [x1, y1] = a, [x2, y2] = b;
  const cross = (lng - x1) * (y2 - y1) - (lat - y1) * (x2 - x1);
  if (Math.abs(cross) > 1e-9) return false;
  const dot = (lng - x1) * (lng - x2) + (lat - y1) * (lat - y2);
  return dot <= 1e-9;
}

function ringContains(ring: Position[], lat: number, lng: number): "inside" | "outside" | "boundary" {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (onSegment(lat, lng, ring[j]!, ring[i]!)) return "boundary";
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? "inside" : "outside";
}

/**
 * GEO-PIP containment (027 register): ray-casting over Polygon/MultiPolygon
 * with holes; a point exactly on any ring is `boundary` (counts as inside
 * for applicability, flagged by the caller).
 */
export function pointInGeometry(g: Geometry, lat: number, lng: number): "inside" | "outside" | "boundary" {
  for (const poly of polygonsOf(g)) {
    const outer = ringContains(poly[0]!, lat, lng);
    if (outer === "boundary") return "boundary";
    if (outer === "outside") continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      const hole = ringContains(poly[i]!, lat, lng);
      if (hole === "boundary") return "boundary";
      if (hole === "inside") { inHole = true; break; }
    }
    if (!inHole) return "inside";
  }
  return "outside";
}

/** Stable JSON: object keys sorted recursively — hash input must not
 *  depend on the source's key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function geometryHash(g: Geometry): string {
  return createHash("sha256").update(canonicalJson(g)).digest("hex");
}

export function isGeometry(v: unknown): v is Geometry {
  if (!v || typeof v !== "object") return false;
  const t = (v as { type?: unknown }).type;
  return (t === "Polygon" || t === "MultiPolygon") && Array.isArray((v as { coordinates?: unknown }).coordinates);
}
