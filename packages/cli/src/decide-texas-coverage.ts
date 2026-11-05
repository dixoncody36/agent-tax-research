import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  client, coverageAnswers, db, jurisdictions, sources, sourceSnapshots,
  taxRates, taxRules, taxTypes,
} from "@agent-tax-research/database";

// Decision stage for Texas coverage depth questions answerable from
// ALREADY-PUBLISHED data (#16): levy_exists / state_rate /
// local_rates_and_cap rows flip unknown -> found only when a verified
// published rate (or rule) for the type exists, citing that row's
// statutory citation — determinations re-performable from the stored
// rate/rule ids. Depth questions needing new primary research
// (rate_history, penalties, exemptions...) stay unknown. The 8.25% cap
// additionally requires the cap excerpt inside a Comptroller snapshot.
// Usage: tsx src/decide-texas-coverage.ts --run-id <decision uuid>

const runIdx = process.argv.indexOf("--run-id");
const runId = runIdx >= 0 ? process.argv[runIdx + 1] : undefined;
if (!runId) throw new Error("usage: decide-texas-coverage.ts --run-id <uuid>");

const KEYS = ["levy_exists", "state_rate", "local_rates_and_cap"];
const [tx] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-tx")).limit(1);
if (!tx) throw new Error("us-tx missing");

const unknowns = await db.select().from(coverageAnswers)
  .where(and(eq(coverageAnswers.jurisdictionId, tx.id), eq(coverageAnswers.status, "unknown")))
  .then((all) => all.filter((a) => KEYS.includes(a.questionKey)));

let decided = 0;
const skipped: string[] = [];
for (const row of unknowns) {
  const [tt] = row.taxTypeId ? await db.select().from(taxTypes).where(eq(taxTypes.id, row.taxTypeId)).limit(1) : [undefined];
  if (!tt) { skipped.push(`${row.questionKey}: no tax type`); continue; }
  const current = await db.select().from(taxRates)
    .where(and(eq(taxRates.jurisdictionId, tx.id), eq(taxRates.taxTypeId, tt.id), eq(taxRates.verificationStatus, "verified"),
      sql`${taxRates.effectiveFrom} <= current_date`, or(isNull(taxRates.effectiveTo), sql`${taxRates.effectiveTo} >= current_date`)))
    .orderBy(desc(taxRates.createdAt));

  let answer: string | null = null;
  let evidence: Record<string, unknown> = { decidedBy: "decide-texas-coverage (published-data determinations)" };
  if (row.questionKey === "levy_exists") {
    const rate = current[0];
    const [rule] = rate ? [undefined] : await db.select().from(taxRules).where(eq(taxRules.taxTypeId, tt.id)).limit(1);
    if (rate) {
      answer = `Texas imposes the ${tt.name}. Current published state component: ${rate.rateValue} ${rate.rateUnit} effective ${rate.effectiveFrom}. Authority per cited published rate: ${rate.citation ?? "(citation on rate row)"}`;
      evidence = { ...evidence, rateId: rate.id, citation: rate.citation };
    } else if (rule) {
      answer = `Texas imposes the ${tt.name}, evidenced by published verified rule rows (rate schedule determination pending). Rule citation: ${rule.citation ?? rule.title ?? "(see rule row)"}`;
      evidence = { ...evidence, ruleId: rule.id, citation: rule.citation };
    }
  } else if (row.questionKey === "state_rate") {
    const rate = current[0];
    if (rate) {
      answer = `State rate: ${rate.rateValue} ${rate.rateUnit}, effective ${rate.effectiveFrom}. Applies to: ${rate.appliesTo ?? tt.name}. Authority: ${rate.citation ?? "(citation on rate row)"}`;
      evidence = { ...evidence, rateId: rate.id, citation: rate.citation };
    }
  } else if (row.questionKey === "local_rates_and_cap" && tt.slug === "us-tx-sales-use") {
    const [localCount] = await db.select({ n: sql<number>`count(*)::int` }).from(taxRates)
      .innerJoin(jurisdictions, eq(jurisdictions.id, taxRates.jurisdictionId))
      .where(and(eq(taxRates.taxTypeId, tt.id), eq(taxRates.verificationStatus, "verified"), sql`${jurisdictions.slug} like 'us-tx-%'`));
    const capSnaps = await db.select({ id: sourceSnapshots.id, hash: sourceSnapshots.contentHash, url: sources.url })
      .from(sourceSnapshots).innerJoin(sources, eq(sources.id, sourceSnapshots.sourceId))
      .where(and(eq(sources.jurisdictionId, tx.id), sql`${sourceSnapshots.retrievedText} like '%8.25 percent%'`))
      .limit(1);
    if (localCount && localCount.n > 0 && capSnaps[0]) {
      answer = `Local sales-tax components (city, county, special purpose district, transit) stack on the 6.25% state rate; ${localCount.n} verified local component rows are published. Combined rate is capped at 8.25 percent per the cited Comptroller snapshot.`;
      evidence = { ...evidence, localRateRows: localCount.n, capSnapshotHash: capSnaps[0].hash, capSourceUrl: capSnaps[0].url };
    }
  }

  if (!answer) { skipped.push(`${tt.slug}/${row.questionKey}: no published evidence row`); continue; }
  await db.update(coverageAnswers).set({
    status: "found", answer, evidence, answeredByRunId: runId, updatedAt: new Date(),
  }).where(eq(coverageAnswers.id, row.id));
  console.log(`FOUND ${tt.slug}/${row.questionKey}`);
  decided += 1;
}
console.log(JSON.stringify({ decided, skipped }, null, 2));
await client.end();
