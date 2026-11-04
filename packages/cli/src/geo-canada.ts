import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  client, db, exceptions, jurisdictionGeo, jurisdictions, proposalItems,
  proposals, researchLedger, sources, sourceSnapshots,
} from "@agent-tax-research/database";
import {
  bboxOf, canonicalJson, geometryCentroid, geometryHash, isGeometry,
  round6, type Geometry, type Position,
} from "./geo-math.js";

// Canada province/territory boundary ingest (issue #50). Authority:
// Statistics Canada province/territory boundary product — identified by its
// exact attribute schema (PRUID/PRNAME/PRENAME/PREABBR) as served by the
// PAVICS/Ouranos public GeoServer WFS (direct www12.statcan.gc.ca downloads
// are bot-walled from this network, recorded 2026-11; Esri/Natural Earth
// copies rejected). Fetch snapshots; Decision proposes jurisdiction_geo;
// distinct Reviewer verifies; human publishes. Mirrors geo-ingest.ts
// payload/proposal shape; simplification is Douglas-Peucker 0.001deg
// (same tolerance TIGERweb applies server-side for Texas) + 6dp rounding.
// Usage: tsx src/geo-canada.ts --fetch-run <uuid> --decision-run <uuid>

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const fetchRunId = arg("--fetch-run");
const decisionRunId = arg("--decision-run");
if (!fetchRunId || !decisionRunId) throw new Error("usage: geo-canada.ts --fetch-run <uuid> --decision-run <uuid>");

const WFS = "https://pavics.ouranos.ca/geoserver/public/ows";
const LAYER = "public:canada_admin_boundaries";
const SIMPLIFICATION = "douglas-peucker 0.001deg in degree space + 6dp coordinate rounding (client-side; mirrors TIGERweb maxAllowableOffset)";
const TOL = 0.001;
const today = new Date().toISOString().slice(0, 10);

const PRUID_TO_SLUG: Record<string, string> = {
  "10": "ca-nl", "11": "ca-pe", "12": "ca-ns", "13": "ca-nb", "24": "ca-qc",
  "35": "ca-on", "46": "ca-mb", "47": "ca-sk", "48": "ca-ab", "59": "ca-bc",
  "60": "ca-yt", "61": "ca-nt", "62": "ca-nu",
};

function perpDist(p: Position, a: Position, b: Position): number {
  const [x, y] = p; const [x1, y1] = a; const [x2, y2] = b;
  const dx = x2 - x1; const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(x - x1, y - y1);
  return Math.abs((x - x1) * dy - (y - y1) * dx) / len;
}

function simplifyRing(ring: Position[]): Position[] {
  if (ring.length <= 4) return ring;
  const keep = new Array<boolean>(ring.length).fill(false);
  keep[0] = keep[ring.length - 1] = true;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = 0; let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(ring[i]!, ring[lo]!, ring[hi]!);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0 && maxD > TOL) {
      keep[idx] = true;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

function countPoints(g: Geometry): number {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0);
}

function simplifyGeometry(g: Geometry): Geometry {
  const roundRing = (ring: Position[]): Position[] =>
    simplifyRing(ring).map(([x, y]) => [round6(x), round6(y)] as Position);
  if (g.type === "Polygon") {
    return { type: "Polygon", coordinates: g.coordinates.map(roundRing).filter((r) => r.length >= 4) };
  }
  return {
    type: "MultiPolygon",
    coordinates: g.coordinates
      .map((poly) => poly.map(roundRing).filter((r) => r.length >= 4))
      .filter((poly) => poly.length > 0),
  };
}

type WfsFeature = {
  properties: Record<string, unknown> | null;
  geometry: unknown;
};

async function fetchProvince(pruid: string): Promise<{ feature: WfsFeature; rawText: string }> {
  const qs = new URLSearchParams({
    SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature",
    TYPENAMES: LAYER, OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326",
    CQL_FILTER: `PRUID='${pruid}'`,
  });
  const res = await fetch(`${WFS}?${qs}`, { signal: AbortSignal.timeout(240_000) });
  if (!res.ok) throw new Error(`WFS PRUID=${pruid} HTTP ${res.status}`);
  const rawText = await res.text();
  const parsed = JSON.parse(rawText) as { features?: WfsFeature[] };
  const feature = parsed.features?.[0];
  if (!feature) throw new Error(`WFS PRUID=${pruid} returned no features`);
  return { feature, rawText };
}

