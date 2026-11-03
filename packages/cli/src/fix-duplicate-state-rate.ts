import { and, eq, isNull } from "drizzle-orm";
import { client, db, jurisdictions, taxRates, taxTypes } from "@agent-tax-research/database";

// One-time #42 fix: the #16 publish batch inserted a successor Texas state
// sales-tax row without closing the seeded row, so two open-ended 6.25%
// rows double-count in reporting.current_rates (Austin 14.50, not 8.25).
// Guarded to the exact observed state; closes (never deletes) the
// superseded row, then asserts the tie-out + no duplicate current rows.
const [tt] = await db.select().from(taxTypes).where(eq(taxTypes.slug, "us-tx-sales-use")).limit(1);
const [tx] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-tx")).limit(1);
if (!tt || !tx) throw new Error("missing tax type / jurisdiction");

const open = await db.select().from(taxRates).where(and(
  eq(taxRates.taxTypeId, tt.id), eq(taxRates.jurisdictionId, tx.id), isNull(taxRates.effectiveTo),
)).orderBy(taxRates.effectiveFrom);
if (open.length === 1) {
  console.log("state row already closed (idempotent re-run); asserting tie-outs only");
} else if (open.length === 2) {
  const [oldRow, newRow] = open as [typeof open[0], typeof open[1]];
  if (Number(oldRow.rateValue) !== 6.25 || Number(newRow.rateValue) !== 6.25) {
    throw new Error("observed rates differ from the #42 repro — aborting");
  }
  const closeTo = new Date(`${newRow.effectiveFrom}T00:00:00Z`);
  closeTo.setUTCDate(closeTo.getUTCDate() - 1);
  const closeToStr = closeTo.toISOString().slice(0, 10);
  await db.update(taxRates)
    .set({ effectiveTo: closeToStr, updatedAt: new Date() })
    .where(eq(taxRates.id, oldRow.id));
  console.log(`closed superseded row ${oldRow.id} (from ${oldRow.effectiveFrom}) at ${closeToStr}; successor from ${newRow.effectiveFrom}`);
} else {
  throw new Error(`expected 1-2 open state rows, found ${open.length} — aborting`);
}

// Exact duplicates only: tiered taxes legitimately hold several current
// rows per jurisdiction, distinguished by `conditions` + value.
const dup = await client`
  SELECT tax_type_id, jurisdiction_id, rate_unit, applies_to, conditions,
    rate_value, count(*) AS n
  FROM tax_rates
  WHERE effective_from <= CURRENT_DATE
    AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  GROUP BY 1,2,3,4,5,6 HAVING count(*) > 1`;
const [austin] = await client`
  SELECT sum(cr.rate_value) AS total FROM reporting.current_rates cr
  JOIN tax_types t ON t.id = cr.tax_type_id
  JOIN jurisdictions j ON j.id = cr.jurisdiction_id
  WHERE t.slug = 'us-tx-sales-use' AND j.slug IN ('us-tx','us-tx-austin','us-tx-capmetro')`;
console.log(`duplicate current groups: ${dup.length}; Austin combined: ${austin?.total}`);
if (dup.length) throw new Error("duplicate current rate rows remain");
if (Number(austin?.total) !== 8.25) throw new Error(`Austin tie-out failed: ${austin?.total} != 8.25`);
console.log("RATE-STACK Austin tie-out: 8.25 exact, variance 0");
await client.end();
