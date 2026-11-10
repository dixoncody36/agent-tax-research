import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentRole, client } from "@agent-tax-research/database";
import { capDecision } from "./muse-loop-lib.js";
import {
  PROVIDERS, PROVIDER_IDS, ConfigError, budgetUsd, callModel, costTracked, defaultMaxTokens, defaultModelFor,
  formatSpec, loadDotEnv, parseModelSpec, rateCard, validateMaxTokens, type ModelSpec, type ProviderId,
} from "./providers.js";

// Model API runner: one headless call against Meta (Muse), the Claude API,
// or OpenRouter (see docs/model-apis.md). Every call is recorded as an
// agent_run (role, model, tokens, cost, datavalues.provider) so spend is
// visible in `tax analytics` and measured against the provider's budget
// env. A model-API run is its own run identity for the publish gates,
// exactly like a harness run; the human approver is still last.
// Usage (`pnpm model:api`; `pnpm muse:api` is the same runner):
//   ping     [--model <spec>] [--provider meta|anthropic|openrouter]
//   complete --role reviewer --prompt "..." | --prompt-file f [--model <spec>] [--max-tokens 800] [--effort high]
//   budget   [--provider p]
//   models
// <spec> = provider:model (anthropic:claude-opus-5-5, openrouter:openai/gpt-5)
// or a bare model id on --provider (default meta).
loadDotEnv();

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const out = (obj: unknown) => console.log(JSON.stringify(obj, null, 2));

function providerFlag(): ProviderId {
  const p = flag("provider") ?? "meta";
  if (!PROVIDER_IDS.includes(p as ProviderId)) {
    out({ error: `unknown --provider ${p}; expected one of ${PROVIDER_IDS.join(", ")}` });
    process.exit(2);
  }
  return p as ProviderId;
}

function resolveSpec(): ModelSpec {
  const provider = providerFlag();
  const raw = flag("model");
  if (raw) return parseModelSpec(raw, provider);
  const model = defaultModelFor(provider);
  if (!model) {
    out({ error: `no default model for ${provider}: pass --model ${provider}:<vendor/model> or set OPENROUTER_DEFAULT_MODEL` });
    process.exit(2);
  }
  return { provider, model };
}

async function spend(provider: ProviderId) {
  const [row] = await client`
    SELECT count(*)::int AS runs, sum(cost_usd) AS spent_usd,
      sum(tokens_in)::bigint AS tokens_in, sum(tokens_out)::bigint AS tokens_out,
      count(cost_usd)::int AS costed_runs,
      count(*) FILTER (WHERE datavalues->>'usageUnknown' = 'true' OR datavalues->>'costMissing' = 'true')::int AS uncosted_runs
    FROM agent_runs WHERE datavalues->>'provider' = ${provider}`;
  return {
    runs: row?.runs ?? 0,
    costedRuns: row?.costed_runs ?? 0,
    /** Calls that may have been billed but carry no cost: spend is a lower bound when > 0. */
    uncostedRuns: row?.uncosted_runs ?? 0,
    tokensIn: row?.tokens_in ?? 0,
    tokensOut: row?.tokens_out ?? 0,
    spentUsd: row?.spent_usd !== null && row?.spent_usd !== undefined ? Number(row.spent_usd) : null,
  };
}

async function budgetReport(only?: ProviderId) {
  const providers = only ? [only] : [...PROVIDER_IDS];
  const report = [];
  for (const p of providers) {
    const s = await spend(p);
    const budget = configValue(() => budgetUsd(p));
    report.push({
      provider: p, label: PROVIDERS[p].label,
      apiKeyConfigured: Boolean(process.env[PROVIDERS[p].keyEnv]),
      budgetUsd: budget,
      ...s,
      remainingUsd: typeof budget !== "number" || s.spentUsd === null ? null : Math.round((budget - s.spentUsd) * 10000) / 10000,
    });
  }
  out(report);
}

// Reports show a misconfiguration in place instead of aborting the report.
function configValue<T>(read: () => T): T | { configError: string } {
  try {
    return read();
  } catch (e) {
    if (e instanceof ConfigError) return { configError: e.message };
    throw e;
  }
}

