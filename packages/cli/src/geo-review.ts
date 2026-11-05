// Independent Reviewer re-read for proposed jurisdiction_geo proposals (reviewer re-read, #68 pattern).
// Checks per item: geometry valid, geometryHash recomputes, centroid is
// inside the polygon, bbox brackets the centroid, slug matches a real
// city jurisdiction, source is the eligible Census TIGERweb source, and a
// snapshot + citation are pinned. Prints PASS/FAIL per proposal.
import { db, client, jurisdictions, proposalItems, proposals, sources } from "@agent-tax-research/database";
import { geometryHash, isGeometry, pointInGeometry } from "./geo-math.js";
import { eq, sql } from "drizzle-orm";

const props = await db.select({ id: proposals.id }).from(proposals)
  .where(sql`exists (select 1 from proposal_items i where i.proposal_id = ${proposals.id} and i.target_table = 'jurisdiction_geo') and ${proposals.status} = 'proposed'`);
const jurBySlug = new Map((await db.select().from(jurisdictions)).map((j) => [j.slug, j]));
let pass = 0, fail = 0;
for (const p of props) {
  const items = await db.select().from(proposalItems).where(eq(proposalItems.proposalId, p.id));
  for (const it of items) {
    const pay = it.payload as Record<string, unknown>;
    const slug = String(pay.jurisdictionSlug ?? "");
    const reasons: string[] = [];
    const jur = jurBySlug.get(slug);
    if (!jur || jur.level !== "city") reasons.push("slug not a city jurisdiction");
    if (!isGeometry(pay.boundaryGeojson)) reasons.push("boundary not a geometry");
    else {
      if (geometryHash(pay.boundaryGeojson as never) !== String(pay.geometryHash ?? "")) reasons.push("geometryHash mismatch");
      const lat = Number(pay.centroidLat), lng = Number(pay.centroidLng);
      if (pointInGeometry(pay.boundaryGeojson as never, lat, lng) === "outside") reasons.push("centroid outside polygon");
      if (!(lat >= Number(pay.minLat) && lat <= Number(pay.maxLat) && lng >= Number(pay.minLng) && lng <= Number(pay.maxLng))) reasons.push("centroid outside bbox");
    }
    if (!it.snapshotId) reasons.push("no snapshot");
    if (!it.citation) reasons.push("no citation");
    if (it.sourceId) {
      const [src] = await db.select().from(sources).where(eq(sources.id, it.sourceId)).limit(1);
      if (!src || src.eligibility !== "eligible") reasons.push("source not eligible");
      else if (!String(src.url).includes("tigerweb")) reasons.push(`source not tigerweb: ${src.url}`);
    } else reasons.push("no source");
    const ok = reasons.length === 0;
    console.log(`${ok ? "PASS" : "FAIL"} ${slug} proposal=${p.id.slice(0, 8)}${reasons.length ? " :: " + reasons.join("; ") : ""}`);
    if (ok) pass++; else fail++;
  }
}
console.log(JSON.stringify({ proposals: props.length, pass, fail }));
await client.end();
if (fail) process.exit(1);

