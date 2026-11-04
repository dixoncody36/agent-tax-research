import { eq } from "drizzle-orm";
import {
  client, db, jurisdictions, proposalItems, proposals, researchLedger,
  sources, sourceSnapshots, taxTypes,
} from "@agent-tax-research/database";

// Canada compliance + place-of-supply determinations (issue #49, Decision
// role). Evidence: snapshotted CRA registration + place-of-supply pages,
// Revenu Quebec basic rules, BC PST and Saskatchewan PST pages (#47 fetch).
// effectiveFrom = 2025-04-01 (earliest-evidenced bound, per #48 discipline).
// Known gaps (named, not silent): Manitoba RST registration page, RQ
// registration page, GST/HST filing-frequency table — not yet snapshotted.
// Usage: tsx src/populate-canada-compliance.ts --run-id <decision run uuid>

const runIdx = process.argv.indexOf("--run-id");
const runId = runIdx >= 0 ? process.argv[runIdx + 1] : undefined;
if (!runId) throw new Error("usage: populate-canada-compliance.ts --run-id <uuid>");

const CRA_REGISTER_URL = "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge.html";
const CRA_PLACE_URL = "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html";
const RQ_BASIC_URL = "https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/basic-rules-for-applying-the-gsthst-and-qst/";
const BC_PST_URL = "https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst";
const SK_PST_URL = "https://www.saskatchewan.ca/business/taxes-licensing-and-reporting/provincial-taxes-policies-and-bulletins/provincial-sales-tax";
const BOUND = "2025-04-01";
const BOUND_NOTE = "Earliest-evidenced bound 2025-04-01 (snapshotted guidance); earlier history not evidenced.";

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

type Plan = {
  key: string;
  jurisdictionSlug: string;
  taxTypeSlug: string;
  evUrl: string;
  citation: (hash8: string) => string;
  targetTable: "tax_compliance" | "tax_rules";
  payload: Record<string, unknown>;
  questionKey: string;
  determination: string;
};