function modelsReport() {
  out(PROVIDER_IDS.map((p) => {
    const model = defaultModelFor(p);
    return {
      provider: p, label: PROVIDERS[p].label, keyEnv: PROVIDERS[p].keyEnv,
      apiKeyConfigured: Boolean(process.env[PROVIDERS[p].keyEnv]),
      defaultModel: model,
      defaultModelRateCard: model ? configValue(() => rateCard({ provider: p, model })) : null,
      costTracked: model ? configValue(() => costTracked({ provider: p, model })) : p === "openrouter",
      defaultMaxTokens: defaultMaxTokens(p),
      budgetEnv: PROVIDERS[p].budgetEnv, budgetUsd: configValue(() => budgetUsd(p)),
    };
  }));
}

function fail(e: unknown): never {
  out({ error: e instanceof Error ? e.message.slice(0, 600) : String(e).slice(0, 600) });
  process.exit(e instanceof ConfigError ? 2 : 1);
}

async function complete(role: string, spec: ModelSpec, prompt: string, maxTokens: number) {
  // Everything that can be rejected is rejected before a paid call.
  if (!(agentRole.enumValues as readonly string[]).includes(role)) {
    fail(new ConfigError(`--role ${role} is not one of ${agentRole.enumValues.join(", ")}.`));
  }
  try {
    validateMaxTokens(spec, maxTokens);
    rateCard(spec);
    const s = await spend(spec.provider);
    const gate = capDecision(
      { priorSpentUsd: s.spentUsd, providerLoopSpentUsd: null, loopSpentUsd: null, loopTokens: 0 },
      { budgetUsd: budgetUsd(spec.provider), budgetLabel: PROVIDERS[spec.provider].budgetEnv, capUsd: null, capTokens: null },
    );
    if (gate.stop) { out({ error: gate.reason }); process.exit(3); }
  } catch (e) {
    fail(e);
  }
  const effort = flag("effort") as "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  const startedAt = new Date();
  const dv = { provider: spec.provider, harness: "model-api", requestedModel: spec.model, promptSha256: createHash("sha256").update(prompt, "utf8").digest("hex") };
  let result;
  try {
    result = await callModel(spec, prompt, { maxTokens, effort });
  } catch (e) {
    if (!(e instanceof ConfigError)) {
      // The request may have reached the provider and been billed (timeout,
      // dropped connection): keep a failed row with usage unknown.
      await client`
        INSERT INTO agent_runs (role, model, unit, status, started_at, finished_at, attempt, datavalues)
        VALUES (${role}, ${spec.model}, ${"model-api"}, ${"failed"}, ${startedAt.toISOString()}::timestamptz, ${new Date().toISOString()}::timestamptz, 1,
          ${JSON.stringify({ ...dv, usageUnknown: true, error: String(e).slice(0, 300) })}::jsonb)`;
    }
    fail(e);
  }
  const [run] = await client`
    INSERT INTO agent_runs (role, model, unit, status, started_at, finished_at, tokens_in, tokens_out, cost_usd, attempt, datavalues)
    VALUES (${role}, ${result.model}, ${"model-api"}, ${"completed"}, ${startedAt.toISOString()}::timestamptz, ${new Date().toISOString()}::timestamptz,
      ${result.tokensIn}, ${result.tokensOut}, ${result.costUsd}, 1,
      ${JSON.stringify({ ...dv, stopReason: result.stopReason, ...(result.costUsd === null ? { costMissing: true } : {}) })}::jsonb)
    RETURNING id`;
  out({
    runId: run?.id, role, provider: spec.provider, model: result.model, spec: formatSpec(spec),
    tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd,
    stopReason: result.stopReason, content: result.content,
  });
}

if (cmd === "budget") {
  await budgetReport(flag("provider") ? providerFlag() : undefined);
} else if (cmd === "models") {
  modelsReport();
} else if (cmd === "ping") {
  const spec = resolveSpec();
  await complete("fetch", spec, "Reply with exactly: pong", defaultMaxTokens(spec.provider));
} else if (cmd === "complete") {
  const promptFile = flag("prompt-file");
  const prompt = promptFile
    ? readFileSync(process.env.INIT_CWD ? resolve(process.env.INIT_CWD, promptFile) : promptFile, "utf8")
    : flag("prompt");
  if (!prompt) { out({ error: "complete requires --prompt or --prompt-file" }); process.exit(2); }
  const spec = resolveSpec();
  await complete(flag("role") ?? "decision", spec, prompt, flag("max-tokens") ? Number(flag("max-tokens")) : defaultMaxTokens(spec.provider));
} else {
  out({ error: "usage: model-api.ts ping|complete|budget|models [--provider meta|anthropic|openrouter] [--model provider:model]" });
  process.exit(2);
}
await client.end();
