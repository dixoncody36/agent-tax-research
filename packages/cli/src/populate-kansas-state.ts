import { eq } from "drizzle-orm";
import {
  client, db, jurisdictions, proposalItems, proposals, researchLedger,
  sources, sourceSnapshots, taxTypes,
} from "@agent-tax-research/database";

// Kansas state-level rate determinations (issue #54, Decision role).
// Evidence: snapshotted KDOR hub pages from #53 only. Two taxes state a
// rate in HTML (sales 6.5% eff. 2015-07-01; tobacco products 10% of
// wholesale). The rest publish rates via PDFs/forms — recorded as named
// unknowns in the ledger (silence is unknown, never confirmed_absent).
// State food rate (0%) rides #55 with the Publication 1700 snapshot.
// Usage: tsx src/populate-kansas-state.ts --run-id <decision run uuid>

const runIdx = process.argv.indexOf("--run-id");
const runId = runIdx >= 0 ? process.argv[runIdx + 1] : undefined;
if (!runId) throw new Error("usage: populate-kansas-state.ts --run-id <uuid>");

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

const ks = await jurBySlug("us-ks");

type Plan = {
  key: string; taxTypeSlug: string; evUrl: string; citation: string;
  item: { rateValue: string; rateUnit: string; appliesTo: string; conditions?: string; effectiveFrom: string };
  determination: string;
};

const salesEv = await evidence("https://www.ksrevenue.gov/bustaxtypessales.html");
const cigEv = await evidence("https://www.ksrevenue.gov/bustaxtypescig.html");

const PLANS: (Plan & { ev: Awaited<ReturnType<typeof evidence>> })[] = [
  {
    key: "state-sales", taxTypeSlug: "us-ks-sales-use",
    evUrl: "https://www.ksrevenue.gov/bustaxtypessales.html", ev: salesEv,
    citation: `KDOR Sales and Use Tax hub (snapshot ${salesEv.snap.contentHash.slice(0, 8)}): "Kansas imposes a 6.5 percent (effective July 1, 2015) state retailers' sales tax, plus applicable local taxes"`,
    item: {
      rateValue: "6.5", rateUnit: "percent", effectiveFrom: "2015-07-01",
      appliesTo: "State retailers' sales tax component (general statewide rate; local county/city/special components attach per jurisdiction)",
      conditions: "General rate. State rate on qualified food items is separately reduced (Publication 1700 state-food column; item lands with #55). Pre-2015 state history not stated on snapshotted pages — named gap.",
    },
    determination: "Kansas state sales/use general rate 6.5% effective 2015-07-01 per KDOR. Locals cascade separately (#55); food-rate treatment rides Pub 1700 (#55).",
  },
  {
    key: "tobacco-otp", taxTypeSlug: "us-ks-tobacco",
    evUrl: "https://www.ksrevenue.gov/bustaxtypescig.html", ev: cigEv,
    citation: `KDOR Cigarette and Tobacco Products hub (snapshot ${cigEv.snap.contentHash.slice(0, 8)}): tobacco products tax "at the rate of ten percent (10%) of the wholesale sales price" imposed on distributors`,
    item: {
      rateValue: "10", rateUnit: "percent", effectiveFrom: "2026-11-02",
      appliesTo: "Tobacco products (other than cigarettes) — distributor-level tax on wholesale sales price",
      conditions: "Earliest-evidenced bound = snapshot date (page states no from-date). Cigarette per-pack stamp rate is published via KDOR PDF forms (CG-117), not the snapshotted HTML — named gap.",
    },
    determination: "Kansas tobacco products tax 10% of wholesale sales price (distributor level) per KDOR. Cigarette per-pack rate unknown from HTML evidence.",
  },
];

