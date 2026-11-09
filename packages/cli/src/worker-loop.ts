import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { agentRuns, db, exceptions, jurisdictions, runEvents, scopeRuns } from "@agent-tax-research/database";
import { MAX_ATTEMPTS, type AgentRun } from "./work-queue.js";
import { runAssignment, type Role } from "./worker.js";

// Loop mode for the headless worker (agents/orchestrator.md duties 3 and 7):
// drain one scope serially in pipeline order, chaining Fetch -> Decision ->
// Reviewer, under hard spend caps checked at every assignment boundary.
// All state lives in agent_runs, so an interrupted loop restarts from the
// database alone: stale running runs are failed, failed runs are retried.

export const PIPELINE: Role[] = ["fetch", "decision", "reviewer"];

export type LoopOptions = {
  scopeId: string;
  capUsd: number | null;
  capTokens: number | null;
  models: Partial<Record<Role, string>>;
  fallbackModel?: string;
  maxRuns: number;
  staleMinutes: number;
};

export type LoopState = { runs: number; spentUsd: number; tokens: number; uncosted: number };

/** Checked before every assignment; the loop stops at the boundary, never mid-run. */
export function loopStop(s: LoopState, o: Pick<LoopOptions, "capUsd" | "capTokens" | "maxRuns">): string | null {
  if (o.capUsd !== null && s.uncosted > 0) return `a run reported no cost under --cap-usd; spend is no longer bounded`;
  if (o.capUsd !== null && s.spentUsd >= o.capUsd) return `cap reached: $${s.spentUsd.toFixed(4)} >= --cap-usd $${o.capUsd}`;
  if (o.capTokens !== null && s.tokens >= o.capTokens) return `cap reached: ${s.tokens} tokens >= --cap-tokens ${o.capTokens}`;
  if (s.runs >= o.maxRuns) return `--max-runs ${o.maxRuns} reached`;
  return null;
}

/** What a completed run enqueues next; null ends the chain. */
export function nextStep(role: string, datavalues: Record<string, unknown>): { role: Role; unit: string } | null {
  if (role === "fetch") return { role: "decision", unit: "decide" };
  if (role === "decision" && Number(datavalues.decided ?? 0) > 0) return { role: "reviewer", unit: "verify" };
  return null;
}

const sameTarget = (r: Pick<AgentRun, "jurisdictionId" | "taxTypeId">) => and(
  r.jurisdictionId ? eq(agentRuns.jurisdictionId, r.jurisdictionId) : isNull(agentRuns.jurisdictionId),
  r.taxTypeId ? eq(agentRuns.taxTypeId, r.taxTypeId) : isNull(agentRuns.taxTypeId),
);

async function enqueue(scopeId: string, from: AgentRun, role: Role, unit: string, attempt = 1): Promise<string | null> {
  const [open] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(
    eq(agentRuns.scopeRunId, scopeId), eq(agentRuns.role, role), inArray(agentRuns.status, ["queued", "running"]), sameTarget(from),
  )).limit(1);
  if (open && attempt === 1) return null;
  const [row] = await db.insert(agentRuns).values({
    scopeRunId: scopeId, role, unit, status: "queued", attempt,
    jurisdictionId: from.jurisdictionId, taxTypeId: from.taxTypeId, model: attempt > 1 ? from.model : null,
  }).returning({ id: agentRuns.id });
  return row?.id ?? null;
}

/** Restart safety: abandoned runs fail; failed runs under the cap get their next attempt. */
async function recover(scopeId: string, staleMinutes: number) {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  const stale = await db.update(agentRuns)
    .set({ status: "failed", finishedAt: new Date(), updatedAt: new Date(), handoffNotes: `FAILED (transient): abandoned — still running after ${staleMinutes} min; the worker process was interrupted.` })
    .where(and(eq(agentRuns.scopeRunId, scopeId), eq(agentRuns.status, "running"), lt(agentRuns.startedAt, cutoff)))
    .returning();
  for (const r of stale) {
    await db.insert(exceptions).values({ scopeRunId: scopeId, agentRunId: r.id, jurisdictionId: r.jurisdictionId, exceptionType: "transient", severity: "medium", detail: "abandoned run recovered by loop restart" });
  }
  const failed = await db.select().from(agentRuns).where(and(eq(agentRuns.scopeRunId, scopeId), eq(agentRuns.status, "failed"), lt(agentRuns.attempt, MAX_ATTEMPTS)));
  let retried = 0;
  for (const f of failed) {
    const [next] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(
      eq(agentRuns.scopeRunId, scopeId), eq(agentRuns.role, f.role), eq(agentRuns.attempt, f.attempt + 1), sameTarget(f),
      f.unit ? eq(agentRuns.unit, f.unit) : isNull(agentRuns.unit),
    )).limit(1);
    if (!next && (await enqueue(scopeId, f, f.role as Role, f.unit ?? "discover", f.attempt + 1))) retried += 1;
  }
  return { abandoned: stale.length, retried };
}

