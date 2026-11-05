import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  client, db, jurisdictions, proposalItems, proposals, sources, sourceSnapshots, taxTypes,
} from "@agent-tax-research/database";
import { assignSlugs, parseCityRows } from "./city-slug.js";

// Bulk city registration from the Comptroller city rate-table snapshot
// (issue #17; slug hygiene fixed in #35 — see city-slug.ts). Incorporated
// places carry a 7-digit local code + city rate; unincorporated rows (no
// code) are skipped, and coded non-city rows (library/assistance districts,
// county levies) are rejected with reasons — districts belong to the SPD
// bulk. Austin maps to the seeded us-tx-austin jurisdiction. Parent is
// Texas (ponytail: exact county parenting for split cities is superseded
// by M8 point resolution).
const rawBuf = readFileSync(process.argv[2]!);
const text = rawBuf.includes(0) ? rawBuf.toString("utf16le") : rawBuf.toString("utf8");
const { rows, rejected } = parseCityRows(text);
const slugByCode = assignSlugs(rows);
console.log(`parsed unique coded cities: ${rows.length}; rejected: ${rejected.length}`);
for (const r of rejected) console.log(`  rejected ${r.code} "${r.name}" (${r.reason})`);
const [tx] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-tx")).limit(1);
const [salesType] = await db.select().from(taxTypes).where(eq(taxTypes.slug, "us-tx-sales-use")).limit(1);
const [src] = await db.select().from(sources).where(eq(sources.url, "https://comptroller.texas.gov/taxes/sales/city.php")).limit(1);
const [snap] = await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.sourceId, src!.id)).limit(1);
if (!tx || !salesType || !src || !snap) throw new Error("missing tx/type/source/snapshot");
let registered = 0;
for (const r of rows) {
  const slug = slugByCode.get(r.code)!;
  const [existing] = await db.select({ id: jurisdictions.id }).from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  if (!existing) {
    await db.insert(jurisdictions).values({
      slug, parentId: tx.id, level: "city", code: r.code, name: r.name, countryCode: "US",
      datavalues: { comptrollerLocalCode: r.code, combinedTotalShown: r.total },
    });
    registered += 1;
  }
}
const [prop] = await db.insert(proposals).values({ jurisdictionId: tx.id, taxTypeId: salesType.id, status: "proposed" }).returning({ id: proposals.id });
let items = 0;
for (const r of rows) {
  await db.insert(proposalItems).values({
    proposalId: prop!.id, targetTable: "tax_rates",
    payload: { rateValue: r.rate, rateUnit: "percent", jurisdictionSlug: slugByCode.get(r.code)!, appliesTo: `City sales/use tax component (${r.name}, Comptroller local code ${r.code}); table combined total shown ${r.total}%` },
    citation: "Texas Comptroller City Sales and Use Tax Rates table snapshot",
    sourceId: src.id, snapshotId: snap.id, verdict: "pending",
  });
  items += 1;
}
console.log(`registered=${registered} proposal=${prop!.id} items=${items}`);
await client.end();