const PLANS: Plan[] = [
  {
    key: "gst-hst-registration", jurisdictionSlug: "ca", taxTypeSlug: "ca-gst-hst",
    evUrl: CRA_REGISTER_URL, targetTable: "tax_compliance",
    citation: (h) => `CRA, When to register for and start charging the GST/HST (snapshot ${h}): small-supplier limit calculation — $30,000 over a single calendar quarter or over four consecutive calendar quarters`,
    payload: {
      obligationType: "registration",
      formName: "GST/HST account registration (Business Number, RT program account)",
      formUrl: CRA_REGISTER_URL,
      dueDateRule: "Effective date of registration is no later than the day of the supply that made you exceed $30,000 (single-quarter case), or no later than the first supply after you stop being a small supplier (four-consecutive-quarter case).",
      collectRemitSummary: `A person whose taxable supplies do not exceed the $30,000 small-supplier threshold over four consecutive calendar quarters is a small supplier and does not have to register (voluntary registration is allowed; effective date usually the request day or up to 30 days earlier). Exceeding $30,000 in a single calendar quarter ends small-supplier status immediately — GST/HST must be charged on the exceeding supply itself. Exceeding over the previous four (or fewer) consecutive quarters ends status at the end of the month following that quarter. Non-resident and other special cases exist. ${BOUND_NOTE}`,
      effectiveFrom: BOUND,
    },
    questionKey: "consumption_tax.registration",
    determination: "GST/HST registration obligation: $30,000 CAD small-supplier threshold (single-quarter and four-consecutive-quarter tests) per CRA; registration effective dates as published.",
  },
  {
    key: "place-of-supply-goods", jurisdictionSlug: "ca", taxTypeSlug: "ca-gst-hst",
    evUrl: CRA_PLACE_URL, targetTable: "tax_rules",
    citation: (h) => `CRA, GST/HST place of supply rules (snapshot ${h}): goods delivered or made available to the recipient determine the province; mail/courier and carriage-contract destinations govern`,
    payload: {
      ruleType: "place_of_supply", authorityLevel: "guidance",
      title: "Place of supply — goods (tangible personal property)",
      summary: `For goods, the place of supply is the province in which the goods are delivered or made available to the recipient: if the supplier mails or couriers the goods, the province they are sent to; if shipped to a destination specified in the contract for carriage (including via a carrier retained on the recipient's behalf), that destination province; if never delivered, the province where delivery was to occur under the agreement. The GST/HST rate follows the place-of-supply province — e.g., a B.C. store delivering into Ontario charges 13% HST. Services, intangible property and real-property branches are separate rules (same CRA guidance; to be determined in a follow-on pass). ${BOUND_NOTE}`,
      effectiveFrom: BOUND,
    },
    questionKey: "consumption_tax.place_of_supply",
    determination: "Place of supply for goods = delivery/made-available province (mail/courier/carriage-contract destination); GST/HST rate follows that province. Goods branch only.",
  },
  {
    key: "qst-base", jurisdictionSlug: "ca-qc", taxTypeSlug: "ca-qst",
    evUrl: RQ_BASIC_URL, targetTable: "tax_rules",
    citation: (h) => `Revenu Quebec, Basic rules for applying the GST/HST and QST (snapshot ${h}): "the Québec sales tax (QST), which is calculated at a rate of 9.975% on the selling price excluding the GST"`,
    payload: {
      ruleType: "tax_base", authorityLevel: "guidance",
      title: "QST base excludes GST",
      summary: `QST is calculated at 9.975% on the selling price excluding the GST. GST (5%) and QST (9.975%) therefore apply in parallel on the same pre-tax price; QST is never computed on a GST-inclusive amount. Rate-stack consumers must not sum QST onto a GST-inclusive base. ${BOUND_NOTE}`,
      effectiveFrom: BOUND,
    },
    questionKey: "qst.base",
    determination: "QST base = selling price excluding GST (parallel bases with GST).",
  },
  {
    key: "bc-pst-registration", jurisdictionSlug: "ca-bc", taxTypeSlug: "ca-bc-pst",
    evUrl: BC_PST_URL, targetTable: "tax_compliance",
    citation: (h) => `B.C. Government PST page (snapshot ${h}): find out if your business is required to register to collect PST — if required, you must charge and collect PST and report/remit it`,
    payload: {
      obligationType: "registration",
      formName: "PST account registration (British Columbia)",
      formUrl: BC_PST_URL,
      collectRemitSummary: `A business required to register to collect BC PST must register for a PST account, charge and collect PST, and report and remit the tax collected (including PST owed on items the business itself uses). ${BOUND_NOTE}`,
      effectiveFrom: BOUND,
    },
    questionKey: "consumption_tax.registration",
    determination: "BC PST: registration-to-collect obligation with report/remit duties per B.C. Government PST guidance.",
  },
  {
    key: "sk-pst-registration", jurisdictionSlug: "ca-sk", taxTypeSlug: "ca-sk-pst",
    evUrl: SK_PST_URL, targetTable: "tax_compliance",
    citation: (h) => `Government of Saskatchewan PST page (snapshot ${h}): "All businesses operating in Saskatchewan must be licensed or registered with the Ministry of Finance for PST purposes" (vendor's licence or registered consumer number); unlicensed-supplier purchases must be self-assessed to the Revenue Division`,
    payload: {
      obligationType: "registration",
      formName: "PST vendor's licence / registered consumer number (Saskatchewan Ministry of Finance)",
      formUrl: SK_PST_URL,
      collectRemitSummary: `All businesses operating in Saskatchewan must be licensed or registered with the Ministry of Finance for PST purposes, receiving either a vendor's licence number or a registered consumer number depending on the business. Purchasers from unlicensed suppliers (e.g., out-of-province) must self-assess and pay PST directly to the Revenue Division. ${BOUND_NOTE}`,
      effectiveFrom: BOUND,
    },
    questionKey: "consumption_tax.registration",
    determination: "SK PST: universal licence/registration obligation for businesses operating in Saskatchewan; self-assessment on unlicensed-supplier purchases.",
  },
];

for (const plan of PLANS) {
  const jur = await jurBySlug(plan.jurisdictionSlug);
  const type = await typeBySlug(plan.taxTypeSlug);
  const ev = await evidence(plan.evUrl);
  const existing = await db.select().from(proposals).where(eq(proposals.jurisdictionId, jur.id));
  const dup = existing.find((p) => p.taxTypeId === type.id
    && (p.datavalues as Record<string, unknown>)?.m9issue === 49
    && (p.datavalues as Record<string, unknown>)?.plan === plan.key
    && p.status !== "rejected");
  if (dup) { console.log(`EXISTS ${plan.key} proposal=${dup.id} status=${dup.status} — skipping`); continue; }

  const [prop] = await db.insert(proposals).values({
    jurisdictionId: jur.id, taxTypeId: type.id, status: "proposed",
    extractorRunId: runId, datavalues: { m9issue: 49, plan: plan.key },
  }).returning({ id: proposals.id });
  await db.insert(proposalItems).values({
    proposalId: prop!.id, targetTable: plan.targetTable, payload: plan.payload,
    citation: plan.citation(ev.snap.contentHash.slice(0, 8)),
    sourceId: ev.src.id, snapshotId: ev.snap.id, verdict: "pending",
  });
  await db.insert(researchLedger).values({
    jurisdictionId: jur.id, taxTypeId: type.id, questionKey: plan.questionKey,
    determination: `Determination proposed ${prop!.id}: ${plan.determination}`,
    status: "pending_review", snapshotHash: ev.snap.contentHash,
  });
  console.log(`PROPOSED ${plan.key} proposal=${prop!.id} target=${plan.targetTable}`);
}

await client.end();
