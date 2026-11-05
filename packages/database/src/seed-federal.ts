import { eq } from "drizzle-orm";
import { client, db } from "./index.js";
import {
  jurisdictions,
  sources,
  taxCompliance,
  taxRates,
  taxRules,
  taxTypes,
} from "./schema.js";
import { FED_AGENCY, federalTaxTypes } from "./seed-data/federal.js";

/** US Federal first-wave seed (decree p4.t1). Idempotent. Run after db:seed. */

async function main() {
  const [us] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us")).limit(1);
  if (!us) throw new Error("us jurisdiction missing; run db:seed first");

  const bySlug = new Map<string, { id: string; sourceId: string }>();
  for (const t of federalTaxTypes) {
    const [type] = await db
      .insert(taxTypes)
      .values({
        jurisdictionId: us.id, slug: t.slug, name: t.name, category: t.category,
        description: t.description, administeringAgency: FED_AGENCY, officialUrl: t.officialUrl,
      })
      .onConflictDoUpdate({ target: taxTypes.slug, set: { name: t.name, category: t.category, updatedAt: new Date() } })
      .returning();
    if (!type) throw new Error(`upsert failed ${t.slug}`);
    const [source] = await db
      .insert(sources)
      .values({
        jurisdictionId: us.id, taxTypeId: type.id, name: `${t.name} — IRS`, url: t.officialUrl,
        sourceType: "agency_guidance", publisher: FED_AGENCY, isAuthoritative: true,
        monitorCadence: "weekly", checkMethod: "content_hash", status: "active",
        publisherType: "government", eligibility: "eligible",
      })
      .onConflictDoUpdate({ target: sources.url, set: { taxTypeId: type.id, publisherType: "government", eligibility: "eligible", updatedAt: new Date() } })
      .returning();
    if (!source) throw new Error(`source upsert failed ${t.slug}`);
    bySlug.set(t.slug, { id: type.id, sourceId: source.id });
  }

  const hasRates = async (taxTypeId: string) =>
    (await db.select({ id: taxRates.id }).from(taxRates).where(eq(taxRates.taxTypeId, taxTypeId)).limit(1)).length > 0;

  const corp = bySlug.get("us-federal-income-corporate")!;
  if (!(await hasRates(corp.id))) {
    await db.insert(taxRates).values({
      taxTypeId: corp.id, jurisdictionId: us.id, sourceId: corp.sourceId,
      rateValue: "21", rateUnit: "percent", appliesTo: "Corporate taxable income (flat rate)",
      effectiveFrom: "2018-01-01",
      citation: "IRC section 11(b) as amended by P.L. 115-97 (TCJA); IRS corporations guidance",
      verificationStatus: "needs_review",
    });
    await db.insert(taxCompliance).values({
      taxTypeId: corp.id, jurisdictionId: us.id, sourceId: corp.sourceId,
      obligationType: "return_filing", formNumber: "1120", formName: "U.S. Corporation Income Tax Return",
      formUrl: "https://www.irs.gov/forms-pubs/about-form-1120", filingFrequency: "annual",
      dueDateRule: "Calendar-year filers: April 15 (15th day of 4th month after year end generally); automatic 6-month extension via Form 7004. Estimated installments quarterly.",
      filingMethods: "IRS e-file (Modernized e-File), paper for eligible filers",
      paymentMethods: "EFTPS, Direct Pay, wire",
      collectRemitSummary: "Direct tax: corporation computes, files, and remits to the IRS/US Treasury; nothing is collected from customers.",
      effectiveFrom: "2018-01-01", citation: "IRC sections 11, 6012, 6072; IRS Form 1120 instructions", verificationStatus: "needs_review",
    });
  }

  const fica = bySlug.get("us-federal-payroll-fica")!;
  if (!(await hasRates(fica.id))) {
    const comp = (rateValue: string, conditions: string, appliesTo: string) => ({
      taxTypeId: fica.id, jurisdictionId: us.id, sourceId: fica.sourceId,
      rateValue, rateUnit: "percent", appliesTo, conditions,
      effectiveFrom: "2013-01-01", citation: "IRC sections 3101/3111 (FICA); IRS employment taxes guidance",
      verificationStatus: "needs_review" as const,
    });
    await db.insert(taxRates).values([
      comp("6.2", "Employee Social Security share", "Wages up to the annual Social Security wage base (indexed)"),
      comp("6.2", "Employer Social Security share", "Wages up to the annual Social Security wage base (indexed)"),
      comp("1.45", "Employee Medicare share", "All wages (additional 0.9% above statutory thresholds)"),
      comp("1.45", "Employer Medicare share", "All wages"),
    ]);
    await db.insert(taxRules).values({
      taxTypeId: fica.id, sourceId: fica.sourceId, ruleType: "threshold", authorityLevel: "statute",
      title: "Wage base and additional Medicare tax",
      summary: "Social Security portion applies only up to the annually indexed wage base; an additional 0.9% Medicare tax applies to employee wages above statutory thresholds (filing-status dependent). FUTA (separate federal type) is 6.0% on the first $7,000 per employee with up to 5.4% credit for state unemployment taxes.",
      effectiveFrom: "2013-01-01", citation: "IRC sections 3101, 3111, 3121(a)(1), 3301-3306 (FUTA credit section 3302)", verificationStatus: "needs_review",
    });
    await db.insert(taxCompliance).values({
      taxTypeId: fica.id, jurisdictionId: us.id, sourceId: fica.sourceId,
      obligationType: "return_filing", formNumber: "941", formName: "Employer's Quarterly Federal Tax Return",
      formUrl: "https://www.irs.gov/forms-pubs/about-form-941", filingFrequency: "quarterly",
      dueDateRule: "Quarterly: last day of month following quarter end (Apr 30, Jul 31, Oct 31, Jan 31); deposits monthly/semiweekly by lookback.",
      filingMethods: "IRS e-file, paper", paymentMethods: "EFTPS (required for deposits)",
      collectRemitSummary: "Employer withholds employee share from wages, adds employer share, deposits via EFTPS and reports quarterly on Form 941.",
      effectiveFrom: "2013-01-01", citation: "IRC Chapter 21; IRS Publication 15", verificationStatus: "needs_review",
    });
  }

  const futa = bySlug.get("us-federal-unemployment-futa")!;
  if (!(await hasRates(futa.id))) {
    await db.insert(taxRates).values({
      taxTypeId: futa.id, jurisdictionId: us.id, sourceId: futa.sourceId,
      rateValue: "6.0", rateUnit: "percent", appliesTo: "First $7,000 of wages per employee per year",
      conditions: "Before state unemployment tax credit (up to 5.4%); effective floor 0.6% for timely state payments in non-credit-reduction states",
      effectiveFrom: "2011-07-01", citation: "IRC sections 3301, 3302, 3306(b)(1)", verificationStatus: "needs_review",
    });
  }

  const indiv = bySlug.get("us-federal-income-individual")!;
  const indivRules = await db.select({ id: taxRules.id }).from(taxRules).where(eq(taxRules.taxTypeId, indiv.id)).limit(1);
  if (indivRules.length === 0) {
    await db.insert(taxRules).values({
      taxTypeId: indiv.id, sourceId: indiv.sourceId, ruleType: "calculation", authorityLevel: "statute",
      title: "Graduated brackets, annually indexed",
      summary: "Individual rates are graduated brackets under IRC section 1(j), indexed annually by revenue procedure (brackets, standard deduction, thresholds change each year). There is no single federal individual rate; bracket tables must be captured per tax year from the annual Rev. Proc. before any rate rows are recorded.",
      effectiveFrom: "2018-01-01", citation: "IRC section 1(j); annual inflation-adjustment revenue procedures", verificationStatus: "needs_review",
    });
  }

  console.log(`Seeded federal: ${federalTaxTypes.length} tax types + sources; corporate/FICA/FUTA rates; individual bracket rule.`);
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err: unknown) => { console.error(err); await client.end().catch(() => undefined); process.exit(1); });
