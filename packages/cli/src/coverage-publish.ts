import { and, eq, isNull } from "drizzle-orm";
import { coverageAnswers, db, proposalItems, proposals } from "@agent-tax-research/database";

// Publish one approved coverage_answers proposal item. Coverage rows carry
// no effective dates, so a superseded answer moves into datavalues.history
// instead of being overwritten (AGENTS.md rule 6: superseded, never edited).

export const COVERAGE_STATUSES = ["found", "confirmed_absent", "unknown"] as const;

type Proposal = typeof proposals.$inferSelect;
type Item = typeof proposalItems.$inferSelect;

/** Items a publish may apply: reviewer pass only, whatever the target. */
export function publishableItems<T extends { verdict: string }>(items: T[]): { publish: T[]; skipped: T[] } {
  return { publish: items.filter((i) => i.verdict === "pass"), skipped: items.filter((i) => i.verdict !== "pass") };
}

/** Checked for every coverage item before a publish writes anything. */
export function coveragePayloadError(payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (typeof p.questionKey !== "string" || typeof p.status !== "string" || !(COVERAGE_STATUSES as readonly string[]).includes(p.status)) {
    return "bad_coverage_payload: needs questionKey + status in found|confirmed_absent|unknown";
  }
  return null;
}

export async function publishCoverageItem(prop: Proposal, item: Item): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const p = item.payload as Record<string, unknown>;
  const invalid = coveragePayloadError(p);
  if (invalid) return { ok: false, error: invalid };
  const questionKey = p.questionKey as string;
  const status = p.status as string;
  const evidence = {
    excerpt: p.excerpt ?? null, snapshotHash: p.snapshotHash ?? null, snapshotId: item.snapshotId, sourceId: item.sourceId,
    citation: item.citation, proposalId: prop.id, proposalItemId: item.id, approvedBy: prop.approvedBy,
  };
  const where = and(
    eq(coverageAnswers.jurisdictionId, prop.jurisdictionId),
    prop.taxTypeId ? eq(coverageAnswers.taxTypeId, prop.taxTypeId) : isNull(coverageAnswers.taxTypeId),
    eq(coverageAnswers.questionKey, questionKey),
  );
  const [existing] = await db.select().from(coverageAnswers).where(where).limit(1);
  if (!existing) {
    const [row] = await db.insert(coverageAnswers).values({
      jurisdictionId: prop.jurisdictionId, taxTypeId: prop.taxTypeId, questionKey, status,
      answer: typeof p.answer === "string" ? p.answer : null, evidence, answeredByRunId: prop.extractorRunId,
    }).returning({ id: coverageAnswers.id });
    return { ok: true, id: row!.id };
  }
  const dv = (existing.datavalues ?? {}) as Record<string, unknown>;
  const history = Array.isArray(dv.history) ? dv.history : [];
  await db.update(coverageAnswers).set({
    status, answer: typeof p.answer === "string" ? p.answer : null, evidence, answeredByRunId: prop.extractorRunId,
    datavalues: {
      ...dv,
      history: [...history, {
        status: existing.status, answer: existing.answer, evidence: existing.evidence,
        answeredByRunId: existing.answeredByRunId, supersededAt: new Date().toISOString(), supersededByProposal: prop.id,
      }],
    },
    updatedAt: new Date(),
  }).where(eq(coverageAnswers.id, existing.id));
  return { ok: true, id: existing.id };
}
