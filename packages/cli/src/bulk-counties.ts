import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  client, db, jurisdictions, proposalItems, proposals, sources, sourceSnapshots, taxTypes,
} from "@agent-tax-research/database";

// One-off bulk registration from the Comptroller county rate-table
// snapshot (issue #17). Registers county jurisdictions and files ONE
// bulk sales-tax component proposal (125 items) for Reviewer + human.
// ponytail: temporary script, deleted after landing; generalize when
// city/SPD bulk registration lands.
const rawBuf = readFileSync(process.argv[2]!);
const text = rawBuf.includes(0) ? rawBuf.toString("utf16le") : rawBuf.toString("utf8");
const start = Math.max(0, text.indexOf("Anderson") - 40);
const end = text.indexOf("* 1.5% county tax rate");
const seg = text.slice(start, end > start ? end : undefined);
const re = /([A-Z][A-Za-z'. ]+?)(?:\s+([1-5*]))?\s+(\d{7})\s+(\d{2})\/(\d{2})\/(\d{4})/g;
type Row = { name: string; note: string | null; code: string; eff: string; rate: number };
const rows: Row[] = [];
for (const m of seg.matchAll(re)) {
  const name = m[1]!.trim().replace(/^Effective\s+/, "");
  if (name.length < 3 || /County Name/.test(name)) continue;
  const note = m[2] ?? null;
  const rate = note === "*" ? 1.5 : note === "4" || note === "5" ? 1.0 : 0.5;
  rows.push({ name, note, code: m[3]!, eff: `${m[6]}-${m[4]}-${m[5]}`, rate });
}
console.log(`parsed counties: ${rows.length}`);
const [tx] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-tx")).limit(1);
const [salesType] = await db.select().from(taxTypes).where(eq(taxTypes.slug, "us-tx-sales-use")).limit(1);
const [src] = await db.select().from(sources).where(eq(sources.url, "https://comptroller.texas.gov/taxes/sales/county.php")).limit(1);
const [snap] = await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.sourceId, src!.id)).limit(1);
if (!tx || !salesType || !src || !snap) throw new Error("missing tx/type/source/snapshot");

const slugOf = (n: string) => `us-tx-${n.toLowerCase().replace(/['.]/g, "").replace(/\s+/g, "-")}-county`;
let registered = 0;
for (const r of rows) {
  const slug = slugOf(r.name);
  const [existing] = await db.select({ id: jurisdictions.id }).from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  if (!existing) {
    await db.insert(jurisdictions).values({
      slug, parentId: tx.id, level: "county", name: `${r.name} County`, countryCode: "US",
      datavalues: { comptrollerLocalCode: r.code, countyTaxEffective: r.eff, footnote: r.note },
    });
    registered += 1;
  }
}
const [prop] = await db.insert(proposals).values({ jurisdictionId: tx.id, taxTypeId: salesType.id, status: "proposed" }).returning({ id: proposals.id });
let items = 0;
for (const r of rows) {
  await db.insert(proposalItems).values({
    proposalId: prop!.id, targetTable: "tax_rates",
    payload: { rateValue: r.rate, rateUnit: "percent", jurisdictionSlug: slugOf(r.name), effectiveFrom: r.eff, appliesTo: `County sales/use tax component (${r.name} County, Comptroller local code ${r.code})`, conditions: r.note ? `Table footnote ${r.note} (rate/SPD note per county table)` : "Standard 0.5% county rate" },
    citation: "Texas Comptroller County Sales and Use Tax table snapshot (125 counties, 0.5% unless asterisked/footnoted)",
    sourceId: src.id, snapshotId: snap.id, verdict: "pending",
  });
  items += 1;
}
console.log(`registered=${registered} proposal=${prop!.id} items=${items}`);
await client.end();