async function nextQueued(scopeId: string): Promise<AgentRun | undefined> {
  for (const role of PIPELINE) {
    const [r] = await db.select().from(agentRuns)
      .where(and(eq(agentRuns.scopeRunId, scopeId), eq(agentRuns.role, role), eq(agentRuns.status, "queued")))
      .orderBy(agentRuns.createdAt).limit(1);
    if (r) return r;
  }
  return undefined;
}

export async function runLoop(o: LoopOptions) {
  if (o.capUsd === null && o.capTokens === null) return { error: "uncapped", message: "Refusing an uncapped loop: pass --cap-usd N or --cap-tokens N." };
  const [scope] = await db.select().from(scopeRuns).where(eq(scopeRuns.id, o.scopeId)).limit(1);
  if (!scope) return { error: "scope_not_found", message: o.scopeId };
  const fence = new Set(((scope.scopeJson as Record<string, unknown>).jurisdictions as string[] | undefined) ?? []);
  const slugOf = async (id: string | null) => (id ? (await db.select({ slug: jurisdictions.slug }).from(jurisdictions).where(eq(jurisdictions.id, id)).limit(1))[0]?.slug : undefined);

  const startedAt = new Date();
  const recovered = await recover(o.scopeId, o.staleMinutes);
  const state: LoopState = { runs: 0, spentUsd: 0, tokens: 0, uncosted: 0 };
  const outcomes: { id: string; role: string; status: string; spec: string; costUsd: number }[] = [];
  let stopReason = "queue drained";

  for (;;) {
    const stop = loopStop(state, o);
    if (stop) { stopReason = stop; break; }
    const next = await nextQueued(o.scopeId);
    if (!next) break;
    const r = await runAssignment({ id: next.id, model: o.models[next.role as Role] ?? o.fallbackModel });
    if ("error" in r) { stopReason = `${r.error}: ${r.message ?? ""} (assignment ${next.id})`; break; }
    if (!("result" in r)) break;
    const run = r.run as { costUsd: number; tokensIn: number; tokensOut: number; spec: string };
    state.runs += 1;
    state.spentUsd += run.costUsd;
    state.tokens += run.tokensIn + run.tokensOut;
    const [done] = await db.select().from(agentRuns).where(eq(agentRuns.id, next.id)).limit(1);
    const dv = (done?.datavalues ?? {}) as Record<string, unknown>;
    if (dv.usageUnknown) state.uncosted += 1;
    outcomes.push({ id: next.id, role: next.role, status: r.result.status, spec: run.spec, costUsd: run.costUsd });

    if (r.result.status === "completed" && done) {
      const step = nextStep(done.role, dv);
      const slug = await slugOf(done.jurisdictionId);
      if (step && slug && fence.has(slug)) await enqueue(o.scopeId, done, step.role, step.unit);
    } else if (r.result.status === "failed" && done && done.attempt < MAX_ATTEMPTS) {
      await enqueue(o.scopeId, done, done.role as Role, done.unit ?? "discover", done.attempt + 1);
    }
  }

  const remaining = await db.select({ role: agentRuns.role, n: sql<number>`count(*)::int` }).from(agentRuns)
    .where(and(eq(agentRuns.scopeRunId, o.scopeId), eq(agentRuns.status, "queued"))).groupBy(agentRuns.role);
  const byRole = PIPELINE.map((role) => {
    const mine = outcomes.filter((x) => x.role === role);
    return `${role} ${mine.filter((x) => x.status === "completed").length} ok/${mine.filter((x) => x.status === "failed").length} failed`;
  }).join(", ");
  const notes = [
    `Loop over scope ${o.scopeId}: ${state.runs} runs (${byRole}); $${state.spentUsd.toFixed(4)} spent, ${state.tokens} tokens.`,
    `Stopped: ${stopReason}.`,
    recovered.abandoned || recovered.retried ? `Recovered on start: ${recovered.abandoned} abandoned runs failed, ${recovered.retried} retries queued.` : "",
    remaining.length ? `Still queued: ${remaining.map((x) => `${x.n} ${x.role}`).join(", ")}.` : "Nothing left queued.",
    "Verified proposals wait for a human in /review; nothing was published.",
  ].filter(Boolean).join(" ");
  const [orch] = await db.insert(agentRuns).values({
    scopeRunId: o.scopeId, role: "orchestrator", unit: "loop", status: "completed", attempt: 1,
    startedAt, finishedAt: new Date(), handoffNotes: notes, tokensIn: 0, tokensOut: 0, costUsd: "0",
    datavalues: { harness: "tax-worker-loop", stopReason, runs: outcomes, spentUsd: state.spentUsd, tokens: state.tokens, models: o.models },
  }).returning({ id: agentRuns.id });
  await db.insert(runEvents).values({ agentRunId: orch!.id, eventType: "loop_finished", detail: { runs: state.runs, stopReason, spentUsd: state.spentUsd } });
  return { orchestratorRunId: orch!.id, runs: state.runs, spentUsd: state.spentUsd, tokens: state.tokens, stopReason, recovered, outcomes, notes };
}
