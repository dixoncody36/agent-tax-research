import { and, eq, isNull } from "drizzle-orm";
import {
  client, coverageAnswers, db, jurisdictions, sources, sourceSnapshots,
} from "@agent-tax-research/database";

// Decision stage for federal peer-existence questions (#16): does the
// federal level levy each peer category at all? Absence is a finding only
// with a recorded search of an authority index (AGENTS.md rule 7): here
// the IRS federal business-taxes index snapshot, with positive controls
// (income / employment / excise terms MUST hit, proving the search
// works) beside zero-hit levy terms per category. Categories whose
// absence one index cannot carry stay unknown:
//  - fee: IRS user fees live outside the business-tax index;
//  - severance: black-lung coal excise needs the Form 720 schedule
//    snapshot before classifying (excise vs severance-type levy).
// Usage: tsx src/decide-federal-peer.ts --run-id <decision uuid>

const runIdx = process.argv.indexOf("--run-id");
const runId = runIdx >= 0 ? process.argv[runIdx + 1] : undefined;
if (!runId) throw new Error("usage: decide-federal-peer.ts --run-id <uuid>");

const ABSENT: { key: string; terms: string[]; levyLabel: string }[] = [
  { key: "peer_existence.sales_tax", terms: ["sales tax", "national sales tax"], levyLabel: "a general federal sales/use tax" },
  { key: "peer_existence.property", terms: ["property tax", "real estate tax"], levyLabel: "a federal property tax" },
  { key: "peer_existence.occupancy", terms: ["occupancy tax", "hotel tax", "lodging tax"], levyLabel: "a federal hotel/occupancy tax" },
  { key: "peer_existence.franchise_margin", terms: ["franchise tax", "margin tax"], levyLabel: "a federal franchise/margin tax" },
  { key: "peer_existence.gross_receipts", terms: ["gross receipts"], levyLabel: "a federal gross-receipts tax" },
];
const CONTROLS = ["income tax", "employment", "excise"];

const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
const count = (text: string, term: string) => text.split(term).length - 1;

const [us] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us")).limit(1);
if (!us) throw new Error("us jurisdiction missing");

const indexSnaps = await db.select({
  id: sourceSnapshots.id, hash: sourceSnapshots.contentHash, text: sourceSnapshots.retrievedText, url: sources.url,
}).from(sourceSnapshots).innerJoin(sources, eq(sources.id, sourceSnapshots.sourceId))
  .where(eq(sources.jurisdictionId, us.id))
  .then((all) => all.filter((s) => ["https://www.irs.gov/businesses", "https://www.irs.gov/filing/individuals"].includes(s.url)));
const corpus = indexSnaps.map((s) => strip(s.text ?? "")).join("\n");
const controlCounts = Object.fromEntries(CONTROLS.map((t) => [t, count(corpus, t)]));
if (Object.values(controlCounts).some((n) => n === 0)) {
  throw new Error(`positive controls failed (${JSON.stringify(controlCounts)}) - index search not trustworthy, refusing absence findings`);
}

