import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDecisionPrompt, capDecision, extractJsonObject, sanitizeAnswer,
  sanitizeReview, stripHtml, toDetermination, truncateEvidence,
  type BenchTask,
} from "./muse-loop-lib.js";

// Regression suite for the Muse-API benchmark loop's pure logic: the spend
// caps and model-JSON handling are the parts that must never silently fail
// open (uncapped burn, garbage determinations scored as answers).

const task: BenchTask = {
  id: "tx-sales-state-rate", jurisdiction: "us-tx", category: "sales_tax",
  prompt: "Determine the Texas state sales and use tax rate.",
  sourceHint: "https://comptroller.texas.gov/taxes/sales/",
};

describe("stripHtml", () => {
  it("drops scripts/styles/tags and decodes entities", () => {
    const html = "<style>p{}</style><p>Rate is <b>6.25%</b> &amp; more</p><script>var x='</p>'</script>";
    assert.equal(stripHtml(html), "Rate is 6.25% & more");
  });
  it("collapses whitespace", () => {
    assert.equal(stripHtml("<p>a</p>\n\n<p>  b </p>"), "a b");
  });
});

describe("truncateEvidence", () => {
  it("leaves short text alone and marks truncation", () => {
    assert.equal(truncateEvidence("short", 100), "short");
    assert.match(truncateEvidence("x".repeat(50), 10), /truncated at 10 chars/);
  });
});

describe("extractJsonObject", () => {
  it("parses a bare object", () => {
    assert.deepEqual(extractJsonObject('{"rateValue": 6.25}'), { rateValue: 6.25 });
  });
  it("tolerates fences and prose", () => {
    assert.deepEqual(
      extractJsonObject('Here you go:\n```json\n{"a": {"b": 1}, "c": "x}y"}\n```\ndone'),
      { a: { b: 1 }, c: "x}y" },
    );
  });
  it("returns null on garbage, arrays, and empties", () => {
    assert.equal(extractJsonObject("no json here"), null);
    assert.equal(extractJsonObject("[1,2,3]"), null);
    assert.equal(extractJsonObject(""), null);
    assert.equal(extractJsonObject(null), null);
    assert.equal(extractJsonObject('{"unterminated": '), null);
  });
});

describe("sanitizeAnswer / sanitizeReview", () => {
  it("keeps only known non-empty fields", () => {
    assert.deepEqual(
      sanitizeAnswer({ rateValue: 6.25, rateUnit: "percent", bogus: 1, authority: "  ", kind: null }),
      { rateValue: 6.25, rateUnit: "percent" },
    );
    assert.deepEqual(sanitizeAnswer(null), {});
  });
  it("defaults any non-pass verdict to fail (fail closed)", () => {
    assert.equal(sanitizeReview({ verdict: "looks good" }).verdict, "fail");
    assert.equal(sanitizeReview(null).verdict, "fail");
    assert.equal(sanitizeReview({ verdict: "pass" }).verdict, "pass");
  });
  it("sanitizes corrections through the answer schema", () => {
    const r = sanitizeReview({ verdict: "fail", corrections: { rateValue: 6, nope: true }, reason: "wrong rate" });
    assert.deepEqual(r.corrections, { rateValue: 6 });
    assert.equal(r.reason, "wrong rate");
  });
});

describe("capDecision", () => {
  const cfg = { budgetUsd: 150, capUsd: 10, capTokens: null };
  it("allows spend below every cap", () => {
    assert.equal(capDecision({ priorSpentUsd: 0, loopSpentUsd: 5, loopTokens: 0 }, cfg).stop, false);
  });
  it("stops at the loop dollar cap", () => {
    const d = capDecision({ priorSpentUsd: 0, loopSpentUsd: 10, loopTokens: 0 }, cfg);
    assert.equal(d.stop, true);
    assert.match(d.reason ?? "", /loop cap/);
  });
  it("stops at the global budget including prior spend", () => {
    const d = capDecision({ priorSpentUsd: 149, loopSpentUsd: 1, loopTokens: 0 }, cfg);
    assert.equal(d.stop, true);
    assert.match(d.reason ?? "", /MUSE_BUDGET_USD/);
  });
  it("dollar caps stay open while costs are untracked, token cap still bites", () => {
    const untracked = { priorSpentUsd: null, loopSpentUsd: null, loopTokens: 999 };
    assert.equal(capDecision(untracked, cfg).stop, false);
    assert.equal(capDecision(untracked, { budgetUsd: 150, capUsd: null, capTokens: 999 }).stop, true);
  });
  it("budgets per provider: another provider's loop spend does not count", () => {
    const cfgA = { budgetUsd: 150, budgetLabel: "ANTHROPIC_BUDGET_USD", capUsd: null, capTokens: null };
    const state = { priorSpentUsd: 149, providerLoopSpentUsd: 0, loopSpentUsd: 5, loopTokens: 0 };
    assert.equal(capDecision(state, cfgA).stop, false);
    const over = capDecision({ ...state, providerLoopSpentUsd: 1 }, cfgA);
    assert.equal(over.stop, true);
    assert.match(over.reason ?? "", /ANTHROPIC_BUDGET_USD/);
  });
  it("no provider budget leaves only the loop caps", () => {
    const state = { priorSpentUsd: 9999, providerLoopSpentUsd: 9999, loopSpentUsd: 1, loopTokens: 0 };
    assert.equal(capDecision(state, { budgetUsd: null, capUsd: 10, capTokens: null }).stop, false);
  });
});

describe("prompts and determinations", () => {
  it("decision prompt carries task, schema, and evidence; never gold values", () => {
    const p = buildDecisionPrompt(task, "EVIDENCE-TEXT");
    assert.match(p, /Determine the Texas state sales/);
    assert.match(p, /rateValue/);
    assert.match(p, /EVIDENCE-TEXT/);
    assert.match(p, /ONLY the government-source evidence/);
  });
  it("determination cites the fetched government primary", () => {
    const d = toDetermination(task, { rateValue: 6.25 }, { tokensIn: 10, tokensOut: 5, wallSeconds: 1.23456, attempts: 2 });
    assert.equal(d.citations[0]!.url, task.sourceHint);
    assert.equal(d.citations[0]!.publisherType, "government");
    assert.equal(d.attempts, 2);
    assert.equal(d.wallSeconds, 1.23);
  });
});
