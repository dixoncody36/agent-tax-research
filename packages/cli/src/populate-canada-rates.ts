import { eq } from "drizzle-orm";
import {
  client, db, jurisdictions, proposalItems, proposals, researchLedger,
  sources, sourceSnapshots, taxTypes,
} from "@agent-tax-research/database";

// Canada consumption-tax rate determinations (issue #48, Decision role).
// Evidence is snapshotted primary pages ONLY (snapshots from #47 fetch runs):
//  - CRA calculator/rates table: current rates + GST/HST bands since 2013-04-01
//  - Revenu Quebec basic rules: QST 9.975% on price excluding GST
//  - BC / Manitoba pages state their general rate; Saskatchewan's landing
//    does not state a rate, so SK 6% evidences from the CRA table alone.
// HST is stored as federal 5% (ca) + provincial portion (province) under
// ca-gst-hst — the Texas component pattern; portion = CRA published combined
// minus 5 (CRA itself states NS: "provincial portion 9% -> HST 14%").
// No invented history: PST/QST effectiveFrom = 2025-04-01, the earliest date
// the snapshotted CRA table (modified 2025-04-01) evidences the value;
// deeper history is a named gap for provincial archives / CRA Statistics.
// Usage: tsx src/populate-canada-rates.ts --run-id <decision agent_run uuid>

const runIdx = process.argv.indexOf("--run-id");
const runId = runIdx >= 0 ? process.argv[runIdx + 1] : undefined;
if (!runId) throw new Error("usage: populate-canada-rates.ts --run-id <uuid>");

const CRA_CALC_URL = "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html";
const RQ_BASIC_URL = "https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/basic-rules-for-applying-the-gsthst-and-qst/";
const BC_PST_URL = "https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst";
const MB_RST_URL = "https://www.gov.mb.ca/finance/taxation/taxes/retail.html";

async function one<T>(rows: Promise<T[]> | T[], label: string): Promise<T> {
  const [row] = await rows;
  if (!row) throw new Error(`missing ${label}`);
  return row;
}
const jurBySlug = (slug: string) =>
  one(db.select().from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1), `jurisdiction ${slug}`);
const typeBySlug = (slug: string) =>
  one(db.select().from(taxTypes).where(eq(taxTypes.slug, slug)).limit(1), `tax type ${slug}`);
async function evidence(url: string) {
  const src = await one(db.select().from(sources).where(eq(sources.url, url)).limit(1), `source ${url}`);
  if (src.eligibility !== "eligible") throw new Error(`source not eligible: ${url}`);
  const snaps = await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.sourceId, src.id));
  const latest = snaps.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) throw new Error(`no snapshot for ${url}`);
  return { src, snap: latest };
}

type RateItem = {
  jurisdictionSlug: string;
  rateValue: string;
  effectiveFrom: string;
  effectiveTo?: string;
  appliesTo: string;
  conditions?: string;
};

const craCalc = await evidence(CRA_CALC_URL);
const craShort = craCalc.snap.contentHash.slice(0, 8);
const CRA_CITATION = `CRA GST/HST calculator and rates table (snapshot ${craShort}): GST/HST and PST rates by province + GST/HST rates since April 1, 2013`;

// CRA bands (combined GST/HST): [2013-04-01..2016-06-30], [2016-07-01..2016-09-30],
// [2016-10-01..2025-03-31], [2025-04-01..]. Portion = combined - 5.
const hstItems: RateItem[] = [
  { jurisdictionSlug: "ca", rateValue: "5", effectiveFrom: "2013-04-01", appliesTo: "Federal GST component — taxable supplies across Canada (5% in every CRA band since 2013-04-01; GST-only combined rate in AB/YT/NT/NU and non-participating provinces)", conditions: "Earliest-evidenced bound 2013-04-01 (CRA history table start); pre-2013 GST history in CRA GST/HST Statistics Tables — named gap." },
  { jurisdictionSlug: "ca-on", rateValue: "8", effectiveFrom: "2013-04-01", appliesTo: "Ontario provincial portion of HST (CRA combined 13% minus 5% federal GST)" },
  { jurisdictionSlug: "ca-nb", rateValue: "8", effectiveFrom: "2013-04-01", effectiveTo: "2016-09-30", appliesTo: "New Brunswick provincial portion of HST (CRA combined 13% minus 5% federal GST)" },
  { jurisdictionSlug: "ca-nb", rateValue: "10", effectiveFrom: "2016-10-01", appliesTo: "New Brunswick provincial portion of HST (CRA combined 15% minus 5% federal GST)" },
  { jurisdictionSlug: "ca-nl", rateValue: "8", effectiveFrom: "2013-04-01", effectiveTo: "2016-06-30", appliesTo: "Newfoundland and Labrador provincial portion of HST (CRA combined 13% minus 5% federal GST)" },
  { jurisdictionSlug: "ca-nl", rateValue: "10", effectiveFrom: "2016-07-01", appliesTo: "Newfoundland and Labrador provincial portion of HST (CRA combined 15% minus 5% federal GST)" },
  { jurisdictionSlug: "ca-ns", rateValue: "10", effectiveFrom: "2013-04-01", effectiveTo: "2025-03-31", appliesTo: "Nova Scotia provincial portion of HST (CRA combined 15% minus 5% federal GST)" },
  { jurisdictionSlug: "ca-ns", rateValue: "9", effectiveFrom: "2025-04-01", appliesTo: "Nova Scotia provincial portion of HST (CRA combined 14% minus 5% federal GST; CRA: provincial portion decreased to 9% on April 1, 2025)" },
  { jurisdictionSlug: "ca-pe", rateValue: "9", effectiveFrom: "2013-04-01", effectiveTo: "2016-09-30", appliesTo: "Prince Edward Island provincial portion of HST (CRA combined 14% minus 5% federal GST)" },
  { jurisdictionSlug: "ca-pe", rateValue: "10", effectiveFrom: "2016-10-01", appliesTo: "Prince Edward Island provincial portion of HST (CRA combined 15% minus 5% federal GST)" },
];

