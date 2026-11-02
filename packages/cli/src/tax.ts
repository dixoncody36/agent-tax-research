import { count, desc, eq, sql } from "drizzle-orm";
import {
  agentRuns,
  client,
  db,
  jurisdictions,
  researchLedger,
  scopeRuns,
  sources,
  taxRates,
  taxRules,
  taxTypes,
} from "@agent-tax-research/database";

/**
 * tax CLI — the harness-neutral work contract (foundation cut).
 *
 * Every command prints JSON so any harness (Muse, Muse, Codex,
 * Grok, OpenCode, headless runners) consumes identical output.
 *
 *   pnpm tax status
 *   pnpm tax ledger check --jurisdiction us-tx
 *
 * The full assignment lifecycle (work next/claim/submit, context
 * compiler, publish gate) lands with decree Phase 1 milestones; this
 * cut proves the check-first read path future agents must use.
 */

function out(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

async function status() {
  const [j, tt, s, r, ru, sr, ar, rl] = await Promise.all([
    db.select({ n: count() }).from(jurisdictions),
    db.select({ n: count() }).from(taxTypes),
    db.select({ n: count() }).from(sources),
    db.select({ n: count() }).from(taxRates),
    db.select({ n: count() }).from(taxRules),
    db.select({ n: count() }).from(scopeRuns),
    db.select({ n: count() }).from(agentRuns),
    db.select({ n: count() }).from(researchLedger),
  ]);
  const ledgerByStatus = await db
    .select({ status: researchLedger.status, n: count() })
    .from(researchLedger)
    .groupBy(researchLedger.status);
  out({
    jurisdictions: j[0]?.n ?? 0,
    taxTypes: tt[0]?.n ?? 0,
    sources: s[0]?.n ?? 0,
    taxRates: r[0]?.n ?? 0,
    taxRules: ru[0]?.n ?? 0,
    scopeRuns: sr[0]?.n ?? 0,
    agentRuns: ar[0]?.n ?? 0,
    researchLedger: rl[0]?.n ?? 0,
    ledgerByStatus,
    roles: ["orchestrator", "fetch", "decision", "reviewer"],
    next: "No fetching until an assignment is issued inside a compiled context scope (see AGENTS.md).",
  });
}

async function ledgerCheck(slug: string) {
  const [jur] = await db
    .select()
    .from(jurisdictions)
    .where(eq(jurisdictions.slug, slug))
    .limit(1);
  if (!jur) {
    out({ jurisdiction: slug, found: false, instruction: "Unknown jurisdiction slug; register structure before research." });
    return;
  }
  const entries = await db
    .select({
      questionKey: researchLedger.questionKey,
      determination: researchLedger.determination,
      status: researchLedger.status,
      snapshotHash: researchLedger.snapshotHash,
      validatedAt: researchLedger.validatedAt,
      invalidatedReason: researchLedger.invalidatedReason,
    })
    .from(researchLedger)
    .where(eq(researchLedger.jurisdictionId, jur.id))
    .orderBy(researchLedger.questionKey);
  const runs = await db
    .select({
      role: agentRuns.role,
      unit: agentRuns.unit,
      status: agentRuns.status,
      handoffNotes: agentRuns.handoffNotes,
      finishedAt: agentRuns.finishedAt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.jurisdictionId, jur.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(10);
  const reusable = entries.filter((e) => e.status === "validated").length;
  out({
    jurisdiction: slug,
    found: true,
    determinations: entries,
    reusableValidated: reusable,
    recentRuns: runs,
    instruction:
      reusable > 0
        ? "Reuse validated determinations whose snapshot hash still matches. Reopen only on typed invalidation."
        : "No validated determinations yet for this jurisdiction. Research may proceed inside scope; record every determination to the ledger so future runs can reuse it.",
  });
}

async function analytics() {
  const byRole = await db
    .select({
      role: agentRuns.role,
      runs: count(),
      tokensIn: sql<number>`coalesce(sum(${agentRuns.tokensIn}), 0)`,
      tokensOut: sql<number>`coalesce(sum(${agentRuns.tokensOut}), 0)`,
      costUsd: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)`,
    })
    .from(agentRuns)
    .groupBy(agentRuns.role);
  const byJurisdiction = await db
    .select({
      slug: jurisdictions.slug,
      runs: count(),
      tokens: sql<number>`coalesce(sum(coalesce(${agentRuns.tokensIn}, 0) + coalesce(${agentRuns.tokensOut}, 0)), 0)`,
      failedRuns: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')`,
      maxAttempt: sql<number>`coalesce(max(${agentRuns.attempt}), 0)`,
    })
    .from(agentRuns)
    .leftJoin(jurisdictions, eq(agentRuns.jurisdictionId, jurisdictions.id))
    .groupBy(jurisdictions.slug);
  out({
    mode: "private (default; see config/analytics.yaml)",
    maxAttempts: 3,
    retryRule: "After attempt 3 fails: run failed, exception written, orchestrator notified.",
    runsByRole: byRole,
    runsByJurisdiction: byJurisdiction,
    instruction:
      "Populate/maintain/review cost per jurisdiction accumulates here as runs record tokens, cost, wall time, and attempts. First-run estimates come from benchmarks/ medians.",
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "status") {
    await status();
  } else if (cmd === "analytics") {
    await analytics();
  } else if (cmd === "ledger" && args[1] === "check") {
    const i = args.indexOf("--jurisdiction");
    const slug = i >= 0 ? args[i + 1] : undefined;
    if (!slug) {
      out({ error: "usage: tax ledger check --jurisdiction <slug>" });
      process.exitCode = 2;
      return;
    }
    await ledgerCheck(slug);
  } else {
    out({
      error: "unknown command",
      usage: ["tax status", "tax analytics", "tax ledger check --jurisdiction <slug>"],
    });
    process.exitCode = 2;
  }
}

main()
  .then(async () => {
    await client.end();
  })
  .catch(async (err: unknown) => {
    console.error(err);
    await client.end().catch(() => undefined);
    process.exit(1);
  });