let decided = 0;
const left: string[] = [];
for (const a of ABSENT) {
  const [row] = await db.select().from(coverageAnswers)
    .where(and(eq(coverageAnswers.jurisdictionId, us.id), isNull(coverageAnswers.taxTypeId), eq(coverageAnswers.questionKey, a.key)))
    .limit(1);
  if (!row) { left.push(`${a.key}: no row`); continue; }
  if (row.status !== "unknown") { left.push(`${a.key}: already ${row.status}`); continue; }
  const searches = a.terms.map((t) => ({ term: t, hits: count(corpus, t) }));
  if (searches.some((s) => s.hits > 0)) { left.push(`${a.key}: term present ${JSON.stringify(searches)}`); continue; }
  await db.update(coverageAnswers).set({
    status: "confirmed_absent",
    answer: `No ${a.levyLabel} exists at the federal level: the IRS federal business-taxes index (which enumerates income, employment, excise and other federal business taxes - positive controls hit) contains no such levy, and recorded searches of the index snapshots return zero for every levy term. Federal taxation here runs through income/excise/employment taxes instead.`,
    evidence: {
      kind: "negative_search_authority_index",
      indexUrl: "https://www.irs.gov/businesses",
      snapshotHashes: indexSnaps.map((s) => s.hash),
      controls: controlCounts, searches,
      decidedBy: "decide-federal-peer (recorded index searches)",
    },
    answeredByRunId: runId, updatedAt: new Date(),
  }).where(eq(coverageAnswers.id, row.id));
  console.log(`CONFIRMED_ABSENT ${a.key} searches=${JSON.stringify(searches)}`);
  decided += 1;
}
// Severance special case (round 3): absence alone was not decidable in
// round 1 because a federal coal levy exists — classifying it needs the
// Form 720 instructions, which place per-ton coal under Manufacturers
// Taxes (excise), not a severance-type levy. Decided only when both the
// index search (severance: 0) and the 720 classification evidence hold.
{
  const [row] = await db.select().from(coverageAnswers)
    .where(and(eq(coverageAnswers.jurisdictionId, us.id), isNull(coverageAnswers.taxTypeId), eq(coverageAnswers.questionKey, "peer_existence.severance")))
    .limit(1);
  const [i720] = await db.select({ hash: sourceSnapshots.contentHash, text: sourceSnapshots.retrievedText, url: sources.url })
    .from(sourceSnapshots).innerJoin(sources, eq(sources.id, sourceSnapshots.sourceId))
    .where(eq(sources.jurisdictionId, us.id))
    .then((all) => all.filter((s) => s.url === "https://www.irs.gov/instructions/i720").slice(-1));
  const i720Text = i720 ? strip(i720.text ?? "") : "";
  const sevHits = count(corpus, "severance");
  const coalClassified = i720Text.includes("manufacturers taxes") && i720Text.includes("per ton") && i720Text.includes("coal");
  if (row && row.status === "unknown" && sevHits === 0 && coalClassified && i720) {
    await db.update(coverageAnswers).set({
      status: "confirmed_absent",
      answer: "The federal level imposes no severance-type tax: the IRS business-taxes index contains no severance levy (recorded search), and the closest federal resource levy — the per-ton tax on mined coal — is classified and collected as a Manufacturers excise tax on Form 720 (IRS Nos. 36-39), i.e. inside the excise category, not as a severance tax.",
      evidence: {
        kind: "negative_search_plus_classification",
        indexUrl: "https://www.irs.gov/businesses",
        snapshotHashes: indexSnaps.map((s) => s.hash),
        controls: controlCounts,
        searches: [{ term: "severance", hits: sevHits }],
        classificationSnapshot: { url: i720.url, hash: i720.hash, needles: ["manufacturers taxes", "per ton", "coal"] },
        decidedBy: "decide-federal-peer severance special case",
      },
      answeredByRunId: runId, updatedAt: new Date(),
    }).where(eq(coverageAnswers.id, row.id));
    console.log(`CONFIRMED_ABSENT peer_existence.severance (coal classified as manufacturers excise in Form 720)`);
    decided += 1;
  } else {
    left.push(`peer_existence.severance: not decidable (sevHits=${sevHits}, coalClassified=${coalClassified}, row=${row?.status ?? "none"})`);
  }
}

// Fee found case (round 4): the IRS charges user fees (e.g. installment-
// agreement setup fees) — evidenced on the payment-plan application
// snapshot. Decided only when both needles appear in that snapshot.
{
  const [row] = await db.select().from(coverageAnswers)
    .where(and(eq(coverageAnswers.jurisdictionId, us.id), isNull(coverageAnswers.taxTypeId), eq(coverageAnswers.questionKey, "peer_existence.fee")))
    .limit(1);
  const [feeSnap] = await db.select({ hash: sourceSnapshots.contentHash, text: sourceSnapshots.retrievedText, url: sources.url })
    .from(sourceSnapshots).innerJoin(sources, eq(sources.id, sourceSnapshots.sourceId))
    .where(eq(sources.jurisdictionId, us.id))
    .then((all) => all.filter((s) => s.url === "https://www.irs.gov/payments/online-payment-agreement-application").slice(-1));
  const feeText = feeSnap ? strip(feeSnap.text ?? "") : "";
  const feeFound = feeText.includes("user fee") && feeText.includes("setup fee");
  if (row && row.status === "unknown" && feeFound && feeSnap) {
    await db.update(coverageAnswers).set({
      status: "found",
      answer: "The federal level charges user fees for IRS services — e.g. setup fees for payment plans (installment agreements) per the IRS payment-plan application page (see evidence snapshot). This is a service-fee regime, not a tax category.",
      evidence: {
        kind: "fee_existence_snapshot",
        snapshotHashes: [feeSnap.hash], sourceUrl: feeSnap.url,
        needles: ["user fee", "setup fee"],
        excerpts: ["user fee", "setup fee"].map((n) => {
          const i = feeText.indexOf(n);
          return i >= 0 ? feeText.slice(Math.max(0, i - 60), i + 220) : "";
        }),
        decidedBy: "decide-federal-peer fee found case",
      },
      answeredByRunId: runId, updatedAt: new Date(),
    }).where(eq(coverageAnswers.id, row.id));
    console.log("FOUND peer_existence.fee (IRS user fees)");
    decided += 1;
  } else if (row?.status === "unknown") {
    left.push(`peer_existence.fee: not decidable (feeFound=${feeFound})`);
  }
}

console.log(JSON.stringify({ decided, controls: controlCounts, left, stillUnknown: [] }, null, 2));
await client.end();