async function ensureSource(caId: string) {
  const url = `${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${encodeURIComponent(LAYER)}`;
  const [existing] = await db.select().from(sources).where(eq(sources.url, url)).limit(1);
  if (existing) return existing;
  const [row] = await db.insert(sources).values({
    jurisdictionId: caId,
    name: "Statistics Canada Provinces/Territories boundaries via PAVICS GeoServer (canada_admin_boundaries)",
    url,
    sourceType: "dataset",
    publisher: "Statistics Canada",
    isAuthoritative: true,
    monitorCadence: "quarterly",
    checkMethod: "content_hash",
    publisherType: "government",
    eligibility: "eligible",
    notes: "Boundary authority for Canada jurisdiction_geo (#50). Data is the Statistics Canada province/territory boundary product (PRUID/PRNAME/PRENAME attribute schema) served by the PAVICS/Ouranos public GeoServer; direct www12.statcan.gc.ca downloads were bot-walled from this network (403, recorded 2026-11). Esri/Natural Earth republications rejected.",
  }).returning();
  return row!;
}

const [ca] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "ca")).limit(1);
if (!ca) throw new Error("ca jurisdiction missing");
const source = await ensureSource(ca.id);

const published = await db.select({ h: jurisdictionGeo.geometryHash }).from(jurisdictionGeo);
const knownHashes = new Set(published.map((r) => r.h).filter(Boolean));
const pendingItems = await db.select({ payload: proposalItems.payload }).from(proposalItems)
  .where(eq(proposalItems.targetTable, "jurisdiction_geo"));
for (const pi of pendingItems) {
  const h = (pi.payload as Record<string, unknown>).geometryHash;
  if (typeof h === "string") knownHashes.add(h);
}

type Prepared = {
  slug: string; pruid: string; name: string;
  payload: Record<string, unknown>; rawPoints: number; simpPoints: number;
};
const prepared: Prepared[] = [];
const unmatched: { name: string; reason: string }[] = [];
const rawFeatureSha256: Record<string, string> = {};
const snapshotFeatures: { type: "Feature"; properties: Record<string, unknown>; geometry: Geometry }[] = [];
let reused = 0;

for (const [pruid, slug] of Object.entries(PRUID_TO_SLUG)) {
  const { feature, rawText } = await fetchProvince(pruid);
  rawFeatureSha256[pruid] = createHash("sha256").update(JSON.stringify(feature)).digest("hex");
  void rawText;
  const props = feature.properties ?? {};
  const name = String(props.PRENAME ?? props.PRNAME ?? slug);
  if (!isGeometry(feature.geometry)) { unmatched.push({ name, reason: "no_polygon_geometry" }); continue; }
  const raw = feature.geometry as Geometry;
  const bbRaw = bboxOf(raw);
  // GeoJSON must be lng/lat; Canada extents double as the axis-order assert.
  if (!(bbRaw.minLng >= -180 && bbRaw.maxLng <= -40 && bbRaw.minLat >= 40 && bbRaw.maxLat <= 90)) {
    unmatched.push({ name, reason: `bbox_axis_suspect ${JSON.stringify(bbRaw)}` });
    continue;
  }
  const [jur] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  if (!jur) { unmatched.push({ name, reason: "no_registered_jurisdiction" }); continue; }

  const simp = simplifyGeometry(raw);
  snapshotFeatures.push({ type: "Feature", properties: { PRUID: pruid, PRENAME: name }, geometry: simp });
  const hash = geometryHash(simp);
  if (knownHashes.has(hash)) { reused += 1; console.log(`REUSED ${slug} hash=${hash.slice(0, 12)}`); continue; }
  knownHashes.add(hash);
  const bb = bboxOf(simp);
  const c = geometryCentroid(simp);
  const rawPoints = countPoints(raw);
  const simpPoints = countPoints(simp);
  prepared.push({
    slug, pruid, name, rawPoints, simpPoints,
    payload: {
      jurisdictionSlug: slug, geoKind: "boundary",
      centroidLat: c.lat, centroidLng: c.lng,
      minLat: bb.minLat, maxLat: bb.maxLat, minLng: bb.minLng, maxLng: bb.maxLng,
      boundaryGeojson: JSON.parse(canonicalJson(simp)) as Record<string, unknown>,
      geometryHash: hash, simplification: SIMPLIFICATION,
      precision: "published", effectiveFrom: today,
      statcanPruid: pruid,
    },
  });
  console.log(`PREP ${slug} PRUID=${pruid} points ${rawPoints}->${simpPoints} hash=${hash.slice(0, 12)}`);
}

