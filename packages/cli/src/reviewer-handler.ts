import { and, eq, inArray, isNull } from "drizzle-orm";
import { agentRuns, db, exceptions, proposalItems, proposals, sourceSnapshots, sources } from "@agent-tax-research/database";
import { normalizeForMatch, verbatimIn } from "./evidence.js";
import { extractJsonObject } from "./muse-loop-lib.js";
import { HandlerError, registerHandler, type HandlerContext } from "./worker.js";

// Headless Reviewer role (agents/reviewer.md): an independent run re-reads
// the cited snapshot for every item of a Decision proposal. Code re-checks
// the evidence first (hash pinned, excerpt verbatim) and that check cannot be
// overruled by the model. The reviewer verifies; it never approves or
// publishes, and it never rescues an item with new evidence.

const BATCH = 10;
const PASSAGE = 8_000;

type Item = typeof proposalItems.$inferSelect;
export type ReviewClaim = { label: string; item: Item; passage: string; codeFail: string | null };
export type Verdict = { verdict: "pass" | "fail" | "conflict"; reason: string };

/** The snapshot around the cited excerpt, so the model reads the source in context. */
export function passageAround(text: string, excerpt: string, width = PASSAGE): string {
  const at = normalizeForMatch(text).indexOf(normalizeForMatch(excerpt));
  if (at < 0 || text.length <= width) return text.slice(0, width);
  // Normalized offsets track the original closely (snapshot text is already whitespace-collapsed).
  const start = Math.max(0, Math.min(at - Math.floor(width / 2), text.length - width));
  return `…${text.slice(start, start + width)}…`;
}

/** Evidence checks the model cannot overrule. Null = evidence holds. */
export function codeCheck(item: Item, snapshot: { contentHash: string; retrievedText: string | null } | undefined, eligible: boolean): string | null {
  const p = item.payload as Record<string, unknown>;
  if (!eligible) return "cited source is missing or not eligible";
  if (!snapshot?.retrievedText) return "cited snapshot is missing";
  if (p.snapshotHash !== snapshot.contentHash) return "snapshot hash does not match the hash the determination was made against";
  if (!verbatimIn(p.excerpt, snapshot.retrievedText)) return "excerpt is not verbatim in the cited snapshot";
  return null;
}

export function buildReviewPrompt(claims: ReviewClaim[]): string {
  return [
    "You are the Reviewer agent: an independent second reader. You did NOT write these determinations.",
    "For each claim, read the government source passage and decide whether it supports the answer exactly.",
    "pass = the passage states this answer; fail = it does not, or the answer overstates it; conflict = the passage contradicts itself or another claim.",
    'Reply with ONLY a JSON object: {"verdicts": [{"claim": "C1", "verdict": "pass"|"fail"|"conflict", "reason": "<one line>"}]}',
    "",
    ...claims.map((c) => {
      const p = c.item.payload as Record<string, unknown>;
      return `=== ${c.label}\nQuestion: ${String(p.questionKey)}\nClaimed answer: ${String(p.answer)}\nCited excerpt: "${String(p.excerpt)}"\nSource passage:\n${c.passage}`;
    }),
  ].join("\n");
}

export function parseVerdicts(raw: Record<string, unknown> | null, claims: ReviewClaim[]): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  for (const v of Array.isArray(raw?.verdicts) ? (raw.verdicts as unknown[]) : []) {
    const o = (v ?? {}) as Record<string, unknown>;
    const label = String(o.claim ?? "");
    if (!claims.some((c) => c.label === label) || out.has(label)) continue;
    const verdict = o.verdict === "pass" || o.verdict === "conflict" ? o.verdict : "fail";
    out.set(label, { verdict, reason: typeof o.reason === "string" ? o.reason.slice(0, 300) : "" });
  }
  return out;
}

