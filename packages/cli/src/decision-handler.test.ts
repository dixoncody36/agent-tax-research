import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  agentRuns, client, coverageAnswers, db, jurisdictions, proposalItems, proposals, researchLedger, sourceSnapshots, sources,
} from "@agent-tax-research/database";
import { decideCoverage, gateAnswers, type Evidence } from "./decision-handler.js";
import type { HandlerContext } from "./worker.js";

// The Decision gate is the anti-hallucination fence: a model-claimed
// `found` survives only with a verbatim excerpt in the cited snapshot, and
// a re-run after a kill must not file the same questions twice. DB cases
// use a throwaway jurisdiction and a fake model call (no network, no spend).

const TEXT = "Texas imposes a state sales and use tax. The state sales and use tax rate is 6.25 percent of the sales price of taxable items.";
const ev = (label: string, text = TEXT): Evidence => ({ label, snapshotId: `id-${label}`, contentHash: `h-${label}`, sourceId: "s", sourceName: "Comptroller", url: "https://example.gov", text });

describe("gateAnswers (pure)", () => {
  const asked = [{ questionKey: "state_rate", question: "?" }, { questionKey: "levy_exists", question: "?" }];
  it("keeps verbatim-backed found answers and downgrades the rest", () => {
    const g = gateAnswers({ answers: [
      { questionKey: "state_rate", status: "found", answer: "6.25%", snapshot: "S1", excerpt: "the state sales and use tax rate is 6.25 percent" },
      { questionKey: "levy_exists", status: "found", answer: "yes", snapshot: "S1", excerpt: "Texas imposes a broad franchise levy on all goods" },
    ] }, asked, [ev("S1")]);
    assert.deepEqual(g.found.map((f) => f.questionKey), ["state_rate"]);
    assert.equal(g.downgraded, 1);
  });
  it("rejects unknown snapshot labels, unasked questions, duplicates, and unknown status", () => {
    const g = gateAnswers({ answers: [
      { questionKey: "state_rate", status: "found", answer: "6.25%", snapshot: "S9", excerpt: "the state sales and use tax rate is 6.25 percent" },
      { questionKey: "not_asked", status: "found", answer: "x", snapshot: "S1", excerpt: "Texas imposes a state sales and use tax" },
      { questionKey: "levy_exists", status: "unknown" },
    ] }, asked, [ev("S1")]);
    assert.equal(g.found.length, 0);
    assert.equal(g.downgraded, 1);
  });
  it("tolerates a non-JSON reply", () => {
    assert.deepEqual(gateAnswers(null, asked, [ev("S1")]), { found: [], downgraded: 0 });
  });
});

let jurisdictionId = "";
let sourceId = "";
const runIds: string[] = [];

before(async () => {
  const [j] = await db.insert(jurisdictions).values({ slug: `test-dec-${Date.now()}`, name: "Decision test", level: "state" }).returning();
  jurisdictionId = j!.id;
  const [s] = await db.insert(sources).values({ jurisdictionId, name: "Comptroller", url: `https://example.gov/test-dec-${Date.now()}`, eligibility: "eligible", contentHash: "hash-1" }).returning();
  sourceId = s!.id;
  await db.insert(sourceSnapshots).values({ sourceId, contentHash: "hash-1", retrievedText: TEXT });
  await db.insert(coverageAnswers).values([
    { jurisdictionId, questionKey: "state_rate", status: "unknown" },
    { jurisdictionId, questionKey: "peer_existence.excise", status: "unknown" },
  ]);
});

after(async () => {
  const props = await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.jurisdictionId, jurisdictionId));
  if (props.length) await db.delete(proposalItems).where(inArray(proposalItems.proposalId, props.map((p) => p.id)));
  await db.delete(proposals).where(eq(proposals.jurisdictionId, jurisdictionId));
  await db.delete(researchLedger).where(eq(researchLedger.jurisdictionId, jurisdictionId));
  await db.delete(coverageAnswers).where(eq(coverageAnswers.jurisdictionId, jurisdictionId));
  await db.delete(sourceSnapshots).where(eq(sourceSnapshots.sourceId, sourceId));
  await db.delete(sources).where(eq(sources.id, sourceId));
  if (runIds.length) await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  await db.delete(jurisdictions).where(eq(jurisdictions.id, jurisdictionId));
  await client.end();
});

async function ctxWith(reply: unknown) {
  const [run] = await db.insert(agentRuns).values({ role: "decision", unit: "decide", status: "running", jurisdictionId }).returning();
  runIds.push(run!.id);
  let calls = 0;
  const ctx = {
    run: run!, spec: { provider: "meta", model: "fake" },
    envelope: { jurisdiction: "test", taxType: null, contextPacks: [] },
    call: async () => { calls += 1; return { content: JSON.stringify(reply), tokensIn: 1, tokensOut: 1, costUsd: 0, model: "fake", stopReason: "end_turn" }; },
    event: async () => {},
  } as unknown as HandlerContext;
  return { ctx, calls: () => calls };
}

const REPLY = { answers: [
  { questionKey: "state_rate", status: "found", answer: "6.25% of the sales price", snapshot: "S1", excerpt: "The state sales and use tax rate is 6.25 percent of the sales price" },
  { questionKey: "peer_existence.excise", status: "found", answer: "yes", snapshot: "S1", excerpt: "Texas imposes a statewide excise on fuel" },
] };

describe("decideCoverage (real DB, fake model)", () => {
  it("files one proposal with only the verbatim-backed answer, plus a pending ledger row", async () => {
    const { ctx } = await ctxWith(REPLY);
    const out = await decideCoverage(ctx);
    assert.equal(out.datavalues.decided, 1);
    assert.equal(out.datavalues.downgraded, 1);
    const props = await db.select().from(proposals).where(eq(proposals.jurisdictionId, jurisdictionId));
    assert.equal(props.length, 1);
    assert.equal(props[0]!.extractorRunId, ctx.run.id);
    const items = await db.select().from(proposalItems).where(eq(proposalItems.proposalId, props[0]!.id));
    assert.deepEqual(items.map((i) => (i.payload as { questionKey: string }).questionKey), ["state_rate"]);
    assert.equal(items[0]!.verdict, "pending");
    const ledger = await db.select().from(researchLedger).where(eq(researchLedger.jurisdictionId, jurisdictionId));
    assert.deepEqual(ledger.map((l) => l.status), ["pending_review"]);
  });

  it("kill-and-resume: a run killed after filing, then re-run, files no duplicate items", async () => {
    // The first run above filed its proposal and never finished (as if killed before submit).
    const { ctx, calls } = await ctxWith(REPLY);
    await decideCoverage(ctx);
    const props = await db.select().from(proposals).where(eq(proposals.jurisdictionId, jurisdictionId));
    const items = await db.select().from(proposalItems).where(inArray(proposalItems.proposalId, props.map((p) => p.id)));
    assert.equal(items.filter((i) => (i.payload as { questionKey: string }).questionKey === "state_rate").length, 1);
    assert.equal(calls(), 1); // only the still-open peer question was asked again
  });
});