// Snapshot: canonical simplified collection + raw per-feature hashes
// (raw WFS responses are tens of MB; the canonical parse is reproducible
// by re-running this in-repo ingest; raw hashes pin what was received).
const snapshotText = canonicalJson({ type: "FeatureCollection", features: snapshotFeatures });
const contentHash = createHash("sha256").update(snapshotText).digest("hex");
const [latestSnap] = await db.select().from(sourceSnapshots)
  .where(eq(sourceSnapshots.sourceId, source.id)).orderBy(desc(sourceSnapshots.createdAt)).limit(1);
let snap = latestSnap;
if (latestSnap?.contentHash !== contentHash) {
  [snap] = await db.insert(sourceSnapshots).values({
    sourceId: source.id, contentHash, retrievedText: snapshotText,
    fetchedByRunId: fetchRunId,
    datavalues: { geoScope: "ca-provinces", simplification: SIMPLIFICATION, featureCount: snapshotFeatures.length, rawFeatureSha256 },
  }).returning();
}
if (!snap) throw new Error("snapshot missing");

let proposalId: string | null = null;
if (prepared.length) {
  const [prop] = await db.insert(proposals).values({
    jurisdictionId: ca.id, status: "proposed", extractorRunId: decisionRunId,
    datavalues: { m9issue: 50, geoIngest: "ca-provinces", snapshotHash: contentHash },
  }).returning({ id: proposals.id });
  proposalId = prop!.id;
  for (const it of prepared) {
    await db.insert(proposalItems).values({
      proposalId, targetTable: "jurisdiction_geo", payload: it.payload,
      citation: `Statistics Canada provinces/territories boundary product (PRUID ${it.pruid}, ${it.name}) via PAVICS GeoServer WFS ${LAYER}, retrieved ${today}; simplified ${SIMPLIFICATION} (${it.rawPoints}->${it.simpPoints} points)`,
      sourceId: source.id, snapshotId: snap.id, verdict: "pending",
    });
    const [jur] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, it.slug)).limit(1);
    await db.insert(researchLedger).values({
      jurisdictionId: jur!.id, taxTypeId: null, questionKey: "geolocation.boundary",
      determination: `Boundary proposed ${proposalId}: ${it.name} (PRUID ${it.pruid}) geometry ${String(it.payload.geometryHash).slice(0, 8)} from Statistics Canada boundary product snapshot ${contentHash.slice(0, 8)}; points ${it.rawPoints}->${it.simpPoints}.`,
      status: "pending_review", snapshotHash: contentHash,
    });
  }
}

for (const u of unmatched) {
  await db.insert(exceptions).values({
    jurisdictionId: ca.id, sourceId: source.id,
    exceptionType: "structure_unknown", severity: "medium",
    detail: `geo canada: feature "${u.name}" not matched (${u.reason})`,
  });
}

console.log(JSON.stringify({
  proposalId, prepared: prepared.length, reused, unmatched,
  snapshotHash: contentHash, snapshotBytes: snapshotText.length,
  instruction: "Reviewer (distinct run): fixture-point checks over payloads, then tax proposal verify. Human approves last.",
}, null, 2));
await client.end();