type Plan = {
  key: string;
  jurisdictionSlug: string;
  taxTypeSlug: string;
  ev: { src: { id: string }; snap: { id: string; contentHash: string } };
  citation: string;
  items: RateItem[];
  determination: string;
};

const rq = await evidence(RQ_BASIC_URL);
const bc = await evidence(BC_PST_URL);
const mb = await evidence(MB_RST_URL);

const PLANS: Plan[] = [
  {
    key: "gst-hst", jurisdictionSlug: "ca", taxTypeSlug: "ca-gst-hst", ev: craCalc,
    citation: CRA_CITATION, items: hstItems,
    determination: "GST 5% federal + HST provincial portions (ON 8; NB 8->10 on 2016-10-01; NL 8->10 on 2016-07-01; NS 10->9 on 2025-04-01; PE 9->10 on 2016-10-01) per CRA rates table bands since 2013-04-01; combined ties 13/15/14/15. History before 2013-04-01 not yet evidenced.",
  },
  {
    key: "qst", jurisdictionSlug: "ca-qc", taxTypeSlug: "ca-qst", ev: rq,
    citation: `Revenu Quebec, Basic rules for applying the GST/HST and QST (snapshot ${rq.snap.contentHash.slice(0, 8)}): QST calculated at 9.975% on the selling price excluding the GST; corroborated by ${CRA_CITATION}`,
    items: [{ jurisdictionSlug: "ca-qc", rateValue: "9.975", effectiveFrom: "2025-04-01", appliesTo: "Quebec sales tax on taxable supplies in Quebec, calculated on the selling price excluding GST (does NOT stack on a GST-inclusive base)", conditions: "Earliest-evidenced bound 2025-04-01 (CRA table modified date; RQ current). Earlier history (9.975% since 2013-01-01 per Quebec harmonization) pending provincial archive evidence — named gap." }],
    determination: "QST 9.975% on GST-excluded base per Revenu Quebec basic rules; combined Quebec burden = 5% GST + 9.975% QST on parallel bases, not a stacked 14.975% on one base for QST computation.",
  },
  {
    key: "bc-pst", jurisdictionSlug: "ca-bc", taxTypeSlug: "ca-bc-pst", ev: bc,
    citation: `B.C. Government PST page (snapshot ${bc.snap.contentHash.slice(0, 8)}): "Generally, the rate of PST is 7% on the purchase or lease price of goods and services, with some exceptions"; corroborated by ${CRA_CITATION}`,
    items: [{ jurisdictionSlug: "ca-bc", rateValue: "7", effectiveFrom: "2025-04-01", appliesTo: "BC provincial sales tax on purchase/lease price of goods and specified services (general rate; exceptions exist)", conditions: "Earliest-evidenced bound 2025-04-01 (CRA table modified date; BC page current). Pre-2025 history pending provincial archive evidence — named gap." }],
    determination: "BC PST general rate 7% (separate from 5% GST; parallel bases).",
  },
  {
    key: "sk-pst", jurisdictionSlug: "ca-sk", taxTypeSlug: "ca-sk-pst", ev: craCalc,
    citation: `${CRA_CITATION} (PST column: Saskatchewan 6%). Saskatchewan PST landing snapshot classifies the tax but states no rate — provincial rate-page evidence is a named refinement.`,
    items: [{ jurisdictionSlug: "ca-sk", rateValue: "6", effectiveFrom: "2025-04-01", appliesTo: "Saskatchewan provincial sales tax (general rate per CRA table; separate from 5% GST)", conditions: "Earliest-evidenced bound 2025-04-01 (CRA table modified date). Earlier history pending provincial archive evidence — named gap." }],
    determination: "SK PST 6% per CRA published PST column; provincial page is the administering authority but its landing snapshot carries no rate text.",
  },
  {
    key: "mb-rst", jurisdictionSlug: "ca-mb", taxTypeSlug: "ca-mb-rst", ev: mb,
    citation: `Manitoba Finance RST page (snapshot ${mb.snap.contentHash.slice(0, 8)}): "The general sales tax rate is 7%"; corroborated by ${CRA_CITATION}`,
    items: [{ jurisdictionSlug: "ca-mb", rateValue: "7", effectiveFrom: "2025-04-01", appliesTo: "Manitoba retail sales tax (general rate; separate from 5% GST)", conditions: "Earliest-evidenced bound 2025-04-01 (CRA table modified date; Manitoba page current). Earlier history (incl. the 8% period) pending provincial archive evidence — named gap." }],
    determination: "Manitoba RST general rate 7% per Manitoba Finance.",
  },
];

