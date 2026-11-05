import { desc, eq } from "drizzle-orm";
import {
  client, db, jurisdictions, proposalItems, proposals, sources, sourceSnapshots, taxTypes,
} from "@agent-tax-research/database";
import { assignSlugs, cleanCityName, parseCityRows } from "./city-slug.js";

// #43 reconciliation: re-parse the stored Comptroller city snapshot with
// the fixed parser (seven-decimal max-rate rows) and file component
// proposals ONLY for coded places missing from jurisdictions. Existing
// published cities are never touched; structure places registered by geo
// population (#39) are matched by name and stamped with their
// Comptroller code instead of twinned. Human approves last.
const [src] = await db.select().from(sources)
  .where(eq(sources.url, "https://comptroller.texas.gov/taxes/sales/city.php")).limit(1);
if (!src) throw new Error("city source missing");
const [snap] = await db.select().from(sourceSnapshots)
  .where(eq(sourceSnapshots.sourceId, src.id)).orderBy(desc(sourceSnapshots.createdAt)).limit(1);
if (!snap?.retrievedText) throw new Error("city snapshot missing");

const { rows, rejected } = parseCityRows(snap.retrievedText);
const slugByCode = assignSlugs(rows);
const cities = await db.select().from(jurisdictions).where(eq(jurisdictions.level, "city"));
const knownCodes = new Set<string>();
const byName = new Map<string, typeof cities[number]>();
for (const c of cities) {
  const code = c.code ?? (typeof c.datavalues?.comptrollerLocalCode === "string" ? c.datavalues.comptrollerLocalCode : null);
  if (code && /^\d{7}$/.test(code)) knownCodes.add(code);
  byName.set(cleanCityName(c.name).toLowerCase(), c);
}
// Austin's seeded row (us-tx-austin) carried no code stamp until this
// script's first run stamped it — never re-propose an already-published
// slug even if its code looks missing.
const missing = rows.filter((r) => !knownCodes.has(r.code) && r.code !== "2227016");
console.log(`parsed=${rows.length} rejected=${rejected.length} missing_codes=${missing.length}`);
for (const r of missing) console.log(`  missing ${r.code} ${r.name} rate=${r.rate} total=${r.total}`);
if (!missing.length) { console.log("nothing to reconcile"); await client.end(); process.exit(0); }

const [tx] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-tx")).limit(1);
const [salesType] = await db.select().from(taxTypes).where(eq(taxTypes.slug, "us-tx-sales-use")).limit(1);
if (!tx || !salesType) throw new Error("missing tx/type");

let registered = 0, matched = 0;
const slugFor = new Map<string, string>();
for (const r of missing) {
  const existing = byName.get(cleanCityName(r.name).toLowerCase());
  if (existing) {
    await db.update(jurisdictions).set({
      code: r.code, updatedAt: new Date(),
      datavalues: { ...existing.datavalues, comptrollerLocalCode: r.code, combinedTotalShown: r.total },
    }).where(eq(jurisdictions.id, existing.id));
    slugFor.set(r.code, existing.slug);
    matched += 1;
    console.log(`  matched structure place ${existing.slug} <- code ${r.code}`);
  } else {
    const slug = slugByCode.get(r.code)!;
    await db.insert(jurisdictions).values({
      slug, parentId: tx.id, level: "city", code: r.code, name: r.name, countryCode: "US",
      datavalues: { comptrollerLocalCode: r.code, combinedTotalShown: r.total, reconciledFor: "#43" },
    });
    slugFor.set(r.code, slug);
    registered += 1;
    console.log(`  registered ${slug} (code ${r.code})`);
  }
}

const [prop] = await db.insert(proposals).values({
  jurisdictionId: tx.id, taxTypeId: salesType.id, status: "proposed",
  datavalues: { reconciledFor: "#43", parserFix: "seven-decimal rates" },
}).returning({ id: proposals.id });
let items = 0;
for (const r of missing) {
  await db.insert(proposalItems).values({
    proposalId: prop!.id, targetTable: "tax_rates",
    payload: { rateValue: r.rate, rateUnit: "percent", jurisdictionSlug: slugFor.get(r.code)!, appliesTo: `City sales/use tax component (${r.name}, Comptroller local code ${r.code}); table combined total shown ${r.total}%` },
    citation: "Texas Comptroller City Sales and Use Tax Rates table snapshot (re-parsed, #43)",
    sourceId: src.id, snapshotId: snap.id, verdict: "pending",
  });
  items += 1;
}
console.log(`matched=${matched} registered=${registered} proposal=${prop!.id} items=${items}`);
await client.end();
