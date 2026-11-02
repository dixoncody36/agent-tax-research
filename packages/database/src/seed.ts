import { eq, sql } from "drizzle-orm";
import { client, db } from "./index.js";
import {
  coverageQuestions,
  jurisdictions,
  sources,
  taxCompliance,
  taxLicenses,
  taxRates,
  taxRules,
  taxTypes,
} from "./schema.js";
import { coverageQuestionsSeed } from "./seed-data/question-packs.js";
import { TX_AGENCY, TX_BASE, texasTaxTypes } from "./seed-data/texas.js";

/**
 * Phase 1 seed — idempotent. Safe to re-run: jurisdictions/tax types/
 * sources upsert on their unique slug/URL; deep Texas detail is only
 * inserted when the tax type has no rates yet.
 *
 * Run: pnpm db:seed   (DATABASE_URL must point at the container)
 */

async function upsertJurisdiction(values: typeof jurisdictions.$inferInsert) {
  const [row] = await db
    .insert(jurisdictions)
    .values(values)
    .onConflictDoUpdate({
      target: jurisdictions.slug,
      set: { name: values.name, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error(`jurisdiction upsert failed: ${values.slug}`);
  return row;
}

async function main() {
  // --- Jurisdictions: US -> Texas, plus Austin/Travis/CapMetro to prove
  // hierarchy + combined-rate stacking (see docs/data-model.md). ---
  const us = await upsertJurisdiction({
    slug: "us",
    level: "country",
    code: "US",
    name: "United States",
    countryCode: "US",
    currencyCode: "USD",
  });
  const tx = await upsertJurisdiction({
    slug: "us-tx",
    parentId: us.id,
    level: "state",
    code: "US-TX",
    name: "Texas",
    countryCode: "US",
    currencyCode: "USD",
    timezone: "America/Chicago",
  });
  const travis = await upsertJurisdiction({
    slug: "us-tx-travis",
    parentId: tx.id,
    level: "county",
    name: "Travis County",
    countryCode: "US",
  });
  const austin = await upsertJurisdiction({
    slug: "us-tx-austin",
    parentId: travis.id,
    level: "city",
    name: "Austin",
    countryCode: "US",
  });
  const capMetro = await upsertJurisdiction({
    slug: "us-tx-capmetro",
    parentId: tx.id,
    level: "special_district",
    name: "Capital Metropolitan Transportation Authority",
    officialName: "Capital Metro (CapMetro) transit authority",
    countryCode: "US",
    datavalues: { districtKind: "transit_authority" },
  });

  // --- Tax types (all 27 from the A-to-Z index) + one monitored source each.
  const typeBySlug = new Map<string, { id: string; sourceId: string }>();
  for (const t of texasTaxTypes) {
    const [type] = await db
      .insert(taxTypes)
      .values({
        jurisdictionId: tx.id,
        slug: t.slug,
        name: t.name,
        category: t.category,
        administeringAgency: TX_AGENCY,
        officialUrl: `${TX_BASE}${t.path}`,
      })
      .onConflictDoUpdate({
        target: taxTypes.slug,
        set: { name: t.name, category: t.category, updatedAt: new Date() },
      })
      .returning();
    if (!type) throw new Error(`tax type upsert failed: ${t.slug}`);

    const [source] = await db
      .insert(sources)
      .values({
        jurisdictionId: tx.id,
        taxTypeId: type.id,
        name: `${t.name} — Texas Comptroller`,
        url: `${TX_BASE}${t.path}`,
        sourceType: "agency_guidance",
        publisher: TX_AGENCY,
        isAuthoritative: true,
        monitorCadence: "weekly",
        checkMethod: "content_hash",
        status: "active",
      })
      .onConflictDoUpdate({
        target: sources.url,
        set: { taxTypeId: type.id, updatedAt: new Date() },
      })
      .returning();
    if (!source) throw new Error(`source upsert failed: ${t.path}`);
    typeBySlug.set(t.slug, { id: type.id, sourceId: source.id });
  }

  // The A-to-Z index itself is a monitored source (new tax types appear here).
  await db
    .insert(sources)
    .values({
      jurisdictionId: tx.id,
      name: "Texas Taxes and Fees — A to Z Index",
      url: `${TX_BASE}/taxes/a-to-z.php`,
      sourceType: "agency_guidance",
      publisher: TX_AGENCY,
      isAuthoritative: true,
      monitorCadence: "weekly",
      checkMethod: "content_hash",
      status: "active",
      notes: "Discovery source: watch for new/removed Texas tax types.",
    })
    .onConflictDoNothing({ target: sources.url });

  const hasRates = async (taxTypeId: string) => {
    const rows = await db
      .select({ id: taxRates.id })
      .from(taxRates)
      .where(eq(taxRates.taxTypeId, taxTypeId))
      .limit(1);
    return rows.length > 0;
  };

  // =========================================================================
  // Deep seed — Sales and Use Tax (read from /taxes/sales/, 2026-11-01)
  // State 6.25%; local jurisdictions up to 2%; max combined 8.25%.
  // Austin components (city 1.00 + CapMetro 1.00) demonstrate stacking and
  // are marked unverified pending Phase 2 rate-table extraction.
  // =========================================================================
  const sales = typeBySlug.get("us-tx-sales-use")!;
  if (!(await hasRates(sales.id))) {
    await db.insert(taxRates).values([
      {
        taxTypeId: sales.id,
        jurisdictionId: tx.id,
        sourceId: sales.sourceId,
        rateValue: "6.25",
        rateUnit: "percent",
        appliesTo: "Retail sales, leases and rentals of most goods, and taxable services",
        effectiveFrom: "1990-01-01",
        citation: "Tex. Tax Code ch. 151 (state rate); Comptroller sales tax page",
        verificationStatus: "verified",
      },
      {
        taxTypeId: sales.id,
        jurisdictionId: austin.id,
        sourceId: sales.sourceId,
        rateValue: "1.00",
        rateUnit: "percent",
        appliesTo: "City of Austin local sales and use tax component",
        conditions: "Example local component — confirm against Comptroller city rate table",
        effectiveFrom: "2026-01-01",
        citation: "Comptroller City Sales Tax Rates (/taxes/sales/city.php)",
        verificationStatus: "unverified",
      },
      {
        taxTypeId: sales.id,
        jurisdictionId: capMetro.id,
        sourceId: sales.sourceId,
        rateValue: "1.00",
        rateUnit: "percent",
        appliesTo: "CapMetro transit authority sales and use tax component (Austin area)",
        conditions: "Example transit component — confirm against Comptroller transit rate table",
        effectiveFrom: "2026-01-01",
        citation: "Comptroller Transit Sales Tax Rates (/taxes/sales/mta.php)",
        verificationStatus: "unverified",
      },
    ]);

    await db.insert(taxRules).values([
      {
        taxTypeId: sales.id,
        sourceId: sales.sourceId,
        ruleType: "applicability",
        authorityLevel: "statute",
        title: "Combined local rate cap",
        summary:
          "Local taxing jurisdictions (cities, counties, special purpose districts and transit authorities) can impose up to 2% combined, for a maximum combined state+local rate of 8.25%.",
        effectiveFrom: "1990-01-01",
        citation: "Tex. Tax Code ch. 151; local sales tax statutes (/taxes/sales/statutes.php)",
        verificationStatus: "verified",
      },
      {
        taxTypeId: sales.id,
        sourceId: sales.sourceId,
        ruleType: "discount",
        authorityLevel: "guidance",
        title: "Timely filing and prepayment discounts",
        summary:
          "Permitted sales taxpayers can claim 0.5% of tax timely reported and paid; prepaying taxpayers can claim an additional 1.25%.",
        effectiveFrom: "2026-01-01",
        citation: "Comptroller sales tax page — Discounts, Penalties, Interest and Refunds",
        verificationStatus: "verified",
      },
      {
        taxTypeId: sales.id,
        sourceId: sales.sourceId,
        ruleType: "penalty",
        authorityLevel: "guidance",
        title: "Late filing/payment penalties and interest",
        summary:
          "$50 per report filed after the due date; 5% penalty if paid 1–30 days late, 10% if over 30 days late; interest begins 61 days after the due date.",
        effectiveFrom: "2026-01-01",
        citation: "Comptroller sales tax page — Penalties and Interest",
        verificationStatus: "verified",
      },
    ]);

    await db.insert(taxLicenses).values({
      taxTypeId: sales.id,
      jurisdictionId: tx.id,
      sourceId: sales.sourceId,
      name: "Texas Sales Tax Permit",
      licenseType: "permit",
      requiredFor:
        "Selling, leasing or renting taxable goods or providing taxable services in Texas (collecting Texas sales/use tax)",
      issuingAgency: TX_AGENCY,
      applicationUrl: `${TX_BASE}/taxes/permit/`,
      effectiveFrom: "2026-01-01",
      citation: "Comptroller — Apply for a Sales Tax Permit (/taxes/permit/)",
      verificationStatus: "verified",
    });

    await db.insert(taxCompliance).values({
      taxTypeId: sales.id,
      jurisdictionId: tx.id,
      sourceId: sales.sourceId,
      obligationType: "return_filing",
      formName: "Texas Sales and Use Tax Return",
      formUrl: `${TX_BASE}/taxes/sales/forms/`,
      filingFrequency: "varies_by_liability",
      dueDateRule:
        "Monthly filers: 20th of month following reporting month. Quarterly: Apr 20 / Jul 20 / Oct 20 / Jan 20. Yearly: Jan 20. Next business day if due date is Sat/Sun/holiday. Filing frequency assigned by Comptroller letter after permit approval.",
      filingMethods: "Webfile (eSystems), EDI, paper forms",
      paymentMethods: "Webfile EFT/credit card, TEXNET (mandatory electronic payers; >$1,000,000 initiate by 8pm CT prior banking day), check",
      collectRemitSummary:
        "Seller/permit holder collects state + local sales/use tax from purchaser at point of sale and remits to the Texas Comptroller; Comptroller allocates local shares to cities/counties/districts/transit authorities.",
      effectiveFrom: "2026-01-01",
      citation: "Comptroller sales tax page — Due Dates; Reporting and Payment Requirements",
      verificationStatus: "verified",
      datavalues: { timelyFilerDiscountPercent: 0.5 },
    });
  }

  // =========================================================================
  // Deep seed — Franchise Tax (read from /taxes/franchise/, 2026-11-01)
  // Privilege (margin) tax. 2026–27 amounts read from the page table;
  // row labels follow the page's standard order, so rates are
  // needs_review until an agent re-reads the labelled table.
  // =========================================================================
  const franchise = typeBySlug.get("us-tx-franchise")!;
  if (!(await hasRates(franchise.id))) {
    await db.insert(taxRates).values([
      {
        taxTypeId: franchise.id,
        jurisdictionId: tx.id,
        sourceId: franchise.sourceId,
        rateValue: "0.375",
        rateUnit: "percent",
        appliesTo: "Taxable margin — entities primarily engaged in retail or wholesale trade",
        conditions: "Report years 2026–2027",
        effectiveFrom: "2026-01-01",
        citation: "Tex. Tax Code ch. 171; Comptroller — Tax Rates, Thresholds and Deduction Limits",
        verificationStatus: "needs_review",
      },
      {
        taxTypeId: franchise.id,
        jurisdictionId: tx.id,
        sourceId: franchise.sourceId,
        rateValue: "0.75",
        rateUnit: "percent",
        appliesTo: "Taxable margin — all other taxable entities",
        conditions: "Report years 2026–2027",
        effectiveFrom: "2026-01-01",
        citation: "Tex. Tax Code ch. 171; Comptroller — Tax Rates, Thresholds and Deduction Limits",
        verificationStatus: "needs_review",
      },
      {
        taxTypeId: franchise.id,
        jurisdictionId: tx.id,
        sourceId: franchise.sourceId,
        rateValue: "0.331",
        rateUnit: "percent",
        appliesTo: "Total revenue — EZ computation filers",
        conditions: "Report years 2026–2027; EZ threshold $20 million total revenue",
        effectiveFrom: "2026-01-01",
        citation: "Tex. Tax Code ch. 171; Comptroller — Tax Rates, Thresholds and Deduction Limits",
        verificationStatus: "needs_review",
      },
    ]);

    await db.insert(taxRules).values([
      {
        taxTypeId: franchise.id,
        sourceId: franchise.sourceId,
        ruleType: "applicability",
        authorityLevel: "statute",
        title: "Privilege tax on taxable entities",
        summary:
          "Texas franchise tax is a privilege tax imposed on each taxable entity formed or organized in Texas or doing business in Texas.",
        effectiveFrom: "2026-01-01",
        citation: "Tex. Tax Code ch. 171; 34 TAC ch. 3 subch. V",
        verificationStatus: "verified",
      },
      {
        taxTypeId: franchise.id,
        sourceId: franchise.sourceId,
        ruleType: "threshold",
        authorityLevel: "guidance",
        title: "No-tax-due threshold (2026–2027)",
        summary:
          "No-tax-due threshold $2,650,000 for report years 2026–2027. Entities at/below threshold file a Public Information Report or Ownership Information Report instead of paying tax. Amounts vary by report year — use the rate/threshold set for the filing year.",
        effectiveFrom: "2026-01-01",
        citation: "Comptroller — Tax Rates, Thresholds and Deduction Limits (2026 and 2027)",
        verificationStatus: "needs_review",
        datavalues: {
          noTaxDueThresholdUsd: 2650000,
          compensationDeductionLimitUsd: 480000,
          ezComputationThresholdUsd: 20000000,
        },
      },
      {
        taxTypeId: franchise.id,
        sourceId: franchise.sourceId,
        ruleType: "penalty",
        authorityLevel: "guidance",
        title: "Late penalties, interest, and forfeiture",
        summary:
          "$50 per late report; 5% penalty 1–30 days late, 10% over 30 days; interest from 61 days after due date. Failure to meet filing requirements can forfeit the right to transact business / corporate registration (Forms 05-211 / 05-213).",
        effectiveFrom: "2026-01-01",
        citation: "Comptroller franchise page — Penalties and Interest; Franchise Tax Notices",
        verificationStatus: "verified",
      },
    ]);

    await db.insert(taxCompliance).values([
      {
        taxTypeId: franchise.id,
        jurisdictionId: tx.id,
        sourceId: franchise.sourceId,
        obligationType: "return_filing",
        formName: "Texas Franchise Tax Report",
        formUrl: `${TX_BASE}/taxes/franchise/forms/`,
        filingFrequency: "annual",
        dueDateRule:
          "Annual report due May 15; next business day if May 15 is a weekend/holiday. Extensions available on request. Final report required on termination/conversion/merger (Texas entities, in termination year) or within 60 days of ceasing Texas nexus (out-of-state entities).",
        filingMethods: "Webfile, approved tax preparation software, paper forms",
        paymentMethods: "Webfile EFT, TEXNET, check",
        collectRemitSummary:
          "Direct tax on the entity (not collected from customers): taxable entity computes margin, files annual report, and remits directly to the Texas Comptroller.",
        effectiveFrom: "2026-01-01",
        citation: "Comptroller franchise page — Due Dates; Reporting and Payment Requirements",
        verificationStatus: "verified",
      },
      {
        taxTypeId: franchise.id,
        jurisdictionId: tx.id,
        sourceId: franchise.sourceId,
        obligationType: "information_report",
        formName: "Public Information Report (PIR) / Ownership Information Report (OIR)",
        formUrl: `${TX_BASE}/taxes/franchise/pir-oir-filing-req.php`,
        filingFrequency: "annual",
        dueDateRule: "Filed with / in lieu of the annual franchise tax report (due May 15); sole filing for entities at/below the no-tax-due threshold.",
        filingMethods: "Webfile, paper forms",
        collectRemitSummary: "Informational only — no tax collected or remitted with PIR/OIR alone.",
        effectiveFrom: "2026-01-01",
        citation: "Comptroller — Public and Ownership Information Reports",
        verificationStatus: "verified",
      },
    ]);
  }

  // =========================================================================
  // Deep seed — Hotel Occupancy Tax (read from /taxes/hotel/, 2026-11-01)
  // State 6% on rooms $15+/day; local hotel taxes collected locally.
  // =========================================================================
  const hotel = typeBySlug.get("us-tx-hotel-occupancy")!;
  if (!(await hasRates(hotel.id))) {
    await db.insert(taxRates).values({
      taxTypeId: hotel.id,
      jurisdictionId: tx.id,
      sourceId: hotel.sourceId,
      rateValue: "6.00",
      rateUnit: "percent",
      appliesTo: "Cost of a hotel room/space costing $15 or more per day (state tax)",
      conditions: "Local hotel taxes are additional and collected by the local taxing authority",
      effectiveFrom: "2026-01-01",
      citation: "Tex. Tax Code ch. 156 (state); ch. 351 (municipal); ch. 352 (county)",
      verificationStatus: "verified",
    });

    await db.insert(taxRules).values([
      {
        taxTypeId: hotel.id,
        sourceId: hotel.sourceId,
        ruleType: "applicability",
        authorityLevel: "statute",
        title: "Who must collect",
        summary:
          "Hotel owners/operators/managers must collect state hotel occupancy tax from guests renting a room or space costing $15+ per day. Applies to hotels, motels, B&Bs, condominiums, apartments and houses — including homeowners renting homes/rooms, property managers, online travel and third-party rental companies. Local hotel taxes apply to rooms costing $2+ per day.",
        effectiveFrom: "2026-01-01",
        citation: "Comptroller hotel page — Who is responsible for this tax?; Tex. Tax Code ch. 156",
        verificationStatus: "verified",
      },
      {
        taxTypeId: hotel.id,
        sourceId: hotel.sourceId,
        ruleType: "discount",
        authorityLevel: "guidance",
        title: "Timely filing discount",
        summary: "1% discount of tax due when filed and paid by the due date (monthly or quarterly return).",
        effectiveFrom: "2026-01-01",
        citation: "Comptroller hotel page — Discounts",
        verificationStatus: "verified",
      },
      {
        taxTypeId: hotel.id,
        sourceId: hotel.sourceId,
        ruleType: "penalty",
        authorityLevel: "guidance",
        title: "Late penalties and interest",
        summary:
          "$50 per late report; 5% penalty 1–30 days late, 10% over 30 days; interest begins 61 days after the due date.",
        effectiveFrom: "2026-01-01",
        citation: "Comptroller hotel page — Penalties and Interest",
        verificationStatus: "verified",
      },
    ]);

    await db.insert(taxCompliance).values({
      taxTypeId: hotel.id,
      jurisdictionId: tx.id,
      sourceId: hotel.sourceId,
      obligationType: "return_filing",
      formName: "Texas Hotel Occupancy Tax Report",
      formUrl: `${TX_BASE}/taxes/hotel/forms/`,
      filingFrequency: "varies_by_liability",
      dueDateRule:
        "Monthly: 20th of month following calendar month. Quarterly (if qualified): 20th of month following calendar quarter.",
      filingMethods:
        "By prior state fiscal year (Sep 1–Aug 31) liability: <$50,000 Webfile or paper; $50,000+ Webfile only",
      paymentMethods:
        "<$10,000: Webfile EFT/credit card, TEXNET, or check; $10,000–$499,999: Webfile EFT/credit card or TEXNET; $500,000+: TEXNET only",
      efileThreshold: "50000",
      efileThresholdCurrency: "USD",
      collectRemitSummary:
        "Operator collects state tax from guest at rental and remits to the Texas Comptroller. Local hotel taxes are collected from the guest the same way but remitted to the local taxing authority, not the state.",
      effectiveFrom: "2026-01-01",
      citation: "Comptroller hotel page — Due Date; Reporting and Payment Requirements",
      verificationStatus: "verified",
    });
  }

  // --- Coverage question packs (decree p2): idempotent upsert on the
  // (category, questionKey) unique index. Pack edits ride this path;
  // changed wording/evidence updates the row in place. ---
  for (let i = 0; i < coverageQuestionsSeed.length; i += 50) {
    await db
      .insert(coverageQuestions)
      .values(coverageQuestionsSeed.slice(i, i + 50))
      .onConflictDoUpdate({
        target: [coverageQuestions.category, coverageQuestions.questionKey],
        set: {
          question: sql`excluded.question`,
          evidenceRequired: sql`excluded.evidence_required`,
          absenceRequires: sql`excluded.absence_requires`,
          sortOrder: sql`excluded.sort_order`,
          updatedAt: new Date(),
        },
      });
  }

  console.log(
    `Seeded: 5 jurisdictions, ${texasTaxTypes.length} Texas tax types, ` +
      `${texasTaxTypes.length + 1} monitored sources, deep detail for sales/franchise/hotel, ` +
      `${coverageQuestionsSeed.length} coverage questions.`,
  );
}

main()
  .then(async () => {
    await client.end();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error(err);
    await client.end().catch(() => undefined);
    process.exit(1);
  });


