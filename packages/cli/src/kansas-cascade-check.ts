import { eq } from "drizzle-orm";
import {
  client, db, jurisdictions, proposalItems, sourceSnapshots, sources,
} from "@agent-tax-research/database";
import type { Pub1700Row } from "./pub1700.js";

// Reviewer re-performance for the Kansas cascade (#55), independent of the
// extraction code path where it matters:
//  1. Every snapshot row with full components: H+I+J+K == stored total.
//  2. Wichita fixture: state 6.5 + Sedgwick county + Wichita city (0, no
//     item) == KDOR combined for the Wichita row.
//  3. City items: state + city <= combined shown (residual county/special
//     must never be negative — the audit-pack invariant, checked early).
//  4. County accounting vs Census STATE=20 list (105): name any counties
//     with no Pub 1700 county row.
const FILE_URL = "https://www.ksrevenue.gov/pdf/pub17001026.xlsx";
const [src] = await db.select().from(sources).where(eq(sources.url, FILE_URL)).limit(1);
const snaps = await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.sourceId, src!.id));
const snap = snaps.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
const rows = JSON.parse(snap.retrievedText ?? "[]") as Pub1700Row[];

let checked = 0;
let bad = 0;
for (const r of rows) {
  if ([r.countyMicro, r.cityMicro, r.specialMicro, r.stateMicro].every((x) => x !== null)) {
    checked += 1;
    if (r.countyMicro! + r.cityMicro! + r.specialMicro! + r.stateMicro! !== r.totalNonFoodMicro) bad += 1;
  }
}
console.log(`row totals: checked=${checked} bad=${bad}`);

const wichita = rows.find((r) => r.code === "WICSG")!;
console.log(`wichita row: county=${wichita.countyMicro} city=${wichita.cityMicro} special=${wichita.specialMicro} state=${wichita.stateMicro} total=${wichita.totalNonFoodMicro}`);
const wichitaOk = wichita.totalNonFoodMicro === 7_500_000 && wichita.countyMicro === 1_000_000 && wichita.cityMicro === 0;
console.log(`wichita fixture (6.5+1.0+0=7.5): ${wichitaOk ? "PASS" : "FAIL"}`);

const cityItems = await db.select().from(proposalItems)
  .where(eq(proposalItems.proposalId, "290a866c-b827-4428-b494-0008ef7614b2"));
let negResidual = 0;
for (const it of cityItems) {
  const p = it.payload as Record<string, unknown>;
  const m = /combined total shown ([\d.]+)%/.exec(String(p.appliesTo));
  if (!m) { negResidual += 1; continue; }
  const residual = Math.round(Number(m[1]) * 1e6) - (6_500_000 + Math.round(Number(p.rateValue) * 1e6));
  if (residual < 0) negResidual += 1;
}
console.log(`city items=${cityItems.length} negative-residual=${negResidual}`);

const censusRes = await fetch("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query?where=STATE%3D%2720%27&outFields=BASENAME&f=json&returnGeometry=false&resultRecordCount=200&orderByFields=BASENAME");
const censusJson = (await censusRes.json()) as { features?: { attributes: { BASENAME: string } }[] };
const censusNames = new Set((censusJson.features ?? []).map((f) => f.attributes.BASENAME.toLowerCase()));
const ksCounties = await db.select().from(jurisdictions).where(eq(jurisdictions.level, "county"));
const ksCountyNames = new Set(
  ksCounties.filter((j) => j.slug.startsWith("us-ks-")).map((j) => j.name.replace(/\s+County$/, "").toLowerCase()),
);
const missing = [...censusNames].filter((n) => !ksCountyNames.has(n));
console.log(`census counties=${censusNames.size} registered-from-pub1700=${ksCountyNames.size} missing=${JSON.stringify(missing)}`);

const ok = bad === 0 && wichitaOk && negResidual === 0;
console.log(JSON.stringify({ ok, checked, bad, negResidual, missing }));
await client.end();
if (!ok) process.exit(1);
