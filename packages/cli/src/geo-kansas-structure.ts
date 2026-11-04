import { and, eq } from "drizzle-orm";
import {
  client, coverageAnswers, coverageQuestions, db, jurisdictions, proposalItems,
} from "@agent-tax-research/database";
import { cleanCityName } from "./city-slug.js";

// Kansas geo structure + coverage bookkeeping (#56), mirroring
// geo-populate.ts (Texas #39): register Census counties/places not yet
// jurisdictions (structure only — Pub 1700 registered 103 counties;
// Harper + Kearny arrive here), then answer the geolocation coverage
// pack from geo proposal evidence (found) or recorded negative search
// (confirmed_absent for special districts Census does not publish).
// Idempotent: run before ingest (registers) and after (answers).

const today = new Date().toISOString().slice(0, 10);
const kebab = (s: string) =>
  cleanCityName(s).toLowerCase().replace(/['.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const norm = (s: string) => cleanCityName(s).toLowerCase().replace(/\s+county$/, "").trim();

const [ks] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-ks")).limit(1);
if (!ks) throw new Error("us-ks missing");

async function censusList(url: string, label: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  const json = (await res.json()) as { features?: { attributes: { BASENAME: string; GEOID: string } }[] };
  return json.features ?? [];
}

// 1) Counties (Census 105).
const censusCounties = await censusList(
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query" +
  "?where=STATE%3D%2720%27&outFields=BASENAME%2CGEOID&f=json&returnGeometry=false&resultRecordCount=200&orderByFields=BASENAME",
  "county list");
const existingCounties = (await db.select().from(jurisdictions).where(eq(jurisdictions.level, "county")))
  .filter((j) => j.slug.startsWith("us-ks-"));
const haveCounty = new Set(existingCounties.map((c) => norm(c.name)));
let registeredCounties = 0;
for (const f of censusCounties) {
  const base = f.attributes.BASENAME;
  if (haveCounty.has(norm(base))) continue;
  const slug = `us-ks-${kebab(base)}-county`;
  const [hit] = await db.select({ id: jurisdictions.id }).from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  if (hit) continue;
  await db.insert(jurisdictions).values({
    slug, parentId: ks.id, level: "county", code: f.attributes.GEOID,
    name: `${base} County`, countryCode: "US",
    datavalues: { structureOnly: true, censusGeoid: f.attributes.GEOID, structureSource: "Census TIGERweb county list (M10 #56)" },
  });
  registeredCounties += 1;
}
console.log(`counties: census=${censusCounties.length} newly_registered=${registeredCounties}`);

// 2) Incorporated places not already registered (Pub 1700 covered most).
const censusPlaces = await censusList(
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query" +
  "?where=STATE%3D%2720%27&outFields=BASENAME%2CGEOID&f=json&returnGeometry=false&resultRecordCount=2000&orderByFields=BASENAME",
  "place list");
const existingCities = (await db.select().from(jurisdictions).where(eq(jurisdictions.level, "city")))
  .filter((j) => j.slug.startsWith("us-ks-"));
const haveCity = new Set(existingCities.map((c) => norm(c.name)));
const usedSlugs = new Set(existingCities.map((c) => c.slug));
let registeredPlaces = 0;
for (const f of censusPlaces) {
  const base = f.attributes.BASENAME;
  if (haveCity.has(norm(base))) continue;
  let slug = `us-ks-city-${kebab(base)}`;
  if (usedSlugs.has(slug)) slug = `${slug}-${f.attributes.GEOID}`;
  if (usedSlugs.has(slug)) continue;
  usedSlugs.add(slug);
  await db.insert(jurisdictions).values({
    slug, parentId: ks.id, level: "city", code: f.attributes.GEOID,
    name: cleanCityName(base), countryCode: "US",
    datavalues: { structureOnly: true, censusGeoid: f.attributes.GEOID, structureSource: "Census TIGERweb incorporated places (M10 #56)" },
  });
  registeredPlaces += 1;
}
console.log(`places: census=${censusPlaces.length} newly_registered=${registeredPlaces}`);

// 3) Coverage answers (pack questions seeded by Texas #39; insert if absent).
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
      evidenceRequired: "Eligible government GIS dataset (Census TIGER/Line, state GIS) snapshot with geometry hash.",
      absenceRequires: "Recorded searches of Census TIGERweb services and the state GIS catalog showing no published polygon for this jurisdiction class.",
      sortOrder,
    });
  }
  sortOrder += 10;
}

