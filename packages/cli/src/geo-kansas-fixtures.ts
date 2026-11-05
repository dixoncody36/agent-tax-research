import { eq } from "drizzle-orm";
import {
  client, db, jurisdictions, proposalItems,
} from "@agent-tax-research/database";
import { isGeometry } from "./geo-math.js";
import { resolveFromCandidates, type GeoCandidate } from "./geo-resolve.js";

// Reviewer fixture-point checks for Kansas geo proposals (#56), run over
// proposal payload geometries pre-publish (geo-populate pattern).
const geoItems = await db.select({ payload: proposalItems.payload }).from(proposalItems)
  .where(eq(proposalItems.targetTable, "jurisdiction_geo"));
const allJur = await db.select().from(jurisdictions);
const bySlug = new Map(allJur.map((j) => [j.slug, j]));
const candidates: GeoCandidate[] = [];
for (const gi of geoItems) {
  const p = gi.payload as Record<string, unknown>;
  const slug = String(p.jurisdictionSlug ?? "");
  if (!slug.startsWith("us-ks")) continue;
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
const wichita = slugsAt(37.6889, -97.3361);
checks.push(["downtown Wichita in us-ks", wichita.includes("us-ks")]);
checks.push(["downtown Wichita in Sedgwick County", wichita.includes("us-ks-sedgwick-county")]);
checks.push(["downtown Wichita in Wichita", wichita.includes("us-ks-city-wichita")]);
const topeka = slugsAt(39.0473, -95.6752);
checks.push(["Topeka in Shawnee County", topeka.includes("us-ks-shawnee-county")]);
checks.push(["Topeka in Topeka", topeka.includes("us-ks-city-topeka")]);
const anthony = slugsAt(37.1535, -98.0298);
checks.push(["Anthony in Harper County (Census-registered in #56)", anthony.includes("us-ks-harper-county")]);
const outside = slugsAt(30.2672, -97.7431);
checks.push(["Austin TX point resolves empty in KS set", outside.length === 0]);
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failed += 1;
}
console.log(`candidates=${candidates.length} wichita=${JSON.stringify(wichita)} fixture_failures=${failed}`);
await client.end();
if (failed) process.exit(1);
