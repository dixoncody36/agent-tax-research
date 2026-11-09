import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  agentRuns, client, coverageAnswers, db, exceptions, jurisdictions, runEvents, sourceChecks, sourceSnapshots, sources, researchLedger,
} from "@agent-tax-research/database";
import { failureType, keepVerbatimCandidates, planFetch } from "./fetch-handler.js";
import { runAssignment } from "./worker.js";

// Fetch must never request a vendor or prohibited source, and re-running an
// unchanged fetch must not pile up snapshots. Runs against the real local
// DB with a local HTTP server standing in for the government site; a
// throwaway jurisdiction keeps the seeded live sources out of the test.

const requested: string[] = [];
let pageText = "The state sales and use tax rate is 6.25 percent of the sales price.";
let server: Server;
let base = "";
let jurisdictionId = "";
const runIds: string[] = [];
const sourceIds: string[] = [];

before(async () => {
  server = createServer((req, res) => {
    requested.push(req.url ?? "");
    if (req.url === "/missing") { res.writeHead(404).end("gone"); return; }
    res.writeHead(200, { "content-type": "text/html" }).end(`<html><body><p>${pageText}</p></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const [j] = await db.insert(jurisdictions).values({ slug: `test-fetch-${Date.now()}`, name: "Fetch handler test", level: "state" }).returning();
  jurisdictionId = j!.id;
  const rows = await db.insert(sources).values([
    { jurisdictionId, name: "gov", url: `${base}/gov`, eligibility: "eligible" },
    { jurisdictionId, name: "vendor", url: `${base}/vendor`, publisherType: "vendor", eligibility: "noted_only" },
    { jurisdictionId, name: "paywall", url: `${base}/paywall`, publisherType: "other", eligibility: "prohibited" },
    { jurisdictionId, name: "missing", url: `${base}/missing`, eligibility: "eligible" },
  ]).returning({ id: sources.id });
  sourceIds.push(...rows.map((r) => r.id));
});

after(async () => {
  server.close();
  await db.delete(runEvents).where(inArray(runEvents.agentRunId, runIds));
  await db.delete(exceptions).where(eq(exceptions.jurisdictionId, jurisdictionId));
  await db.delete(researchLedger).where(eq(researchLedger.jurisdictionId, jurisdictionId));
  await db.delete(coverageAnswers).where(eq(coverageAnswers.jurisdictionId, jurisdictionId));
  await db.delete(sourceChecks).where(inArray(sourceChecks.sourceId, sourceIds));
  await db.delete(sourceSnapshots).where(inArray(sourceSnapshots.sourceId, sourceIds));
  await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  await db.delete(sources).where(inArray(sources.id, sourceIds));
  await db.delete(jurisdictions).where(eq(jurisdictions.id, jurisdictionId));
  await client.end();
});

async function fetchRun() {
  const [row] = await db.insert(agentRuns).values({ role: "fetch", unit: "discover", status: "queued", jurisdictionId }).returning();
  runIds.push(row!.id);
  return runAssignment({ id: row!.id, model: "meta:muse-spark-1.3" });
}

describe("planFetch / failureType (pure)", () => {
  it("fetches eligible only; login-gated goes to a human", () => {
    const mk = (eligibility: string) => ({ eligibility, url: `u-${eligibility}` }) as Parameters<typeof planFetch>[0][number];
    const p = planFetch([mk("eligible"), mk("noted_only"), mk("prohibited"), mk("gov_login_gated")]);
    assert.deepEqual(p.fetch.map((s) => s.eligibility), ["eligible"]);
    assert.deepEqual(p.skipped.map((s) => s.eligibility), ["noted_only", "prohibited"]);
    assert.deepEqual(p.gated.map((s) => s.eligibility), ["gov_login_gated"]);
  });
  it("types fetch failures", () => {
    assert.equal(failureType({ httpStatus: 403, error: null }), "blocked");
    assert.equal(failureType({ httpStatus: 404, error: null }), "primary_not_found");
    assert.equal(failureType({ httpStatus: null, error: "ECONNRESET" }), "transient");
  });
  it("keeps only candidates whose excerpt is verbatim in the snapshot", () => {
    const text = "The state sales and use tax rate is 6.25 percent of the sales price.";
    const r = keepVerbatimCandidates({ candidates: [
      { label: "state rate", value: "6.25%", excerpt: "sales and use tax rate is 6.25 percent" },
      { label: "invented", value: "7%", excerpt: "the rate is 7 percent statewide" },
      { label: "too short", value: "6.25", excerpt: "6.25" },
    ] }, text);
    assert.deepEqual(r.kept.map((k) => k.label), ["state rate"]);
    assert.equal(r.dropped, 2);
  });
});

describe("fetch handler (real DB, local server)", () => {
  it("snapshots eligible sources, never requests vendor/prohibited, types the 404", async () => {
    const r = await fetchRun();
    assert.ok("result" in r);
    assert.equal(r.result.status, "completed");
    assert.ok(requested.includes("/gov"));
    assert.ok(!requested.includes("/vendor") && !requested.includes("/paywall"));
    const ex = await db.select().from(exceptions).where(eq(exceptions.jurisdictionId, jurisdictionId));
    assert.deepEqual(ex.map((e) => e.exceptionType), ["primary_not_found"]);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runIds[0]!));
    assert.match(run!.handoffNotes ?? "", /Not fetched by rule \(2\)/);
  });

  it("re-running with unchanged sources reuses the snapshot", async () => {
    const r = await fetchRun();
    assert.ok("result" in r && r.result.status === "completed");
    const snaps = await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.sourceId, sourceIds[0]!));
    assert.equal(snaps.length, 1);
    const checks = await db.select().from(sourceChecks).where(eq(sourceChecks.sourceId, sourceIds[0]!));
    assert.equal(checks.length, 2);
  });

  it("a changed source invalidates validated ledger rows pinned to the old hash", async () => {
    const [src] = await db.select().from(sources).where(eq(sources.id, sourceIds[0]!));
    const [row] = await db.insert(researchLedger).values({
      jurisdictionId, questionKey: "state_rate", determination: "6.25%", status: "validated", snapshotHash: src!.contentHash,
    }).returning();
    const [cov] = await db.insert(coverageAnswers).values({
      jurisdictionId, questionKey: "state_rate", status: "found", answer: "6.25%", evidence: { snapshotHash: src!.contentHash, excerpt: "rate is 6.25 percent" },
    }).returning();
    pageText = "Effective next quarter the state sales and use tax rate is 6.50 percent.";
    const r = await fetchRun();
    assert.ok("result" in r && r.result.status === "completed");
    const [after] = await db.select().from(researchLedger).where(eq(researchLedger.id, row!.id));
    assert.equal(after!.status, "invalidated");
    assert.equal(after!.invalidatedReason, "source_changed");
    const [reopened] = await db.select().from(coverageAnswers).where(eq(coverageAnswers.id, cov!.id));
    assert.equal(reopened!.status, "unknown");
    const history = (reopened!.datavalues as { history: { status: string; answer: string }[] }).history;
    assert.deepEqual(history.map((h) => [h.status, h.answer]), [["found", "6.25%"]]);
    const snaps = await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.sourceId, sourceIds[0]!));
    assert.equal(snaps.length, 2);
  });
});
