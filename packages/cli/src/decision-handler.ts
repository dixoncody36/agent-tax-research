import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  coverageAnswers, coverageQuestions, db, proposalItems, proposals, researchLedger, sourceSnapshots, sources,
} from "@agent-tax-research/database";
import { snapshotWindow, verbatimIn } from "./evidence.js";
import { extractJsonObject } from "./muse-loop-lib.js";
import { HandlerError, registerHandler, type HandlerContext } from "./worker.js";

// Headless Decision role (agents/decision.md) for coverage questions: the
// model proposes answers from stored snapshots only; code disposes. A
// `found` survives only with an excerpt found verbatim in the cited
// snapshot, and everything lands as a proposal for an independent Reviewer
// and then a human. Never confirmed_absent: absence needs recorded negative
// searches, which a snapshot read cannot supply (AGENTS.md rule 7).

const BATCH = 12;
const MAX_SNAPSHOTS = 6;
const WINDOW_BUDGET = 60_000;
const OPEN_PROPOSAL_STATUSES = ["proposed", "verified", "approved"];

export type Question = { questionKey: string; question: string };
export type Evidence = { label: string; snapshotId: string; contentHash: string; sourceId: string; sourceName: string; url: string; text: string };
export type Determination = { questionKey: string; answer: string; excerpt: string; evidence: Evidence };

export function buildDecisionPrompt(jurisdiction: string, taxType: string | null, questions: Question[], evidence: Evidence[], contextPacks: unknown[]): string {
  const per = Math.floor(WINDOW_BUDGET / Math.max(1, evidence.length));
  return [
    "You are the Decision agent. Answer coverage questions for a tax jurisdiction using ONLY the government source snapshots below.",
    `Jurisdiction: ${jurisdiction}${taxType ? `; tax type: ${taxType}` : ""}.`,
    "For each question reply status \"found\" only when a snapshot states the answer; otherwise \"unknown\". Never guess, never use outside knowledge, never answer \"absent\".",
    "A found answer must cite one snapshot label and an excerpt copied VERBATIM from it (a full sentence or clause containing the fact). Answers whose excerpt is not in the cited snapshot are discarded.",
    'Reply with ONLY a JSON object: {"answers": [{"questionKey": "...", "status": "found"|"unknown", "answer": "...", "snapshot": "S1", "excerpt": "..."}]}',
    ...(contextPacks.length ? ["", "Local-expert context (GUIDANCE ONLY — never evidence; if it conflicts with a snapshot, answer from the snapshot):", JSON.stringify(contextPacks).slice(0, 4000)] : []),
    "", "Questions:",
    ...questions.map((q) => `- ${q.questionKey}: ${q.question}`),
    "", "Snapshots:",
    ...evidence.map((e) => `=== ${e.label} — ${e.sourceName} (${e.url})\n${snapshotWindow(e.text, per)}`),
  ].join("\n");
}

/** The code gate: only verbatim-backed found answers for questions that were asked survive. */
export function gateAnswers(raw: Record<string, unknown> | null, asked: Question[], evidence: Evidence[]) {
  const askedKeys = new Set(asked.map((q) => q.questionKey));
  const byLabel = new Map(evidence.map((e) => [e.label, e]));
  const found: Determination[] = [];
  let downgraded = 0;
  const seen = new Set<string>();
  for (const a of Array.isArray(raw?.answers) ? (raw.answers as unknown[]) : []) {
    const o = (a ?? {}) as Record<string, unknown>;
    const key = typeof o.questionKey === "string" ? o.questionKey : "";
    if (!askedKeys.has(key) || seen.has(key) || o.status !== "found") continue;
    seen.add(key);
    const ev = byLabel.get(String(o.snapshot ?? ""));
    if (!ev || typeof o.answer !== "string" || !o.answer.trim() || !verbatimIn(o.excerpt, ev.text)) { downgraded += 1; continue; }
    found.push({ questionKey: key, answer: o.answer.trim(), excerpt: String(o.excerpt).trim(), evidence: ev });
  }
  return { found, downgraded };
}

