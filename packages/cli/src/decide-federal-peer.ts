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
console.log(JSON.stringify({ decided, controls: controlCounts, left, stillUnknown: ["peer_existence.fee", "peer_existence.severance"] }, null, 2));
await client.end();
