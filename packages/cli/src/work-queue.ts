import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import { agentRuns, db, jurisdictionContext, jurisdictions, taxTypes } from "@agent-tax-research/database";

// Work-queue core shared by the `tax work` commands and the headless worker
// (worker.ts): assignment envelopes, role-model config, atomic claim, and
// result recording. One copy of the attempt-cap and claim rules.

export const MAX_ATTEMPTS = 3;
export type AgentRun = typeof agentRuns.$inferSelect;

export type RoleSlot = { provider: string; model: string | null; deployment: string | null };

export function loadRoleModels(): Record<string, RoleSlot> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const path = resolve(repoRoot, "config/models.yaml");
  const result: Record<string, RoleSlot> = {};
  if (!existsSync(path)) return result;
  let current: string | null = null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const role = line.match(/^ {2}(orchestrator|fetch|decision|reviewer|embedder):\s*$/);
    if (role) { current = role[1]!; result[current] = { provider: "harness", model: null, deployment: null }; continue; }
    if (!current) continue;
    const kv = line.match(/^ {4}(provider|model|deployment):\s*(.+?)\s*(?:#.*)?$/);
    if (kv) {
      const val = kv[2]!.replace(/\$\{([A-Z0-9_]+):-([^}]*)\}/g, (_m, name: string, dflt: string) => process.env[name] ?? dflt);
      if (kv[1] === "provider") result[current]!.provider = val;
      if (kv[1] === "model") result[current]!.model = val;
      if (kv[1] === "deployment") result[current]!.deployment = val || null;
    }
  }
  return result;
}

export async function resolveContextPacks(jurisdictionId: string | null) {
  if (!jurisdictionId) return [];
  const all = await db.select().from(jurisdictions);
  const byId = new Map(all.map((j) => [j.id, j]));
  const chain: typeof all = [];
  let cur = byId.get(jurisdictionId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); chain.push(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
  const packs: unknown[] = [];
  for (const j of chain) {
    const rows = await db.select().from(jurisdictionContext)
      .where(sql`${jurisdictionContext.jurisdictionId} = ${j.id} and ${jurisdictionContext.status} = 'active'`)
      .orderBy(desc(jurisdictionContext.version)).limit(1);
    const p = rows[0];
    if (p) packs.push({ jurisdiction: j.slug, version: p.version, guidance: p.guidance, memory: p.memory, author: p.author });
  }
  return packs;
}

export async function envelopeFor(run: AgentRun) {
  const jur = run.jurisdictionId ? (await db.select().from(jurisdictions).where(eq(jurisdictions.id, run.jurisdictionId)).limit(1))[0] : undefined;
  const tt = run.taxTypeId ? (await db.select().from(taxTypes).where(eq(taxTypes.id, run.taxTypeId)).limit(1))[0] : undefined;
  return {
    assignment: {
      v: 1, assignmentId: run.id, scopeRunId: run.scopeRunId, role: run.role, unit: run.unit,
      jurisdiction: jur?.slug ?? null, taxType: tt?.slug ?? null, attempt: run.attempt, maxAttempts: MAX_ATTEMPTS,
      model: run.model ?? loadRoleModels()[run.role]?.model ?? loadRoleModels()[run.role]?.deployment ?? null,
      contextPacks: await resolveContextPacks(run.jurisdictionId), // pre-run hook: local expert guidance, most specific first
      instructions: [
        "Check first: pnpm tax ledger check for this jurisdiction; reuse validated determinations.",
        "Primary government sources only; vendor content is noted-only.",
        "End with handoff notes via tax work submit (record --model, --tokens-in/--tokens-out or --tokens-unknown, and --prompt-file).",
      ],
    },
  };
}
export type Envelope = Awaited<ReturnType<typeof envelopeFor>>["assignment"];

// queued -> running in one statement, so two workers can never both claim
// the same assignment. Null when it is missing, not queued, or over the cap.
export async function claimAssignment(id: string): Promise<AgentRun | null> {
  const [run] = await db.update(agentRuns)
    .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentRuns.id, id), eq(agentRuns.status, "queued"), lte(agentRuns.attempt, MAX_ATTEMPTS)))
    .returning();
  return run ?? null;
}

export type FinishFields = {
  status: "completed" | "failed";
  handoffNotes: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  datavalues: Record<string, unknown>;
};

export async function finishAssignment(run: AgentRun, f: FinishFields) {
  const prior = run.datavalues !== null && typeof run.datavalues === "object" && !Array.isArray(run.datavalues)
    ? (run.datavalues as Record<string, unknown>) : {};
  await db.update(agentRuns).set({
    status: f.status, finishedAt: new Date(), updatedAt: new Date(), handoffNotes: f.handoffNotes,
    model: f.model ?? run.model, tokensIn: f.tokensIn, tokensOut: f.tokensOut,
    costUsd: f.costUsd === null ? null : f.costUsd.toFixed(4), datavalues: { ...prior, ...f.datavalues },
  }).where(eq(agentRuns.id, run.id));
  return {
    v: 1, assignmentId: run.id, status: f.status, attempt: run.attempt,
    notifyOrchestrator: f.status === "failed" && run.attempt >= MAX_ATTEMPTS,
    instruction: f.status === "failed"
      ? (run.attempt >= MAX_ATTEMPTS ? "Attempt cap reached: assignment failed permanently; orchestrator notified via status." : "Retryable: tax work retry --id <uuid> creates the next attempt.")
      : "Recorded. Handoff notes saved for future agents.",
  };
}