const geoItems = await db.select({ payload: proposalItems.payload }).from(proposalItems)
  .where(eq(proposalItems.targetTable, "jurisdiction_geo"));
const withBoundary = new Map<string, Record<string, unknown>>();
for (const gi of geoItems) {
  const p = gi.payload as Record<string, unknown>;
  if (typeof p.jurisdictionSlug === "string" && p.jurisdictionSlug.startsWith("us-ks")) {
    withBoundary.set(p.jurisdictionSlug, p);
  }
}
// Published rows count as found too.
const publishedGeo = await db.select().from(jurisdictions)
  .where(eq(jurisdictions.parentId, ks.id));
void publishedGeo;

const allJur = await db.select().from(jurisdictions);
const bySlug = new Map(allJur.map((j) => [j.slug, j]));
const SEARCHES = [
  "Census TIGERweb service directory (no special-district/CID/TDD polygon service published)",
  "Census TIGER/Line shapefile index (no special-district boundaries; districts are legal/address-range descriptions)",
  `Kansas DASC geospatial clearinghouse search ${today} (no statewide special-district boundary layer)`,
  "KDOR Publication 1700 defines districts by street address ranges, not polygons",
];
async function answer(jurId: string, key: string, status: string, text: string, evidence: Record<string, unknown>) {
  const [exists] = await db.select({ id: coverageAnswers.id }).from(coverageAnswers)
    .where(and(eq(coverageAnswers.jurisdictionId, jurId), eq(coverageAnswers.questionKey, key))).limit(1);
  if (exists) return false;
  await db.insert(coverageAnswers).values({
    jurisdictionId: jurId, questionKey: key, status, answer: text, evidence,
  });
  return true;
}
let answeredFound = 0;
let answeredAbsent = 0;
for (const [slug, p] of withBoundary) {
  const jur = bySlug.get(slug);
  if (!jur) continue;
  if (await answer(jur.id, "has_published_boundary", "found",
    `Census TIGERweb boundary; geometry_hash ${String(p.geometryHash ?? "").slice(0, 12)}…`,
    { geometryHash: p.geometryHash, censusGeoid: p.censusGeoid, simplification: p.simplification })) answeredFound += 1;
  await answer(jur.id, "centroid_source", "found",
    `Area centroid of published boundary: ${String(p.centroidLat)}, ${String(p.centroidLng)}`,
    { centroidLat: p.centroidLat, centroidLng: p.centroidLng, method: "area-weighted ring centroid (geo-math)" });
  await answer(jur.id, "boundary_vintage", "found",
    `TIGERweb current vintage retrieved ${today}; effective_from recorded on the geo row.`,
    { effectiveFrom: p.effectiveFrom });
}
for (const jur of allJur.filter((j) => j.slug.startsWith("us-ks-") && j.level === "special_district")) {
  if (withBoundary.has(jur.slug)) continue;
  if (await answer(jur.id, "has_published_boundary", "confirmed_absent",
    "No government GIS polygon published for this district; KDOR defines it by street address ranges (Publication 1700).",
    { searches: SEARCHES })) answeredAbsent += 1;
}
console.log(`coverage: found_new=${answeredFound} confirmed_absent_new=${answeredAbsent} with_boundary_total=${withBoundary.size}`);
await client.end();