for (const plan of PLANS) {
  const type = await typeBySlug(plan.taxTypeSlug);
  const existing = await db.select().from(proposals).where(eq(proposals.jurisdictionId, ks.id));
  const dup = existing.find((p) => p.taxTypeId === type.id
    && (p.datavalues as Record<string, unknown>)?.m10issue === 54
    && (p.datavalues as Record<string, unknown>)?.plan === plan.key
    && p.status !== "rejected");
  if (dup) { console.log(`EXISTS ${plan.key} proposal=${dup.id} status=${dup.status} — skipping`); continue; }
  const [prop] = await db.insert(proposals).values({
    jurisdictionId: ks.id, taxTypeId: type.id, status: "proposed",
    extractorRunId: runId, datavalues: { m10issue: 54, plan: plan.key },
  }).returning({ id: proposals.id });
  await db.insert(proposalItems).values({
    proposalId: prop!.id, targetTable: "tax_rates",
    payload: {
      rateValue: plan.item.rateValue, rateUnit: plan.item.rateUnit,
      jurisdictionSlug: "us-ks", appliesTo: plan.item.appliesTo,
      conditions: plan.item.conditions ?? null,
      effectiveFrom: plan.item.effectiveFrom, effectiveTo: null,
    },
    citation: plan.citation, sourceId: plan.ev.src.id, snapshotId: plan.ev.snap.id, verdict: "pending",
  });
  await db.insert(researchLedger).values({
    jurisdictionId: ks.id, taxTypeId: type.id, questionKey: "state_rate",
    determination: `Rate proposed ${prop!.id}: ${plan.determination}`,
    status: "pending_review", snapshotHash: plan.ev.snap.contentHash,
  });
  console.log(`PROPOSED ${plan.key} proposal=${prop!.id}`);
}

const UNKNOWNS: { taxTypeSlug: string; evUrl: string; text: string }[] = [
  {
    taxTypeSlug: "us-ks-income-corporate", evUrl: "https://www.ksrevenue.gov/bustaxtypescorp.html",
    text: "unknown: corporate income tax rate(s) not stated on the snapshotted KDOR hub HTML (rates publish via forms/instructions PDFs). Tax exists; rate determination pending a PDF-capable fetch. Do not reuse as fact.",
  },
  {
    taxTypeSlug: "us-ks-income-individual", evUrl: "https://www.ksrevenue.gov/perstaxtypes.html",
    text: "unknown: individual income tax rate/brackets not stated on the snapshotted KDOR hub HTML. Tax exists; rate determination pending instruction-booklet evidence. Do not reuse as fact.",
  },
  {
    taxTypeSlug: "us-ks-motor-fuels", evUrl: "https://www.ksrevenue.gov/bustaxtypesmf.html",
    text: "unknown: per-gallon motor fuel rates publish in KDOR PDF rate sheets (mffueltaxrates links historical PDFs), not snapshotted HTML. Tax exists; rates pending PDF evidence. Do not reuse as fact.",
  },
  {
    taxTypeSlug: "us-ks-property", evUrl: "https://www.ksrevenue.gov/pvdindex.html",
    text: "unknown: statewide mill levy amounts not stated on the snapshotted PVD hub. Local mill-levy depth is out of M10 scope. Do not reuse as fact.",
  },
];

for (const u of UNKNOWNS) {
  const type = await typeBySlug(u.taxTypeSlug);
  const ev = await evidence(u.evUrl);
  const existing = await db.select().from(researchLedger)
    .where(eq(researchLedger.jurisdictionId, ks.id));
  if (existing.some((r) => r.taxTypeId === type.id && r.questionKey === "state_rate")) {
    console.log(`EXISTS ledger ${u.taxTypeSlug} — skipping`); continue;
  }
  await db.insert(researchLedger).values({
    jurisdictionId: ks.id, taxTypeId: type.id, questionKey: "state_rate",
    determination: u.text, status: "pending_review", snapshotHash: ev.snap.contentHash,
  });
  console.log(`UNKNOWN recorded ${u.taxTypeSlug}`);
}

await client.end();