export async function decideCoverage(ctx: HandlerContext) {
  const { run, envelope } = ctx;
  if (!run.jurisdictionId) throw new HandlerError("structure_unknown", "decision assignment has no jurisdiction");
  const jurisdictionId = run.jurisdictionId;
  const sameTaxType = run.taxTypeId ? eq(coverageAnswers.taxTypeId, run.taxTypeId) : undefined;
  const open = await db.select().from(coverageAnswers)
    .where(and(eq(coverageAnswers.jurisdictionId, jurisdictionId), eq(coverageAnswers.status, "unknown"), sameTaxType));
  if (open.length === 0) {
    return { notes: `No unknown coverage questions for ${envelope.jurisdiction}${envelope.taxType ? `/${envelope.taxType}` : ""} (run tax coverage open to seed them).`, datavalues: { decided: 0 } };
  }

  const srcRows = await db.select().from(sources).where(and(
    eq(sources.jurisdictionId, jurisdictionId), eq(sources.eligibility, "eligible"), eq(sources.status, "active"),
    run.taxTypeId ? or(eq(sources.taxTypeId, run.taxTypeId), isNull(sources.taxTypeId)) : undefined,
  ));
  // Check-first: validated determinations still pinned to a current source hash are reused, not re-asked.
  const currentHashes = srcRows.map((s) => s.contentHash).filter((h): h is string => Boolean(h));
  const validated = currentHashes.length === 0 ? [] : await db.select({ questionKey: researchLedger.questionKey }).from(researchLedger).where(and(
    eq(researchLedger.jurisdictionId, jurisdictionId), eq(researchLedger.status, "validated"), inArray(researchLedger.snapshotHash, currentHashes),
    run.taxTypeId ? eq(researchLedger.taxTypeId, run.taxTypeId) : undefined,
  ));
  // Idempotency: a question already in an open proposal is not asked again (a killed run resumes cleanly).
  // A reviewer-failed item does not block: the question may be reconsidered on better evidence.
  const pending = await db.select({ questionKey: sql<string>`${proposalItems.payload}->>'questionKey'` }).from(proposalItems)
    .innerJoin(proposals, eq(proposals.id, proposalItems.proposalId))
    .where(and(
      eq(proposals.jurisdictionId, jurisdictionId), inArray(proposals.status, OPEN_PROPOSAL_STATUSES), eq(proposalItems.targetTable, "coverage_answers"),
      ne(proposalItems.verdict, "fail"), run.taxTypeId ? eq(proposals.taxTypeId, run.taxTypeId) : isNull(proposals.taxTypeId),
    ));
  const validatedKeys = new Set(validated.map((v) => v.questionKey));
  const skip = new Set([...validatedKeys, ...pending.map((p) => p.questionKey)]);
  // Validated in the ledger yet still unknown in coverage: a publish gap a human must close, not a question to re-ask.
  const publishGap = open.filter((o) => validatedKeys.has(o.questionKey)).map((o) => o.questionKey);
  const todo = open.filter((o) => !skip.has(o.questionKey));
  if (todo.length === 0) {
    return {
      notes: [
        `All ${open.length} unknown questions are already validated against current sources or awaiting review; nothing re-asked.`,
        publishGap.length ? `Publish gap: ${publishGap.join(", ")} validated in the ledger but coverage still unknown; needs a coverage proposal or human action.` : "",
      ].filter(Boolean).join(" "),
      datavalues: { decided: 0, skipped: open.length, publishGap },
    };
  }

  const all: Omit<Evidence, "label">[] = [];
  for (const s of srcRows) {
    const [snap] = await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.sourceId, s.id)).orderBy(desc(sourceSnapshots.createdAt)).limit(1);
    if (snap?.retrievedText) all.push({ snapshotId: snap.id, contentHash: snap.contentHash, sourceId: s.id, sourceName: s.name, url: s.url, text: snap.retrievedText });
  }
  // Every snapshot is read, in groups that fit the prompt window; questions answered by an earlier group are not re-asked.
  const groups: Evidence[][] = [];
  for (let i = 0; i < all.length; i += MAX_SNAPSHOTS) groups.push(all.slice(i, i + MAX_SNAPSHOTS).map((e, k) => ({ ...e, label: `S${k + 1}` })));
  const evidence = groups.flat();
  if (evidence.length === 0) {
    throw new HandlerError("primary_not_found", `no snapshots for ${envelope.jurisdiction}${envelope.taxType ? `/${envelope.taxType}` : ""}; run a fetch assignment first`);
  }

  const qtext = new Map((await db.select().from(coverageQuestions)).map((q) => [q.questionKey, q.question]));
  const questions: Question[] = todo.map((o) => ({
    questionKey: o.questionKey,
    question: qtext.get(o.questionKey)
      ?? (o.questionKey.startsWith("peer_existence.") ? `Does this jurisdiction impose a ${o.questionKey.slice("peer_existence.".length).replace(/_/g, " ")} levy (under any name)?` : o.questionKey),
  }));

  const found: Determination[] = [];
  let downgraded = 0;
  for (const group of groups) {
    const answered = new Set(found.map((f) => f.questionKey));
    const remaining = questions.filter((q) => !answered.has(q.questionKey));
    for (let i = 0; i < remaining.length; i += BATCH) {
      const batch = remaining.slice(i, i + BATCH);
      const r = await ctx.call(buildDecisionPrompt(envelope.jurisdiction ?? "?", envelope.taxType, batch, group, envelope.contextPacks));
      const g = gateAnswers(extractJsonObject(r.content), batch, group);
      found.push(...g.found);
      downgraded += g.downgraded;
    }
  }

  let proposalId: string | null = null;
  if (found.length > 0) {
    proposalId = await db.transaction(async (tx) => {
      const [p] = await tx.insert(proposals).values({
        scopeRunId: run.scopeRunId, jurisdictionId, taxTypeId: run.taxTypeId, extractorRunId: run.id, status: "proposed",
        datavalues: { author: "tax-worker decision", spec: `${ctx.spec.provider}:${ctx.spec.model}` },
      }).returning({ id: proposals.id });
      await tx.insert(proposalItems).values(found.map((f) => ({
        proposalId: p!.id, targetTable: "coverage_answers",
        payload: { questionKey: f.questionKey, status: "found", answer: f.answer, excerpt: f.excerpt, snapshotHash: f.evidence.contentHash },
        citation: `${f.evidence.sourceName} (${f.evidence.url}), snapshot ${f.evidence.contentHash.slice(0, 12)}`,
        sourceId: f.evidence.sourceId, snapshotId: f.evidence.snapshotId, verdict: "pending",
      })));
      await tx.insert(researchLedger).values(found.map((f) => ({
        jurisdictionId, taxTypeId: run.taxTypeId, questionKey: f.questionKey, determination: f.answer,
        status: "pending_review", snapshotHash: f.evidence.contentHash, datavalues: { proposalId: p!.id, decisionRunId: run.id },
      })));
      return p!.id;
    });
    await ctx.event("proposal_filed", { proposalId, items: found.length });
  }

  const notes = [
    `Decision over ${questions.length} unknown questions (${skip.size} skipped: validated or already in review) from ${evidence.length} snapshots.`,
    found.length ? `Filed proposal ${proposalId} with ${found.length} found answers, each backed by a verbatim excerpt; awaiting an independent Reviewer run, then a human.` : "No question could be answered from the snapshots.",
    downgraded ? `${downgraded} model answers were downgraded to unknown (excerpt not verbatim in the cited snapshot): treat this model's citations with care.` : "",
    `${questions.length - found.length} questions remain unknown and need deeper primary sources.`,
    publishGap.length ? `Publish gap: ${publishGap.join(", ")} validated in the ledger but coverage still unknown; needs a coverage proposal or human action.` : "",
  ].filter(Boolean).join(" ");
  return { notes, datavalues: { decided: found.length, downgraded, proposalId, publishGap, snapshots: evidence.map((e) => e.contentHash) } };
}

registerHandler("decision", "*", decideCoverage);
