import { eq } from "drizzle-orm";
import { client, db, proposalItems } from "@agent-tax-research/database";
import { isGeometry, pointInGeometry, type Geometry } from "./geo-math.js";

// Reviewer fixture-point checks for Canada geo proposal 4f8a79d4 (#50).
// Each capital/major-city point must resolve to exactly its province over
// the PROPOSAL payloads (pre-publish); offshore/US points to none.
const PROPOSAL = "4f8a79d4-979c-435b-a8c3-e603c6918a98";
const FIXTURES: [string, number, number, string | null][] = [
  ["Toronto", 43.6532, -79.3832, "ca-on"],
  ["Ottawa", 45.4215, -75.6919, "ca-on"],
  ["Montreal", 45.5017, -73.5673, "ca-qc"],
  ["Vancouver", 49.2827, -123.1207, "ca-bc"],
  ["Calgary", 51.0447, -114.0719, "ca-ab"],
  ["Winnipeg", 49.8951, -97.1384, "ca-mb"],
  ["Regina", 50.4452, -104.6189, "ca-sk"],
  ["Halifax", 44.6488, -63.5752, "ca-ns"],
  ["Fredericton", 45.9636, -66.6431, "ca-nb"],
  ["Charlottetown", 46.2382, -63.1311, "ca-pe"],
  ["St John's", 47.5615, -52.7126, "ca-nl"],
  ["Whitehorse", 60.7212, -135.0568, "ca-yt"],
  ["Yellowknife", 62.454, -114.3718, "ca-nt"],
  ["Iqaluit", 63.7467, -68.517, "ca-nu"],
  ["Mid-Atlantic", 45, -30, null],
  ["Austin TX", 30.2672, -97.7431, null],
];

const items = await db.select().from(proposalItems).where(eq(proposalItems.proposalId, PROPOSAL));
console.log(`items=${items.length}`);
let pass = 0;
let fail = 0;
for (const [name, lat, lng, expected] of FIXTURES) {
  const hits: string[] = [];
  for (const it of items) {
    const p = it.payload as Record<string, unknown>;
    const g = p.boundaryGeojson;
    if (!isGeometry(g)) continue;
    const r = pointInGeometry(g as Geometry, lat, lng);
    if (r === "inside" || r === "boundary") hits.push(String(p.jurisdictionSlug));
  }
  const ok = expected === null ? hits.length === 0 : hits.length === 1 && hits[0] === expected;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} -> ${hits.join(",") || "none"} (expected ${expected ?? "none"})`);
  if (ok) pass += 1; else fail += 1;
}
console.log(JSON.stringify({ pass, fail }));
await client.end();
if (fail > 0) process.exit(1);
