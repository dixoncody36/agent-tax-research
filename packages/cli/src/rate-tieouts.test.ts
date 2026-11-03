import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { client } from "@agent-tax-research/database";

// Regression suite for #42 (RATE-STACK): a publish batch left two
// open-ended Texas state rows current at once, doubling the Austin
// combined rate. Runs against the real local DB (docker compose up -d).

after(async () => {
  await client.end();
});

describe("RATE-STACK tie-outs", () => {
  it("Austin combined sales-tax rate is exactly 8.25", async () => {
    const [row] = await client`
      SELECT sum(cr.rate_value) AS total FROM reporting.current_rates cr
      JOIN tax_types t ON t.id = cr.tax_type_id
      JOIN jurisdictions j ON j.id = cr.jurisdiction_id
      WHERE t.slug = 'us-tx-sales-use'
        AND j.slug IN ('us-tx', 'us-tx-austin', 'us-tx-capmetro')`;
    assert.equal(Number(row?.total), 8.25);
  });

  it("no exact-duplicate current rate rows (tiers differ by conditions/value)", async () => {
    // Tiered taxes legitimately hold several current rows per jurisdiction
    // (FICA employer/employee shares, franchise classes) — `conditions`
    // carries the qualifier. The #42 defect was an exact duplicate: a
    // successor inserted without closing its predecessor.
    const dups = await client`
      SELECT tax_type_id, jurisdiction_id, rate_unit, applies_to, conditions,
        rate_value, count(*) AS n
      FROM tax_rates
      WHERE effective_from <= CURRENT_DATE
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      GROUP BY 1, 2, 3, 4, 5, 6 HAVING count(*) > 1`;
    assert.equal(dups.length, 0, JSON.stringify(dups));
  });
});
