import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  db, exceptions, jurisdictionGeo, jurisdictions, proposalItems, proposals,
  sources, sourceSnapshots,
} from "@agent-tax-research/database";
import { cleanCityName } from "./city-slug.js";
import {
  bboxOf, canonicalJson, geometryHash, interiorPoint, isGeometry, type Geometry,
} from "./geo-math.js";

// Government GIS boundary ingest (#37, M8 units 1-3). Authority: US Census
// Bureau TIGERweb REST (public government GIS, no login). Fetch retrieves
// and snapshots; this module normalizes to WGS84 GeoJSON proposal payloads
// and matches features to registered jurisdictions — it publishes nothing
// (Decision/Reviewer/human gate downstream, #39).
// ponytail: --fips profile (48 Texas default, 20 Kansas #56) + name matching.

type Level = "state" | "county" | "place";
type Feature = {
  properties: Record<string, unknown> | null;
  geometry: unknown;
};

const SIMPLIFICATION = "tigerweb maxAllowableOffset=0.001deg, geometryPrecision=6";

// State profiles (#56: Kansas is the second state — the generalization the
// v1 header promised). Default 48 keeps Texas behavior byte-identical.
const STATE_PROFILES: Record<string, { root: string; label: string }> = {
  "48": { root: "us-tx", label: "Texas" },
  "20": { root: "us-ks", label: "Kansas" },
};
const LAYERS: Record<Level, { service: string; layer: number; label: string }> = {
  state: { service: "State_County", layer: 0, label: "States" },
  county: { service: "State_County", layer: 1, label: "Counties" },
  place: { service: "Places_CouSub_ConCity_SubMCD", layer: 4, label: "Incorporated Places" },
};

function layerUrl(level: Level): string {
  const l = LAYERS[level];
  return `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/${l.service}/MapServer/${l.layer}`;
}

export async function fetchFeatures(level: Level, where: string): Promise<{ features: Feature[]; text: string }> {
  const features: Feature[] = [];
  const pages: string[] = [];
  for (let offset = 0; ; offset += 500) {
    const qs = new URLSearchParams({
      where,
      outFields: level === "state"
        ? "STATE,BASENAME,NAME,GEOID,CENTLAT,CENTLON"
        : level === "county"
          ? "STATE,COUNTY,BASENAME,NAME,GEOID,CENTLAT,CENTLON"
          : "STATE,PLACE,BASENAME,NAME,GEOID,CENTLAT,CENTLON",
      f: "geojson",
      outSR: "4326",
      maxAllowableOffset: "0.001",
      geometryPrecision: "6",
      resultRecordCount: "500",
      resultOffset: String(offset),
      orderByFields: "BASENAME",
    });
    const res = await fetch(`${layerUrl(level)}/query?${qs}`);
    if (!res.ok) throw new Error(`tigerweb ${level} HTTP ${res.status}`);
    const text = await res.text();
    pages.push(text);
    const parsed = JSON.parse(text) as { features?: Feature[]; error?: { message?: string } };
    if (parsed.error) throw new Error(`tigerweb ${level} query error: ${parsed.error.message ?? text.slice(0, 200)}`);
    const batch = parsed.features ?? [];
    features.push(...batch);
    if (batch.length < 500) break;
  }
  return { features, text: pages.join("\n") };
}

async function ensureSource(level: Level, rootId: string, fips: string, stateLabel: string) {
  const url = `${layerUrl(level)}/query?where=STATE%3D%27${fips}%27`;
  const [existing] = await db.select().from(sources).where(eq(sources.url, url)).limit(1);
  if (existing) return existing;
  const [row] = await db.insert(sources).values({
    jurisdictionId: rootId,
    name: `Census TIGERweb ${LAYERS[level].label} (${stateLabel})`,
    url,
    sourceType: "dataset",
    publisher: "US Census Bureau",
    isAuthoritative: true,
    monitorCadence: "quarterly",
    checkMethod: "content_hash",
    publisherType: "government",
    eligibility: "eligible",
    notes: "Boundary authority for jurisdiction_geo (M8). Comptroller locator remains cross-check only.",
  }).returning();
  return row!;
}

