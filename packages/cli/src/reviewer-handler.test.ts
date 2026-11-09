import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  agentRuns, client, db, exceptions, jurisdictions, proposalItems, proposals, sourceSnapshots, sources,
} from "@agent-tax-research/database";
import { HandlerError, type HandlerContext } from "./worker.js";
import { passageAround, reviewProposals } from "./reviewer-handler.js";

// The Reviewer's code checks cannot be overruled by its model: a tampered
// excerpt fails even when the model says pass, and a run never reviews its
// own proposal. Real local DB, throwaway jurisdiction, fake model call.

const TEXT = "The state sales and use tax rate is 6.25 percent of the sales price of taxable items. Local rates may add up to 2 percent.";
let jurisdictionId = "";
let sourceId = "";
let snapshotId = "";
const runIds: string[] = [];

before(async () => {
  const [j] = await db.insert(jurisdictions).values({ slug: `test-rev-${Date.now()}`, name: "Reviewer test", level: "state" }).returning();
  jurisdictionId = j!.id;
  const [s] = await db.insert(sources).values({ jurisdictionId, name: "Comptroller", url: `https://example.gov/test-rev-${Date.now()}`, eligibility: "eligible" }).returning();
  sourceId = s!.id;
  const [snap] = await db.insert(sourceSnapshots).values({ sourceId, contentHash: "hash-r", retrievedText: TEXT }).returning();
  snapshotId = snap!.id;
});

after(async () => {
  const props = await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.jurisdictionId, jurisdictionId));
  if (props.length) await db.delete(proposalItems).where(inArray(proposalItems.proposalId, props.map((p) => p.id)));
  await db.delete(proposals).where(eq(proposals.jurisdictionId, jurisdictionId));
  await db.delete(exceptions).where(eq(exceptions.jurisdictionId, jurisdictionId));
  await db.delete(sourceSnapshots).where(eq(sourceSnapshots.sourceId, sourceId));
  await db.delete(sources).where(eq(sources.id, sourceId));
  if (runIds.length) await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  await db.delete(jurisdictions).where(eq(jurisdictions.id, jurisdictionId));
  await client.end();
});

async function newRun(role: "decision" | "reviewer", model: string) {
  const [r] = await db.insert(agentRuns).values({ role, model, status: "running", jurisdictionId }).returning();
  runIds.push(r!.id);
  return r!;
}

async function proposalBy(extractorRunId: string) {
  const [p] = await db.insert(proposals).values({ jurisdictionId, extractorRunId, status: "proposed" }).returning();
  const item = (questionKey: string, excerpt: string) => ({
    proposalId: p!.id, targetTable: "coverage_answers", citation: "Comptroller", sourceId, snapshotId,
    payload: { questionKey, status: "found", answer: "x", excerpt, snapshotHash: "hash-r" },
  });
  await db.insert(proposalItems).values([
    item("state_rate", "The state sales and use tax rate is 6.25 percent"),
    item("local_cap", "Local rates may add up to 3 percent"),
  ]);
  return p!;
}

function ctxFor(run: typeof agentRuns.$inferSelect, model: string) {
  let calls = 0;
  const ctx = {
    run, spec: { provider: "meta", model }, envelope: { jurisdiction: "test", taxType: null, contextPacks: [] },
    call: async () => {
      calls += 1;
      return { content: JSON.stringify({ verdicts: [{ claim: "C1", verdict: "pass", reason: "stated" }, { claim: "C2", verdict: "pass", reason: "stated" }] }), tokensIn: 1, tokensOut: 1, costUsd: 0, model, stopReason: "end_turn" };
    },
    event: async () => {},
  } as unknown as HandlerContext;
  return { ctx, calls: () => calls };
}

describe("passageAround (pure)", () => {
  it("centers on the excerpt when the text is long", () => {
    const text = `${"a ".repeat(10_000)}TARGET SENTENCE HERE ${"b ".repeat(10_000)}`;
    assert.match(passageAround(text, "target sentence here", 200), /TARGET SENTENCE HERE/);
  });
});

describe("reviewProposals (real DB, fake model)", () => {
  it("a tampered excerpt fails even though the model says pass; proposal verified by this run", async () => {
    const author = await newRun("decision", "model-a");
    const prop = await proposalBy(author.id);
    const reviewer = await newRun("reviewer", "model-b");
    const { ctx, calls } = ctxFor(reviewer, "model-b");
    await reviewProposals(ctx);
    assert.equal(calls(), 1);
    const items = await db.select().from(proposalItems).where(eq(proposalItems.proposalId, prop.id));
    const byKey = Object.fromEntries(items.map((i) => [(i.payload as { questionKey: string }).questionKey, i.verdict]));
    assert.deepEqual(byKey, { state_rate: "pass", local_cap: "fail" });
    const [after] = await db.select().from(proposals).where(eq(proposals.id, prop.id));
    assert.equal(after!.status, "verified");
    assert.equal(after!.verifierRunId, reviewer.id);
    const ex = await db.select().from(exceptions).where(eq(exceptions.agentRunId, reviewer.id));
    assert.deepEqual(ex.map((e) => e.exceptionType), ["conflict"]);
  });

  it("re-running on a verified proposal is a no-op", async () => {
    const reviewer = await newRun("reviewer", "model-b");
    const { ctx, calls } = ctxFor(reviewer, "model-b");
    const out = await reviewProposals(ctx);
    assert.equal(calls(), 0);
    assert.deepEqual(out.datavalues.reviewed, []);
  });

  it("refuses to review a proposal its own run authored", async () => {
    const self = await newRun("reviewer", "model-b");
    await proposalBy(self.id);
    const { ctx } = ctxFor(self, "model-b");
    await assert.rejects(reviewProposals(ctx), (e) => e instanceof HandlerError && e.exceptionType === "needs_human");
  });
});
