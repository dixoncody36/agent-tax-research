import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentRuns, client, db, exceptions, runEvents } from "@agent-tax-research/database";
import { capDecision } from "./muse-loop-lib.js";
import {
  PROVIDERS, PROVIDER_IDS, ConfigError, budgetUsd, callModel, defaultMaxTokens, formatSpec, loadDotEnv,
  parseModelSpec, rateCard, type CallOptions, type CallResult, type ModelSpec, type ProviderId,
} from "./providers.js";
import {
  MAX_ATTEMPTS, claimAssignment, envelopeFor, finishAssignment, loadRoleModels,
  type AgentRun, type Envelope, type RoleSlot,
} from "./work-queue.js";

// Headless worker: claims one queued assignment, runs its role handler on a
// provider:model, and records the outcome on the same agent_run (the run is
// the gate identity). Handlers own role work; this module owns model choice,
// spend gating, usage accounting, events, and failing loudly (AGENTS.md
// rule 10). Handlers register per role/unit from their own modules.

export type Role = "orchestrator" | "fetch" | "decision" | "reviewer";

// Thrown by handlers for a typed exception (exceptions.exception_type).
export class HandlerError extends Error {
  constructor(public readonly exceptionType: string, message: string, public readonly sourceId?: string) {
    super(message);
  }
}

export type ModelCall = (prompt: string, opts?: Partial<CallOptions>) => Promise<CallResult>;
export type HandlerContext = {
  run: AgentRun;
  envelope: Envelope;
  spec: ModelSpec;
  call: ModelCall;
  event: (type: string, detail: Record<string, unknown>) => Promise<void>;
};
export type HandlerOutcome = { notes: string; datavalues?: Record<string, unknown> };
export type Handler = (ctx: HandlerContext) => Promise<HandlerOutcome>;

const handlers = new Map<string, Handler>();

/** unit "*" handles every unit of the role that has no specific handler. */
export function registerHandler(role: Role, unit: string, handler: Handler): void {
  handlers.set(`${role}/${unit}`, handler);
}

function handlerFor(role: string, unit: string | null): Handler | undefined {
  return handlers.get(`${role}/${unit ?? ""}`) ?? handlers.get(`${role}/*`);
}

function prefixed(raw: string, origin: string): ModelSpec {
  const i = raw.indexOf(":");
  if (i <= 0 || !PROVIDER_IDS.includes(raw.slice(0, i) as ProviderId)) {
    throw new ConfigError(`${origin} model "${raw}" needs a provider prefix (${PROVIDER_IDS.map((p) => `${p}:`).join(", ")}).`);
  }
  return parseModelSpec(raw);
}

// --model > the assignment's own model > the config/models.yaml role slot.
export function resolveRunModel(flag: string | undefined, runModel: string | null, slot: RoleSlot | undefined): ModelSpec {
  if (flag) return prefixed(flag, "--model");
  if (runModel) return prefixed(runModel, "assignment");
  if (slot && PROVIDER_IDS.includes(slot.provider as ProviderId) && slot.model) {
    return { provider: slot.provider as ProviderId, model: slot.model };
  }
  throw new ConfigError(`no headless model for this role: config/models.yaml slot is provider "${slot?.provider ?? "unset"}". Pass --model provider:model.`);
}

async function recordEvent(agentRunId: string, eventType: string, detail: Record<string, unknown>) {
  await db.insert(runEvents).values({ agentRunId, eventType, detail });
}

async function recordedSpend(p: ProviderId): Promise<number | null> {
  const [row] = await client`SELECT sum(cost_usd) AS spent FROM agent_runs WHERE datavalues->>'provider' = ${p}`;
  return row?.spent !== null && row?.spent !== undefined ? Number(row.spent) : null;
}

export type RunRequest = { role?: Role; scopeId?: string; id?: string; model?: string };
export type RunResponse =
  | { error: string; message?: string; id?: string }
  | { assignment: null; instruction: string }
  | { result: Awaited<ReturnType<typeof finishAssignment>> & { exceptionType?: string }; run: Record<string, unknown> };

