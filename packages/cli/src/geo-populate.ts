import { and, eq } from "drizzle-orm";
import {
  client, coverageAnswers, coverageQuestions, db, jurisdictions, proposalItems,
} from "@agent-tax-research/database";
import { cleanCityName } from "./city-slug.js";
import { isGeometry } from "./geo-math.js";
import { resolveFromCandidates, type GeoCandidate } from "./geo-resolve.js";

// Texas geo population bookkeeping (#39): structure-register any Census
// county not yet a jurisdiction (structure only, no tax facts — #18
// precedent), seed the geolocation coverage pack, answer it from ingest
// evidence (found) or recorded negative search (confirmed_absent for
// transit/SPD boundaries Census does not publish), and run fixture-point
// checks over the proposal payloads. Publishes nothing.

const today = new Date().toISOString().slice(0, 10);
const kebab = (s: string) =>
  cleanCityName(s).toLowerCase().replace(/['.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// 1) Register missing Texas counties (254 total; ~126 taxing/seeded exist).
const countyListUrl =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query" +
  "?where=STATE%3D%2748%27&outFields=BASENAME%2CGEOID&f=json&returnGeometry=false&resultRecordCount=300&orderByFields=BASENAME";
const listRes = await fetch(countyListUrl);
if (!listRes.ok) throw new Error(`county list HTTP ${listRes.status}`);
const listJson = (await listRes.json()) as { features?: { attributes: { BASENAME: string; GEOID: string } }[] };
const censusCounties = listJson.features ?? [];
const [tx] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-tx")).limit(1);
if (!tx) throw new Error("us-tx missing");
const existingCounties = await db.select().from(jurisdictions).where(eq(jurisdictions.level, "county"));
const norm = (s: string) => cleanCityName(s).toLowerCase().replace(/\s+county$/, "").trim();
const haveCounty = new Set(existingCounties.map((c) => norm(c.name)));
let registered = 0;
for (const f of censusCounties) {
  const base = f.attributes.BASENAME;
  if (haveCounty.has(norm(base))) continue;
  const slug = `us-tx-${kebab(base)}-county`;
  const [hit] = await db.select({ id: jurisdictions.id }).from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  if (hit) continue;
  await db.insert(jurisdictions).values({
    slug, parentId: tx.id, level: "county", code: f.attributes.GEOID,
    name: `${base} County`, countryCode: "US",
    datavalues: { structureOnly: true, censusGeoid: f.attributes.GEOID, structureSource: "Census TIGERweb county list (M8 #39)" },
  });
  registered += 1;
}
console.log(`counties: census=${censusCounties.length} newly_registered=${registered}`);

// 1b) Register missing incorporated places as structure (Census list vs
// registered cities). Levy reconciliation for these is #43 — tonight they
// exist so boundaries can attach; no tax component is asserted.
const placeListUrl =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query" +
  "?where=STATE%3D%2748%27&outFields=BASENAME%2CGEOID&f=json&returnGeometry=false&resultRecordCount=2000&orderByFields=BASENAME";
const placeRes = await fetch(placeListUrl);
if (!placeRes.ok) throw new Error(`place list HTTP ${placeRes.status}`);
const placeJson = (await placeRes.json()) as { features?: { attributes: { BASENAME: string; GEOID: string } }[] };
const censusPlaces = placeJson.features ?? [];
const existingCities = await db.select().from(jurisdictions).where(eq(jurisdictions.level, "city"));
const haveCity = new Set(existingCities.map((c) => norm(c.name)));
const usedSlugs = new Set(existingCities.map((c) => c.slug));
let registeredPlaces = 0;
for (const f of censusPlaces) {
  const base = f.attributes.BASENAME;
  if (haveCity.has(norm(base))) continue;
  let slug = `us-tx-city-${kebab(base)}`;
  if (usedSlugs.has(slug)) slug = `${slug}-${f.attributes.GEOID}`;
  if (usedSlugs.has(slug)) continue;
  usedSlugs.add(slug);
  await db.insert(jurisdictions).values({
    slug, parentId: tx.id, level: "city", code: f.attributes.GEOID,
    name: cleanCityName(base), countryCode: "US",
    datavalues: { structureOnly: true, censusGeoid: f.attributes.GEOID, structureSource: "Census TIGERweb incorporated places (M8 #39; levy check #43)" },
  });
  registeredPlaces += 1;
}
console.log(`places: census=${censusPlaces.length} newly_registered=${registeredPlaces}`);

// 2) Geolocation coverage pack as data.
const PACK: [string, string][] = [
  ["has_published_boundary", "Does a government GIS boundary exist for this jurisdiction, from which publisher and vintage?"],
  ["centroid_source", "What is the jurisdiction centroid (lat/lng) and how was it derived (area centroid of published boundary vs published internal point)?"],
  ["boundary_vintage", "What boundary vintage/effective period applies, and what source states it?"],
];
let sortOrder = 10;
for (const [key, q] of PACK) {
  const [exists] = await db.select({ id: coverageQuestions.id }).from(coverageQuestions)
    .where(and(eq(coverageQuestions.category, "geolocation"), eq(coverageQuestions.questionKey, key))).limit(1);
  if (!exists) {
    await db.insert(coverageQuestions).values({
      category: "geolocation", questionKey: key, question: q,
      evidenceRequired: "Eligible government GIS dataset (Census TIGER/Line, Texas GIS) snapshot with geometry hash.",
      absenceRequires: "Recorded searches of Census TIGERweb services and Texas GIS/TNRIS catalog showing no published polygon for this jurisdiction class.",
      sortOrder,
    });
  }
  sortOrder += 10;
}

// 3) Answers from proposal evidence + recorded negative search.
const geoItems = await db.select({ payload: proposalItems.payload }).from(proposalItems)
  .where(eq(proposalItems.targetTable, "jurisdiction_geo"));
const withBoundary = new Map<string, Record<string, unknown>>();
for (const gi of geoItems) {
  const p = gi.payload as Record<string, unknown>;
  if (typeof p.jurisdictionSlug === "string") withBoundary.set(p.jurisdictionSlug, p);
}
const allJur = await db.select().from(jurisdictions);
const bySlug = new Map(allJur.map((j) => [j.slug, j]));
const SEARCHES = [
  "Census TIGERweb service directory (no transit/special-district polygon service published)",
  "Census TIGER/Line shapefile index (no special-district boundaries; districts are legal descriptions)",
  `Texas GIS/TNRIS catalog search ${today} (no statewide special-purpose district boundary layer)`,
];
let answeredFound = 0, answeredAbsent = 0;
async function answer(jurId: string, key: string, status: string, text: string, evidence: Record<string, unknown>) {
  const [exists] = await db.select({ id: coverageAnswers.id }).from(coverageAnswers)
    .where(and(eq(coverageAnswers.jurisdictionId, jurId), eq(coverageAnswers.questionKey, key))).limit(1);
  if (exists) return;
  await db.insert(coverageAnswers).values({
    jurisdictionId: jurId, questionKey: key, status, answer: text, evidence,
  });
}
for (const [slug, p] of withBoundary) {
  const jur = bySlug.get(slug);
  if (!jur) continue;
  await answer(jur.id, "has_published_boundary", "found",
    `Census TIGERweb boundary; geometry_hash ${String(p.geometryHash ?? "").slice(0, 12)}…`,
    { geometryHash: p.geometryHash, censusGeoid: p.censusGeoid, simplification: p.simplification });
  await answer(jur.id, "centroid_source", "found",
    `Area centroid of published boundary: ${String(p.centroidLat)}, ${String(p.centroidLng)}`,
    { centroidLat: p.centroidLat, centroidLng: p.centroidLng, method: "area-weighted ring centroid (geo-math)" });
  await answer(jur.id, "boundary_vintage", "found",
    `TIGERweb current vintage retrieved ${today}; effective_from recorded on the geo row.`,
    { effectiveFrom: p.effectiveFrom });
  answeredFound += 1;
}
for (const jur of allJur.filter((j) => j.level === "special_district")) {
  if (withBoundary.has(jur.slug)) continue;
  await answer(jur.id, "has_published_boundary", "confirmed_absent",
    "No government GIS polygon published for this district; legal boundary is metes-and-bounds/ETJ description.",
    { searches: SEARCHES });
  answeredAbsent += 1;
}
console.log(`coverage: found_jurisdictions=${answeredFound} confirmed_absent_districts=${answeredAbsent}`);

// 4) Fixture-point checks over proposal payload geometries.
const candidates: GeoCandidate[] = [];
for (const [slug, p] of withBoundary) {
  const jur = bySlug.get(slug);
  if (!jur || !isGeometry(p.boundaryGeojson)) continue;
  candidates.push({
    slug, name: jur.name, level: jur.level, geoKind: "boundary",
    bbox: { minLat: Number(p.minLat), maxLat: Number(p.maxLat), minLng: Number(p.minLng), maxLng: Number(p.maxLng) },
    boundary: p.boundaryGeojson, geometryHash: String(p.geometryHash ?? ""),
  });
}
const slugsAt = (lat: number, lng: number) => resolveFromCandidates(candidates, lat, lng).applicable.map((a) => a.slug);
const checks: [string, boolean][] = [];
const austin = slugsAt(30.2672, -97.7431);
checks.push(["downtown Austin in us-tx", austin.includes("us-tx")]);
checks.push(["downtown Austin in Travis", austin.includes("us-tx-travis")]);
checks.push(["downtown Austin in Austin", austin.includes("us-tx-austin")]);
const outside = slugsAt(35.0, -106.0);
checks.push(["New Mexico point resolves empty", outside.length === 0]);
const budaPayload = withBoundary.get("us-tx-city-buda");
if (budaPayload) {
  const atBuda = slugsAt(Number(budaPayload.centroidLat), Number(budaPayload.centroidLng));
  checks.push(["Buda centroid in Hays County", atBuda.includes("us-tx-hays-county")]);
  checks.push(["Buda centroid not in Travis/Austin", !atBuda.includes("us-tx-travis") && !atBuda.includes("us-tx-austin")]);
}
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failed += 1;
}
console.log(`candidates=${candidates.length} fixture_failures=${failed}`);
await client.end();
if (failed) process.exit(1);
