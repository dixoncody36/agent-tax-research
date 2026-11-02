import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  client, db, jurisdictions, proposalItems, proposals, sources, sourceSnapshots, taxTypes,
} from "@agent-tax-research/database";

// Bulk city registration from the Comptroller city rate-table snapshot
// (issue #17). Incorporated places carry a 7-digit local code + city rate;
// unincorporated rows (no code) are skipped. Austin maps to the seeded
// us-tx-austin jurisdiction. County parentage is recorded as a hint in
// datavalues where the row names it; parent is Texas (ponytail: exact
// county parenting for split cities is a later refinement).
const rawBuf = readFileSync(process.argv[2]!);
const text = rawBuf.includes(0) ? rawBuf.toString("utf16le") : rawBuf.toString("utf8");
const re = /([A-Z][A-Za-z'.()\- ]+?)\s+(\d{7})\s+\.(\d{6})\s+\.(\d{6})/g;
type Row = { name: string; code: string; rate: number; total: number };
const byCode = new Map<string, Row>();
for (const m of text.matchAll(re)) {
  const name = m[1]!.trim().replace(/\s+/g, " ");
  if (name.length < 2 || /Local Code|Name$/.test(name)) continue;
  const code = m[2]!;
  if (!byCode.has(code)) byCode.set(code, { name, code, rate: Number(`0.${m[3]}`) * 100, total: Number(`0.${m[4]}`) * 100 });
}
const rows = [...byCode.values()];
console.log(`parsed unique coded cities: ${rows.length}`);
const [tx] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-tx")).limit(1);
const [salesType] = await db.select().from(taxTypes).where(eq(taxTypes.slug, "us-tx-sales-use")).limit(1);
const [src] = await db.select().from(sources).where(eq(sources.url, "https://comptroller.texas.gov/taxes/sales/city.php")).limit(1);
const [snap] = await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.sourceId, src!.id)).limit(1);
if (!tx || !salesType || !src || !snap) throw new Error("missing tx/type/source/snapshot");
const slugOf = (n: string, code: string) =>
  code === "2227016" ? "us-tx-austin" : `us-tx-city-${n.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").replace(/['.]/g, "").trim().replace(/\s+/g, "-")}`;
let registered = 0;
for (const r of rows) {
  const slug = slugOf(r.name, r.code);
  const [existing] = await db.select({ id: jurisdictions.id }).from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  if (!existing) {
    await db.insert(jurisdictions).values({
      slug, parentId: tx.id, level: "city", name: r.name.replace(/\s*\([^)]*\)\s*$/, ""), countryCode: "US",
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
    payload: { rateValue: r.rate, rateUnit: "percent", jurisdictionSlug: slugOf(r.name, r.code), appliesTo: `City sales/use tax component (${r.name}, Comptroller local code ${r.code}); table combined total shown ${r.total}%` },
    citation: "Texas Comptroller City Sales and Use Tax Rates table snapshot",
    sourceId: src.id, snapshotId: snap.id, verdict: "pending",
  });
  items += 1;
}
console.log(`registered=${registered} proposal=${prop!.id} items=${items}`);
await client.end();