const normName = (s: string) =>
  cleanCityName(s).toLowerCase().replace(/\s+county$/, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

export async function runGeoIngest(args: string[]): Promise<Record<string, unknown>> {
  const argVal = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const jurSlug = argVal("--jurisdiction");
  const levelArg = argVal("--level") as Level | undefined;
  const today = new Date().toISOString().slice(0, 10);

  const fips = argVal("--fips") ?? "48";
  const profile = STATE_PROFILES[fips];
  if (!profile) return { error: "unknown_fips", instruction: `supported: ${Object.keys(STATE_PROFILES).join(", ")}` };
  const [tx] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, profile.root)).limit(1);
  if (!tx) throw new Error(`${profile.root} jurisdiction missing`);

  // Resolve the work list: single jurisdiction or a Texas-wide level bulk.
  let level: Level;
  let where = `STATE='${fips}'`;
  let onlySlug: string | undefined;
  if (jurSlug) {
    const [jur] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, jurSlug)).limit(1);
    if (!jur) return { error: "unknown_jurisdiction", jurisdiction: jurSlug };
    if (!jurSlug.startsWith(profile.root)) return { error: "outside_fence", instruction: `Geo ingest --fips ${fips} covers ${profile.root} only.` };
    onlySlug = jurSlug;
    level = jur.level === "state" ? "state" : jur.level === "county" ? "county" : jur.level === "city" ? "place" : "state";
    if (level === "county") where = `STATE='${fips}' AND BASENAME='${cleanCityName(jur.name).replace(/\s+County$/, "").replace(/'/g, "''")}'`;
    if (level === "place") where = `STATE='${fips}' AND BASENAME='${cleanCityName(jur.name).replace(/'/g, "''")}'`;
  } else if (levelArg && ["state", "county", "place"].includes(levelArg)) {
    level = levelArg;
  } else {
    return { error: "usage: tax geo ingest --jurisdiction <slug> | --level state|county|place [--fips 48|20]" };
  }

  const source = await ensureSource(level, tx.id, fips, profile.label);
  const { features, text } = await fetchFeatures(level, where);
  const contentHash = createHash("sha256").update(text).digest("hex");

  // Snapshot (append-only). Same hash as latest -> evidence reused.
  const [latestSnap] = await db.select().from(sourceSnapshots)
    .where(eq(sourceSnapshots.sourceId, source.id)).orderBy(desc(sourceSnapshots.createdAt)).limit(1);
  let snap = latestSnap;
  let snapshotReused = false;
  if (latestSnap?.contentHash === contentHash) snapshotReused = true;
  else {
    [snap] = await db.insert(sourceSnapshots).values({
      sourceId: source.id, contentHash, retrievedText: text,
      datavalues: { geoLevel: level, where, simplification: SIMPLIFICATION, featureCount: features.length },
    }).returning();
  }
  if (!snap) throw new Error("snapshot missing");

  // Match maps from registered jurisdictions.
  const allJur = (await db.select().from(jurisdictions)).filter((j) => j.slug === profile.root || j.slug.startsWith(`${profile.root}-`));
  const bySlug = new Map(allJur.map((j) => [j.slug, j]));
  const countyByName = new Map<string, typeof allJur[number][]>();
  const cityByName = new Map<string, typeof allJur[number][]>();
  for (const j of allJur) {
    if (j.level === "county") {
      const k = normName(j.name);
      countyByName.set(k, [...(countyByName.get(k) ?? []), j]);
    }
    if (j.level === "city") {
      const k = normName(j.name);
      cityByName.set(k, [...(cityByName.get(k) ?? []), j]);
    }
  }

  // Existing hashes (published or already proposed) make re-runs no-ops.
  const published = await db.select({ h: jurisdictionGeo.geometryHash }).from(jurisdictionGeo);
  const knownHashes = new Set(published.map((r) => r.h).filter(Boolean));
  const pendingItems = await db.select({ payload: proposalItems.payload }).from(proposalItems)
    .where(eq(proposalItems.targetTable, "jurisdiction_geo"));
  for (const pi of pendingItems) {
    const h = (pi.payload as Record<string, unknown>).geometryHash;
    if (typeof h === "string") knownHashes.add(h);
  }

  type Item = { slug: string; payload: Record<string, unknown> };
  const items: Item[] = [];
  const unmatched: { name: string; reason: string }[] = [];
  let reused = 0;

  for (const f of features) {
    const props = f.properties ?? {};
    const baseName = String(props.BASENAME ?? props.NAME ?? "");
    if (!isGeometry(f.geometry)) { unmatched.push({ name: baseName, reason: "no_polygon_geometry" }); continue; }
    const geom = f.geometry as Geometry;

    let jur: typeof allJur[number] | undefined;
    if (level === "state") jur = bySlug.get(profile.root);
    else {
      const pool = level === "county" ? countyByName.get(normName(baseName)) : cityByName.get(normName(baseName));
      if (!pool?.length) { unmatched.push({ name: baseName, reason: "no_registered_jurisdiction" }); continue; }
      if (pool.length > 1 && !onlySlug) { unmatched.push({ name: baseName, reason: "ambiguous_name_match" }); continue; }
      jur = onlySlug ? pool.find((j) => j.slug === onlySlug) ?? pool[0] : pool[0];
    }
    if (!jur) { unmatched.push({ name: baseName, reason: "unmatched" }); continue; }
    if (onlySlug && jur.slug !== onlySlug) continue;

    const hash = geometryHash(geom);
    if (knownHashes.has(hash)) { reused += 1; continue; }
    knownHashes.add(hash);
    const bb = bboxOf(geom);
    const c = interiorPoint(geom); // #68: pin must sit inside the polygon
    items.push({
      slug: jur.slug,
      payload: {
        jurisdictionSlug: jur.slug,
        geoKind: "boundary",
        centroidLat: c.lat, centroidLng: c.lng,
        minLat: bb.minLat, maxLat: bb.maxLat, minLng: bb.minLng, maxLng: bb.maxLng,
        boundaryGeojson: JSON.parse(canonicalJson(geom)) as Record<string, unknown>,
        geometryHash: hash,
        simplification: SIMPLIFICATION,
        precision: "published",
        effectiveFrom: today,
        censusGeoid: String(props.GEOID ?? ""),
      },
    });
  }

  let proposalId: string | null = null;
  if (items.length) {
    const [prop] = await db.insert(proposals).values({
      jurisdictionId: tx.id, status: "proposed",
      datavalues: { geoIngest: level, where, snapshotHash: contentHash, fips },
    }).returning({ id: proposals.id });
    proposalId = prop!.id;
    for (const it of items) {
      await db.insert(proposalItems).values({
        proposalId, targetTable: "jurisdiction_geo", payload: it.payload,
        citation: `US Census Bureau TIGERweb ${LAYERS[level].label}, STATE=${fips} (retrieved ${today}); GEOID ${String(it.payload.censusGeoid ?? "")}`,
        sourceId: source.id, snapshotId: snap.id, verdict: "pending",
      });
    }
  }

  for (const u of unmatched.slice(0, 50)) {
    await db.insert(exceptions).values({
      jurisdictionId: tx.id, sourceId: source.id,
      exceptionType: "structure_unknown", severity: "medium",
      detail: `geo ingest ${level}: feature "${u.name}" not matched (${u.reason})`,
    });
  }

  return {
    level, where, features: features.length, proposed: items.length, reused,
    unmatched: unmatched.length, unmatchedSample: unmatched.slice(0, 10),
    proposalId, snapshotHash: contentHash, snapshotReused,
    instruction: items.length
      ? "Decision/Reviewer gate next (#39): verify with a distinct reviewer run; human approves last."
      : "Nothing new to propose (idempotent re-run).",
  };
}