const ABSENT = [
  { slug: "ca-ab", text: "confirmed_absent: no Alberta provincial sales tax. CRA rates table lists Alberta PST = 0%; Alberta TRA administers corporate income/fuel/tobacco/tourism levies, no general sales tax in its program pages (snapshot). GST 5% only." },
  { slug: "ca-yt", text: "confirmed_absent: no Yukon territorial sales tax. CRA rates table lists Yukon PST = 0%; Yukon Finance landing snapshot shows no territorial sales tax program. GST 5% only." },
  { slug: "ca-nt", text: "confirmed_absent: no Northwest Territories territorial sales tax. CRA rates table lists NWT PST = 0%; GNWT Finance landing snapshot shows no territorial sales tax program. GST 5% only." },
  { slug: "ca-nu", text: "confirmed_absent: no Nunavut territorial sales tax. CRA rates table lists Nunavut PST = 0% (gov.nu.ca 403s automated reads — no territorial snapshot exists; federal table is the evidence). GST 5% only." },
];

for (const plan of PLANS) {
  const jur = await jurBySlug(plan.jurisdictionSlug);
  const type = await typeBySlug(plan.taxTypeSlug);
  const existing = await db.select().from(proposals)
    .where(eq(proposals.jurisdictionId, jur.id));
  const dup = existing.find((p) => p.taxTypeId === type.id
    && (p.datavalues as Record<string, unknown>)?.m9issue === 48
    && p.status !== "rejected");
  if (dup) { console.log(`EXISTS ${plan.key} proposal=${dup.id} status=${dup.status} — skipping`); continue; }

  const [prop] = await db.insert(proposals).values({
    jurisdictionId: jur.id, taxTypeId: type.id, status: "proposed",
    extractorRunId: runId, datavalues: { m9issue: 48, plan: plan.key },
  }).returning({ id: proposals.id });
  for (const item of plan.items) {
    await db.insert(proposalItems).values({
      proposalId: prop!.id, targetTable: "tax_rates",
      payload: {
        rateValue: item.rateValue, rateUnit: "percent",
        jurisdictionSlug: item.jurisdictionSlug,
        appliesTo: item.appliesTo, conditions: item.conditions ?? null,
        effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo ?? null,
      },
      citation: plan.citation, sourceId: plan.ev.src.id, snapshotId: plan.ev.snap.id, verdict: "pending",
    });
  }
  await db.insert(researchLedger).values({
    jurisdictionId: jur.id, taxTypeId: type.id,
    questionKey: "consumption_tax.rates",
    determination: `Rate(s) proposed ${prop!.id}: ${plan.determination}`,
    status: "pending_review", snapshotHash: plan.ev.snap.contentHash,
  });
  console.log(`PROPOSED ${plan.key} proposal=${prop!.id} items=${plan.items.length}`);
}

const gstType = await typeBySlug("ca-gst-hst");
for (const a of ABSENT) {
  const jur = await jurBySlug(a.slug);
  const existing = await db.select().from(researchLedger)
    .where(eq(researchLedger.jurisdictionId, jur.id));
  if (existing.some((r) => r.questionKey === "provincial_sales_tax.existence")) {
    console.log(`EXISTS absence ledger ${a.slug} — skipping`); continue;
  }
  await db.insert(researchLedger).values({
    jurisdictionId: jur.id, taxTypeId: gstType.id,
    questionKey: "provincial_sales_tax.existence",
    determination: a.text, status: "pending_review",
    snapshotHash: craCalc.snap.contentHash,
  });
  console.log(`ABSENT ${a.slug} ledger recorded`);
}

await client.end();
