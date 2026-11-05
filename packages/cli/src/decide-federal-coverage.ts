import { and, eq } from "drizzle-orm";
import {
  client, coverageAnswers, db, jurisdictions, sources, sourceSnapshots, taxTypes,
} from "@agent-tax-research/database";

// Decision stage for the federal coverage pack (#16, scope 88779585).
// Deterministic determinations FROM SNAPSHOT EVIDENCE ONLY: a coverage
// question flips unknown -> found solely when every needle for its rule
// is present in the cited snapshot's retrieved text; the stored answer
// carries the matched excerpt + snapshot hash so a Reviewer can
// re-perform without trusting this run. Questions without direct
// snapshot support stay unknown (never guessed). Peer-existence rows are
// NOT decided here: one index snapshot cannot carry seven absence
// findings — each needs its own recorded search (COVERAGE-ABSENCE).
// Usage: tsx src/decide-federal-coverage.ts --run-id <decision agent_run uuid>

const runIdx = process.argv.indexOf("--run-id");
const runId = runIdx >= 0 ? process.argv[runIdx + 1] : undefined;
if (!runId) throw new Error("usage: decide-federal-coverage.ts --run-id <uuid>");

type Rule = {
  taxTypeSlug: string;
  questionKey: string;
  sourceUrlIncludes: string;
  needles: string[];
  answer: string;
};

const RULES: Rule[] = [
  {
    taxTypeSlug: "us-federal-income-individual", questionKey: "levy_exists",
    sourceUrlIncludes: "rates-and-brackets", needles: ["federal income tax"],
    answer: "The United States imposes a federal personal income tax; the IRS publishes federal income tax brackets and rates by filing status (see excerpt).",
  },
  {
    taxTypeSlug: "us-federal-income-individual", questionKey: "rates_brackets",
    sourceUrlIncludes: "rates-and-brackets", needles: ["tax brackets", "37%"],
    answer: "Federal individual rates are graduated brackets topping at 37% for the current published year on this page; exact per-status thresholds are in the cited snapshot tables (historical years not evidenced here — separate gap).",
  },
  {
    taxTypeSlug: "us-federal-income-corporate", questionKey: "levy_exists",
    sourceUrlIncludes: "/businesses/corporations", needles: ["corporation"],
    answer: "The United States imposes a federal corporate income tax administered by the IRS (corporations hub, see excerpt).",
  },
  {
    taxTypeSlug: "us-federal-income-corporate", questionKey: "filing",
    sourceUrlIncludes: "/businesses/corporations", needles: ["1120"],
    answer: "Corporations file federal income tax on the Form 1120 series per the IRS corporations hub (see excerpt); due-date/extension detail beyond the excerpt is not determined in this pass.",
  },
  {
    taxTypeSlug: "us-federal-excise", questionKey: "levy_exists",
    sourceUrlIncludes: "excise-tax", needles: ["excise tax"],
    answer: "The United States imposes federal excise taxes administered by the IRS (excise hub, see excerpt).",
  },
  {
    taxTypeSlug: "us-federal-excise", questionKey: "filing",
    sourceUrlIncludes: "excise-tax", needles: ["Form 720"],
    answer: "Federal excise taxes are reported on Form 720 (Quarterly Federal Excise Tax Return) per the IRS excise hub (see excerpt); per-schedule cadence detail beyond the excerpt is not determined in this pass.",
  },
];

const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
function excerptAround(text: string, needle: string, span = 220): string | null {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return null;
  return text.slice(Math.max(0, i - 60), i + span).trim();
}

const [us] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us")).limit(1);
if (!us) throw new Error("us jurisdiction missing");

let decided = 0;
const skipped: string[] = [];
for (const rule of RULES) {
  const key = `${rule.taxTypeSlug}/${rule.questionKey}`;
  const [tt] = await db.select().from(taxTypes).where(eq(taxTypes.slug, rule.taxTypeSlug)).limit(1);
  if (!tt) { skipped.push(`${key}: tax type missing`); continue; }
  const [row] = await db.select().from(coverageAnswers)
    .where(and(eq(coverageAnswers.jurisdictionId, us.id), eq(coverageAnswers.taxTypeId, tt.id), eq(coverageAnswers.questionKey, rule.questionKey)))
    .limit(1);
  if (!row) { skipped.push(`${key}: no coverage row`); continue; }
  if (row.status !== "unknown") { skipped.push(`${key}: already ${row.status}`); continue; }
  const [src] = await db.select().from(sources)
    .where(and(eq(sources.jurisdictionId, us.id), eq(sources.taxTypeId, tt.id)))
    .then((all) => all.filter((s) => s.url.includes(rule.sourceUrlIncludes)).slice(0, 1));
  if (!src) { skipped.push(`${key}: source not found`); continue; }
  const [snap] = await db.select().from(sourceSnapshots)
    .where(eq(sourceSnapshots.sourceId, src.id))
    .orderBy(sourceSnapshots.createdAt)
    .then((all) => all.slice(-1));
  if (!snap?.retrievedText) { skipped.push(`${key}: no snapshot text`); continue; }
  const text = strip(snap.retrievedText);
  const excerpts = rule.needles.map((n) => excerptAround(text, n));
  if (excerpts.some((e) => e === null)) {
    skipped.push(`${key}: needles not all present in snapshot ${snap.contentHash.slice(0, 12)}`);
    continue;
  }
  await db.update(coverageAnswers).set({
    status: "found",
    answer: rule.answer,
    evidence: {
      snapshotHash: snap.contentHash, snapshotId: snap.id, sourceUrl: src.url,
      needles: rule.needles, excerpts, decidedBy: "decide-federal-coverage (deterministic, snapshot-only)",
    },
    answeredByRunId: runId, updatedAt: new Date(),
  }).where(eq(coverageAnswers.id, row.id));
  console.log(`FOUND ${key} via ${src.url} @${snap.contentHash.slice(0, 12)}`);
  decided += 1;
}

console.log(JSON.stringify({ decided, skipped }, null, 2));
await client.end();
