import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { agentRuns, client, db, exceptions, jurisdictions, runEvents, scopeRuns } from "@agent-tax-research/database";
import { loopStop, nextStep, runLoop } from "./worker-loop.js";
import { registerHandler } from "./worker.js";

// Loop mode must chain the pipeline, stop at caps on an assignment
// boundary, and restart from database state alone after an interruption.
// Fake role handlers (no network, no spend) on a throwaway scope.

let jurisdictionId = "";
let scopeId = "";

before(async () => {
  const slug = `test-loop-${Date.now()}`;
  const [j] = await db.insert(jurisdictions).values({ slug, name: "Loop test", level: "state" }).returning();
  jurisdictionId = j!.id;
  const [s] = await db.insert(scopeRuns).values({ profileName: "test", scopeJson: { jurisdictions: [slug] } }).returning();
  scopeId = s!.id;
  registerHandler("fetch", "*", async () => ({ notes: "fetched" }));
  registerHandler("decision", "*", async () => ({ notes: "decided", datavalues: { decided: 1 } }));
  registerHandler("reviewer", "*", async () => ({ notes: "reviewed" }));
});

after(async () => {
  const runs = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.scopeRunId, scopeId));
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    await db.delete(runEvents).where(inArray(runEvents.agentRunId, ids));
    await db.delete(exceptions).where(inArray(exceptions.agentRunId, ids));
    await db.delete(agentRuns).where(inArray(agentRuns.id, ids));
  }
  await db.delete(scopeRuns).where(eq(scopeRuns.id, scopeId));
  await db.delete(jurisdictions).where(eq(jurisdictions.id, jurisdictionId));
  await client.end();
});

const base = { scopeId: "", capUsd: null, capTokens: 100_000, models: {}, fallbackModel: "meta:muse-spark-1.3", maxRuns: 20, staleMinutes: 30 };

describe("loopStop / nextStep (pure)", () => {
  it("stops on caps, unknown cost under a dollar cap, and max runs", () => {
    const s = { runs: 0, spentUsd: 0, tokens: 0, uncosted: 0 };
    assert.equal(loopStop(s, { capUsd: 1, capTokens: null, maxRuns: 5 }), null);
    assert.match(loopStop({ ...s, spentUsd: 1 }, { capUsd: 1, capTokens: null, maxRuns: 5 }) ?? "", /cap-usd/);
    assert.match(loopStop({ ...s, uncosted: 1 }, { capUsd: 1, capTokens: null, maxRuns: 5 }) ?? "", /no cost/);
    assert.equal(loopStop({ ...s, uncosted: 1 }, { capUsd: null, capTokens: 10, maxRuns: 5 }), null);
    assert.match(loopStop({ ...s, runs: 5 }, { capUsd: null, capTokens: 10, maxRuns: 5 }) ?? "", /max-runs/);
  });
  it("chains fetch -> decision -> reviewer only when something was decided", () => {
    assert.deepEqual(nextStep("fetch", {}), { role: "decision", unit: "decide" });
    assert.deepEqual(nextStep("decision", { decided: 2 }), { role: "reviewer", unit: "verify" });
    assert.equal(nextStep("decision", { decided: 0 }), null);
    assert.equal(nextStep("reviewer", {}), null);
  });
  it("a decision retry that decided nothing still chains a reviewer for proposed work", () => {
    assert.deepEqual(nextStep("decision", { decided: 0 }, true), { role: "reviewer", unit: "verify" });
  });
});

describe("runLoop (real DB, fake handlers)", () => {
  it("refuses an uncapped loop", async () => {
    const r = await runLoop({ ...base, scopeId, capTokens: null });
    assert.ok("error" in r && r.error === "uncapped");
  });

  it("drains fetch -> decision -> reviewer and records an orchestrator summary", async () => {
    await db.insert(agentRuns).values({ scopeRunId: scopeId, role: "fetch", unit: "discover", status: "queued", jurisdictionId });
    const r = await runLoop({ ...base, scopeId });
    assert.ok(!("error" in r));
    assert.deepEqual(r.outcomes.map((x) => `${x.role}:${x.status}`), ["fetch:completed", "decision:completed", "reviewer:completed"]);
    assert.equal(r.stopReason, "queue drained");
    const [orch] = await db.select().from(agentRuns).where(eq(agentRuns.id, r.orchestratorRunId));
    assert.equal(orch!.role, "orchestrator");
    assert.match(orch!.handoffNotes ?? "", /fetch 1 ok\/0 failed, decision 1 ok\/0 failed, reviewer 1 ok\/0 failed/);
  });

  it("restarts from DB state: an abandoned running run is failed and retried", async () => {
    const [stale] = await db.insert(agentRuns).values({
      scopeRunId: scopeId, role: "fetch", unit: "discover", status: "running", jurisdictionId, startedAt: new Date(Date.now() - 2 * 3600_000),
    }).returning();
    const r = await runLoop({ ...base, scopeId });
    assert.ok(!("error" in r));
    assert.equal(r.recovered.abandoned, 1);
    const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, stale!.id));
    assert.equal(after!.status, "failed");
    const retries = await db.select().from(agentRuns).where(and(eq(agentRuns.scopeRunId, scopeId), eq(agentRuns.role, "fetch"), eq(agentRuns.attempt, 2)));
    assert.equal(retries.length, 1);
    assert.equal(retries[0]!.status, "completed");
  });

  it("a category-restricted scope fails null-tax work before any handler runs", async () => {
    const [j] = await db.select().from(jurisdictions).where(eq(jurisdictions.id, jurisdictionId));
    const [restricted] = await db.insert(scopeRuns).values({ profileName: "test-cat", scopeJson: { jurisdictions: [j!.slug], categories: ["sales_tax"] } }).returning();
    const [queuedRun] = await db.insert(agentRuns).values({ scopeRunId: restricted!.id, role: "fetch", unit: "discover", status: "queued", jurisdictionId }).returning();
    try {
      const r = await runLoop({ ...base, scopeId: restricted!.id });
      assert.ok(!("error" in r));
      const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, queuedRun!.id));
      assert.equal(after!.status, "failed");
      assert.match(after!.handoffNotes ?? "", /outside_context_fence/);
      assert.equal(r.runs, 0);
    } finally {
      const ids = (await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.scopeRunId, restricted!.id))).map((x) => x.id);
      await db.delete(runEvents).where(inArray(runEvents.agentRunId, ids));
      await db.delete(exceptions).where(inArray(exceptions.agentRunId, ids));
      await db.delete(agentRuns).where(inArray(agentRuns.id, ids));
      await db.delete(scopeRuns).where(eq(scopeRuns.id, restricted!.id));
    }
  });

  it("stops at the run boundary when the run cap is reached", async () => {
    await db.insert(agentRuns).values({ scopeRunId: scopeId, role: "fetch", unit: "discover", status: "queued", jurisdictionId });
    const r = await runLoop({ ...base, scopeId, maxRuns: 1 });
    assert.ok(!("error" in r));
    assert.equal(r.runs, 1);
    assert.match(r.stopReason, /max-runs/);
  });
});