export async function reviewProposals(ctx: HandlerContext) {
  const { run, envelope } = ctx;
  if (!run.jurisdictionId) throw new HandlerError("structure_unknown", "reviewer assignment has no jurisdiction");
  const candidates = await db.select().from(proposals).where(and(
    eq(proposals.jurisdictionId, run.jurisdictionId), eq(proposals.status, "proposed"),
    run.taxTypeId ? eq(proposals.taxTypeId, run.taxTypeId) : isNull(proposals.taxTypeId),
  ));
  const reviewed: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  for (const prop of candidates) {
    const items = await db.select().from(proposalItems).where(eq(proposalItems.proposalId, prop.id));
    if (items.length === 0 || items.some((i) => i.targetTable !== "coverage_answers")) continue;
    if (prop.extractorRunId === run.id) {
      throw new HandlerError("needs_human", `self-review refused: this run authored proposal ${prop.id}`);
    }
    if (prop.extractorRunId) {
      const [author] = await db.select({ model: agentRuns.model }).from(agentRuns).where(eq(agentRuns.id, prop.extractorRunId)).limit(1);
      if (author?.model && author.model === ctx.spec.model) warnings.push(`proposal ${prop.id}: reviewer and decision ran on the same model (${ctx.spec.model}); independence is by run only`);
    }

    const snapIds = items.map((i) => i.snapshotId).filter((x): x is string => Boolean(x));
    const srcIds = items.map((i) => i.sourceId).filter((x): x is string => Boolean(x));
    const snaps = new Map((snapIds.length ? await db.select().from(sourceSnapshots).where(inArray(sourceSnapshots.id, snapIds)) : []).map((s) => [s.id, s]));
    const eligible = new Set((srcIds.length ? await db.select().from(sources).where(inArray(sources.id, srcIds)) : []).filter((s) => s.eligibility === "eligible").map((s) => s.id));
    const claims: ReviewClaim[] = items.map((item, i) => {
      const snap = item.snapshotId ? snaps.get(item.snapshotId) : undefined;
      const codeFail = codeCheck(item, snap, Boolean(item.sourceId && eligible.has(item.sourceId)));
      return { label: `C${i + 1}`, item, codeFail, passage: snap?.retrievedText ? passageAround(snap.retrievedText, String((item.payload as Record<string, unknown>).excerpt ?? "")) : "" };
    });

    const verdicts = new Map<string, Verdict>();
    const toModel = claims.filter((c) => !c.codeFail);
    for (let i = 0; i < toModel.length; i += BATCH) {
      const batch = toModel.slice(i, i + BATCH);
      const r = await ctx.call(buildReviewPrompt(batch));
      for (const [k, v] of parseVerdicts(extractJsonObject(r.content), batch)) verdicts.set(k, v);
    }
    const final = claims.map((c) => {
      const v: Verdict = c.codeFail ? { verdict: "fail", reason: `evidence check: ${c.codeFail}` } : verdicts.get(c.label) ?? { verdict: "fail", reason: "no reviewer verdict returned" };
      return { claim: c, ...v };
    });
    const passed = final.filter((f) => f.verdict === "pass").length;

    await db.transaction(async (tx) => {
      for (const f of final) {
        await tx.update(proposalItems).set({
          verdict: f.verdict === "pass" ? "pass" : "fail", updatedAt: new Date(),
          datavalues: { ...((f.claim.item.datavalues ?? {}) as Record<string, unknown>), review: { runId: run.id, verdict: f.verdict, reason: f.reason } },
        }).where(eq(proposalItems.id, f.claim.item.id));
        if (f.claim.codeFail || f.verdict === "conflict") {
          await tx.insert(exceptions).values({
            scopeRunId: run.scopeRunId, agentRunId: run.id, jurisdictionId: run.jurisdictionId, sourceId: f.claim.item.sourceId,
            exceptionType: "conflict", severity: "medium",
            detail: `proposal ${prop.id} item ${String((f.claim.item.payload as Record<string, unknown>).questionKey)}: ${f.reason}`,
          });
        }
      }
      await tx.update(proposals).set({ verifierRunId: run.id, status: passed > 0 ? "verified" : "rejected", updatedAt: new Date() }).where(eq(proposals.id, prop.id));
    });
    await ctx.event("proposal_reviewed", { proposalId: prop.id, items: final.length, passed });
    reviewed.push({ proposalId: prop.id, items: final.length, passed, failed: final.length - passed, status: passed > 0 ? "verified" : "rejected" });
  }

  if (reviewed.length === 0) {
    return { notes: `No proposed coverage proposals to review for ${envelope.jurisdiction}${envelope.taxType ? `/${envelope.taxType}` : ""}.`, datavalues: { reviewed: [] } };
  }
  const notes = [
    ...reviewed.map((r) => `Proposal ${String(r.proposalId)}: ${String(r.passed)}/${String(r.items)} items pass → ${String(r.status)}.`),
    "Passing items await human approval in /review; failed items will not publish.",
    ...warnings,
  ].join(" ");
  return { notes, datavalues: { reviewed, independenceWarnings: warnings } };
}

registerHandler("reviewer", "*", reviewProposals);
