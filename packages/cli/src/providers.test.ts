import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetUsd, costFromRates, costTracked, defaultModelFor, formatSpec, parseModelSpec, rateCard } from "./providers.js";

// Provider selection and spend arithmetic decide which API a run hits and
// whether its budget gate can fire; a wrong parse spends on the wrong key.

describe("parseModelSpec", () => {
  it("splits a known provider prefix", () => {
    assert.deepEqual(parseModelSpec("anthropic:claude-opus-5-5"), { provider: "anthropic", model: "claude-opus-5-5" });
  });
  it("keeps OpenRouter's own colons and slashes in the model id", () => {
    assert.deepEqual(parseModelSpec("openrouter:deepseek/deepseek-r1:free"), { provider: "openrouter", model: "deepseek/deepseek-r1:free" });
  });
  it("resolves a bare id against the default provider", () => {
    assert.deepEqual(parseModelSpec("muse-spark-1.3"), { provider: "meta", model: "muse-spark-1.3" });
    assert.deepEqual(parseModelSpec("claude-sonnet-5-5", "anthropic"), { provider: "anthropic", model: "claude-sonnet-5-5" });
  });
  it("does not treat an unknown prefix as a provider", () => {
    assert.deepEqual(parseModelSpec("vendor:thing", "openrouter"), { provider: "openrouter", model: "vendor:thing" });
  });
  it("rejects empty specs", () => {
    assert.throws(() => parseModelSpec("anthropic:"));
    assert.throws(() => parseModelSpec("  "));
  });
  it("round-trips through formatSpec", () => {
    assert.equal(formatSpec(parseModelSpec("openrouter:openai/gpt-5")), "openrouter:openai/gpt-5");
  });
});

describe("rate cards and budgets", () => {
  it("prices Claude models from the built-in table", () => {
    const r = rateCard({ provider: "anthropic", model: "claude-opus-5-5" }, {});
    assert.deepEqual(r, { in: 4, out: 20 });
    assert.equal(costFromRates(r, 1_000_000, 100_000), 6);
  });
  it("unknown Claude model has no rate card", () => {
    assert.equal(rateCard({ provider: "anthropic", model: "claude-unknown" }, {}), null);
  });
  it("Meta needs both rate envs", () => {
    assert.equal(rateCard({ provider: "meta", model: "muse-spark-1.3" }, { MUSE_INPUT_USD_PER_MTOK: "1" }), null);
    assert.deepEqual(rateCard({ provider: "meta", model: "muse-spark-1.3" }, { MUSE_INPUT_USD_PER_MTOK: "1", MUSE_OUTPUT_USD_PER_MTOK: "2" }), { in: 1, out: 2 });
  });
  it("OpenRouter is cost-tracked from the response, not a rate card", () => {
    assert.equal(costTracked({ provider: "openrouter", model: "openai/gpt-5" }, {}), true);
    assert.equal(costTracked({ provider: "meta", model: "muse-spark-1.3" }, {}), false);
  });
  it("budgets: Meta keeps its 150 default, others are unset unless configured", () => {
    assert.equal(budgetUsd("meta", {}), 150);
    assert.equal(budgetUsd("anthropic", {}), null);
    assert.equal(budgetUsd("openrouter", { OPENROUTER_BUDGET_USD: "25" }), 25);
  });
  it("OpenRouter default model comes from env only", () => {
    assert.equal(defaultModelFor("openrouter", {}), null);
    assert.equal(defaultModelFor("openrouter", { OPENROUTER_DEFAULT_MODEL: "openai/gpt-5" }), "openai/gpt-5");
    assert.equal(defaultModelFor("anthropic", {}), "claude-opus-5-5");
  });
});
