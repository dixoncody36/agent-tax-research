import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { agentRuns, client, db, exceptions, runEvents } from "@agent-tax-research/database";
import { ConfigError } from "./providers.js";
import { registerHandler, resolveRunModel, runAssignment } from "./worker.js";

// The worker decides which paid API a run hits and how a failure is
// recorded; both must be exact. DB cases run against the real local
// database (docker compose up -d) and delete only the rows they create.

const created: string[] = [];
after(async () => {
  if (created.length > 0) {
    await db.delete(runEvents).where(inArray(runEvents.agentRunId, created));
    await db.delete(exceptions).where(inArray(exceptions.agentRunId, created));
    await db.delete(agentRuns).where(inArray(agentRuns.id, created));
  }
  await client.end();
});

async function queued(unit: string, attempt = 1) {
  const [row] = await db.insert(agentRuns).values({ role: "fetch", unit, status: "queued", attempt }).returning();
  created.push(row!.id);
  return row!;
}

describe("resolveRunModel", () => {
  const slot = { provider: "anthropic", model: "claude-haiku-5-5", deployment: null };
  it("--model wins, then the assignment, then the role slot", () => {
    assert.deepEqual(resolveRunModel("openrouter:openai/gpt-5", "meta:muse-spark-1.3", slot), { provider: "openrouter", model: "openai/gpt-5" });
    assert.deepEqual(resolveRunModel(undefined, "meta:muse-spark-1.3", slot), { provider: "meta", model: "muse-spark-1.3" });
    assert.deepEqual(resolveRunModel(undefined, null, slot), { provider: "anthropic", model: "claude-haiku-5-5" });
  });
  it("refuses harness slots and prefix-less ids instead of guessing a provider", () => {
    assert.throws(() => resolveRunModel(undefined, null, { provider: "harness", model: "muse-wonder", deployment: null }), ConfigError);
    assert.throws(() => resolveRunModel(undefined, "muse-wonder", slot), ConfigError);
    assert.throws(() => resolveRunModel(undefined, null, undefined), ConfigError);
  });
});

describe("runAssignment (real DB)", () => {
  it("an unhandled unit fails loudly with a typed exception and events", async () => {
    const run = await queued("test-no-handler");
    const r = await runAssignment({ id: run.id, model: "meta:muse-spark-1.3" });
    assert.ok("result" in r);
    assert.equal(r.result.status, "failed");
    assert.equal(r.result.exceptionType, "structure_unknown");
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    assert.equal(row!.status, "failed");
    assert.equal((row!.datavalues as Record<string, unknown>).provider, "meta");
    assert.equal(row!.tokensIn, 0);
    const ex = await db.select().from(exceptions).where(eq(exceptions.agentRunId, run.id));
    assert.deepEqual(ex.map((x) => x.exceptionType), ["structure_unknown"]);
    const ev = await db.select().from(runEvents).where(eq(runEvents.agentRunId, run.id));
    assert.deepEqual(ev.map((x) => x.eventType).sort(), ["claimed", "failed"]);
  });

  it("a handler outcome completes the run with its handoff notes", async () => {
    registerHandler("fetch", "test-ok", async () => ({ notes: "nothing to fetch", datavalues: { snapshots: 0 } }));
    const run = await queued("test-ok");
    const r = await runAssignment({ id: run.id, model: "anthropic:claude-haiku-5-5" });
    assert.ok("result" in r);
    assert.equal(r.result.status, "completed");
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    assert.equal(row!.handoffNotes, "nothing to fetch");
    assert.equal(row!.model, "claude-haiku-5-5");
    assert.equal(Number(row!.costUsd), 0);
  });

  it("failing the third attempt adds an attempt_cap exception and notifies", async () => {
    registerHandler("fetch", "test-boom", async () => { throw new Error("source unreachable"); });
    const run = await queued("test-boom", 3);
    const r = await runAssignment({ id: run.id, model: "meta:muse-spark-1.3" });
    assert.ok("result" in r);
    assert.equal(r.result.notifyOrchestrator, true);
    const ex = await db.select().from(exceptions).where(eq(exceptions.agentRunId, run.id));
    assert.deepEqual(ex.map((x) => x.exceptionType).sort(), ["attempt_cap", "transient"]);
  });

  it("a config error is reported before claiming and costs no attempt", async () => {
    const run = await queued("test-config");
    const r = await runAssignment({ id: run.id, model: "muse-wonder" });
    assert.ok("error" in r);
    assert.equal(r.error, "config");
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    assert.equal(row!.status, "queued");
  });

  it("a non-queued assignment is not claimable twice", async () => {
    const run = await queued("test-ok");
    await runAssignment({ id: run.id, model: "meta:muse-spark-1.3" });
    const again = await runAssignment({ id: run.id, model: "meta:muse-spark-1.3" });
    assert.ok("error" in again);
    assert.equal(again.error, "not_claimable");
  });
});
