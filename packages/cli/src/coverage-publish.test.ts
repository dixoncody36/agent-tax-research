import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { client, coverageAnswers, db, jurisdictions, proposalItems, proposals, sources } from "@agent-tax-research/database";
import { publishCoverageItem, publishableItems } from "./coverage-publish.js";

// Coverage determinations authored by a model reach coverage_answers only
// through an approved proposal; a fail verdict never publishes and a prior
// answer is kept in history, not overwritten. Real local DB.

let jurisdictionId = "";
let sourceId = "";
const proposalIds: string[] = [];

before(async () => {
  const [j] = await db.insert(jurisdictions).values({ slug: `test-cov-${Date.now()}`, name: "Coverage publish test", level: "state" }).returning();
  jurisdictionId = j!.id;
  const [s] = await db.insert(sources).values({ jurisdictionId, name: "test primary", url: `https://example.gov/test-cov-${Date.now()}`, eligibility: "eligible" }).returning();
  sourceId = s!.id;
});

after(async () => {
  await db.delete(coverageAnswers).where(eq(coverageAnswers.jurisdictionId, jurisdictionId));
  if (proposalIds.length) {
    await db.delete(proposalItems).where(inArray(proposalItems.proposalId, proposalIds));
    await db.delete(proposals).where(inArray(proposals.id, proposalIds));
  }
  await db.delete(sources).where(eq(sources.id, sourceId));
  await db.delete(jurisdictions).where(eq(jurisdictions.id, jurisdictionId));
  await client.end();
});

async function approvedItem(payload: Record<string, unknown>, verdict = "pass") {
  const [prop] = await db.insert(proposals).values({ jurisdictionId, status: "approved", approvedBy: "Test Human" }).returning();
  proposalIds.push(prop!.id);
  const [item] = await db.insert(proposalItems).values({ proposalId: prop!.id, targetTable: "coverage_answers", payload, citation: "test", verdict, sourceId }).returning();
  return { prop: prop!, item: item! };
}

describe("publishableItems", () => {
  it("passes only reviewer-pass items", () => {
    const r = publishableItems([{ verdict: "pass" }, { verdict: "fail" }, { verdict: "pending" }]);
    assert.equal(r.publish.length, 1);
    assert.equal(r.skipped.length, 2);
  });
});

describe("publishCoverageItem (real DB)", () => {
  it("inserts a missing row, then supersedes it keeping history", async () => {
    const first = await approvedItem({ questionKey: "state_rate", status: "unknown", answer: null });
    const r1 = await publishCoverageItem(first.prop, first.item);
    assert.ok(r1.ok);
    const second = await approvedItem({ questionKey: "state_rate", status: "found", answer: "6.25%", excerpt: "the state rate is 6.25 percent", snapshotHash: "abc" });
    const r2 = await publishCoverageItem(second.prop, second.item);
    assert.ok(r2.ok && r1.ok && r2.id === r1.id);
    const [row] = await db.select().from(coverageAnswers).where(eq(coverageAnswers.id, r2.ok ? r2.id : ""));
    assert.equal(row!.status, "found");
    assert.equal((row!.evidence as Record<string, unknown>).excerpt, "the state rate is 6.25 percent");
    const history = (row!.datavalues as { history: { status: string }[] }).history;
    assert.deepEqual(history.map((h) => h.status), ["unknown"]);
  });

  it("rejects a payload without a valid status", async () => {
    const bad = await approvedItem({ questionKey: "x", status: "maybe" });
    const r = await publishCoverageItem(bad.prop, bad.item);
    assert.equal(r.ok, false);
  });
});