export async function runAssignment(req: RunRequest): Promise<RunResponse> {
  loadDotEnv();
  let run: AgentRun | undefined;
  if (req.id) {
    [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, req.id)).limit(1);
    if (!run) return { error: "assignment_not_found", id: req.id };
  } else {
    const where = req.scopeId
      ? and(eq(agentRuns.role, req.role!), eq(agentRuns.status, "queued"), eq(agentRuns.scopeRunId, req.scopeId))
      : and(eq(agentRuns.role, req.role!), eq(agentRuns.status, "queued"));
    [run] = await db.select().from(agentRuns).where(where).orderBy(agentRuns.createdAt).limit(1);
    if (!run) return { assignment: null, instruction: "No queued work for this role." };
  }
  if (run.status !== "queued") return { error: "not_claimable", message: `status is ${run.status}`, id: run.id };

  // Configuration problems are reported before claiming, so they never
  // consume one of the assignment's three attempts.
  let spec: ModelSpec;
  try {
    spec = resolveRunModel(req.model, run.model, loadRoleModels()[run.role]);
    rateCard(spec);
    budgetUsd(spec.provider);
  } catch (e) {
    if (e instanceof ConfigError) return { error: "config", message: e.message, id: run.id };
    throw e;
  }

  const claimed = await claimAssignment(run.id);
  if (!claimed) return { error: "not_claimable", message: "claimed by another worker or over the attempt cap", id: run.id };
  const event = (type: string, detail: Record<string, unknown>) => recordEvent(claimed.id, type, detail);

  const usage = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, uncosted: 0, servedModel: null as string | null, promptSha256s: [] as string[] };
  const budgetLabel = PROVIDERS[spec.provider].budgetEnv;
  const call: ModelCall = async (prompt, opts) => {
    const gate = capDecision(
      { priorSpentUsd: await recordedSpend(spec.provider), providerLoopSpentUsd: usage.costUsd, loopSpentUsd: null, loopTokens: 0 },
      { budgetUsd: budgetUsd(spec.provider), budgetLabel, capUsd: null, capTokens: null },
    );
    if (gate.stop) throw new HandlerError("needs_human", `spend gate: ${gate.reason}`);
    const promptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
    usage.promptSha256s.push(promptSha256);
    let r: CallResult;
    try {
      r = await callModel(spec, prompt, { maxTokens: opts?.maxTokens ?? defaultMaxTokens(spec.provider), effort: opts?.effort });
    } catch (e) {
      // Sent but failed (timeout, dropped connection) may still be billed.
      if (!(e instanceof ConfigError)) usage.uncosted += 1;
      throw e;
    }
    usage.calls += 1;
    usage.tokensIn += r.tokensIn;
    usage.tokensOut += r.tokensOut;
    if (r.costUsd === null) usage.uncosted += 1; else usage.costUsd += r.costUsd;
    usage.servedModel = r.model;
    await event("model_call", { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd, stopReason: r.stopReason, promptSha256 });
    return r;
  };

  const runDatavalues = () => ({
    provider: spec.provider, harness: "tax-worker", requestedModel: spec.model, spec: formatSpec(spec),
    calls: usage.calls, promptSha256s: usage.promptSha256s,
    ...(usage.uncosted > 0 ? { usageUnknown: true, uncostedCalls: usage.uncosted } : {}),
  });
  const finishUsage = () => ({
    model: usage.servedModel ?? spec.model, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut,
    costUsd: usage.calls === 0 && usage.uncosted === 0 ? 0 : usage.costUsd,
  });

  // Everything between claim and finish is inside the try: any throw must
  // finish the run as failed, or it would sit in `running` with no retry
  // path. Success is recorded after the try so a later error can never
  // rewrite it as failed; events after a finish are best-effort.
  let outcome: HandlerOutcome;
  try {
    const envelope = (await envelopeFor(claimed)).assignment;
    await event("claimed", { provider: spec.provider, model: spec.model, attempt: claimed.attempt });
    const handler = handlerFor(claimed.role, claimed.unit);
    if (!handler) throw new HandlerError("structure_unknown", `no headless handler for ${claimed.role}/${claimed.unit ?? "(no unit)"}`);
    outcome = await handler({ run: claimed, envelope, spec, call, event });
  } catch (e) {
    const exceptionType = e instanceof HandlerError ? e.exceptionType : e instanceof ConfigError ? "needs_human" : "transient";
    const detail = `${claimed.role}/${claimed.unit ?? ""} on ${formatSpec(spec)}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 1000);
    const result = await finishAssignment(claimed, {
      status: "failed", handoffNotes: `FAILED (${exceptionType}): ${detail}`, ...finishUsage(),
      datavalues: { ...runDatavalues(), error: detail },
    });
    const base = { scopeRunId: claimed.scopeRunId, agentRunId: claimed.id, jurisdictionId: claimed.jurisdictionId };
    await db.insert(exceptions).values({
      ...base, sourceId: e instanceof HandlerError ? (e.sourceId ?? null) : null,
      exceptionType, severity: exceptionType === "transient" ? "medium" : "high", detail,
    });
    if (claimed.attempt >= MAX_ATTEMPTS) {
      await db.insert(exceptions).values({ ...base, exceptionType: "attempt_cap", severity: "high", detail: `attempt ${claimed.attempt} of ${MAX_ATTEMPTS} failed; orchestrator notified. Last error: ${detail}` });
    }
    await event("failed", { exceptionType, error: detail.slice(0, 500), attempt: claimed.attempt, notifyOrchestrator: result.notifyOrchestrator }).catch(() => {});
    return { result: { ...result, exceptionType }, run: { id: claimed.id, role: claimed.role, unit: claimed.unit, spec: formatSpec(spec), ...finishUsage() } };
  }
  const result = await finishAssignment(claimed, {
    status: "completed", handoffNotes: outcome.notes, ...finishUsage(),
    datavalues: { ...runDatavalues(), ...(outcome.datavalues ?? {}) },
  });
  await event("completed", { notes: outcome.notes.slice(0, 500), calls: usage.calls, costUsd: usage.costUsd }).catch(() => {});
  return { result, run: { id: claimed.id, role: claimed.role, unit: claimed.unit, spec: formatSpec(spec), ...finishUsage() } };
}
