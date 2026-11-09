import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { client } from "@agent-tax-research/database";
import {
  PROVIDERS, PROVIDER_IDS, MissingKeyError, budgetUsd, callModel, costTracked, defaultModelFor,
  formatSpec, loadDotEnv, parseModelSpec, rateCard, type ModelSpec, type ProviderId,
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
      count(cost_usd)::int AS costed_runs
    FROM agent_runs WHERE datavalues->>'provider' = ${provider}`;
  return {
    runs: row?.runs ?? 0,
    costedRuns: row?.costed_runs ?? 0,
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
    const budget = budgetUsd(p);
    report.push({
      provider: p, label: PROVIDERS[p].label,
      apiKeyConfigured: Boolean(process.env[PROVIDERS[p].keyEnv]),
      budgetUsd: budget,
      ...s,
      remainingUsd: budget === null || s.spentUsd === null ? null : Math.round((budget - s.spentUsd) * 10000) / 10000,
    });
  }
  out(report);
}

function modelsReport() {
  out(PROVIDER_IDS.map((p) => {
    const model = defaultModelFor(p);
    return {
      provider: p, label: PROVIDERS[p].label, keyEnv: PROVIDERS[p].keyEnv,
      apiKeyConfigured: Boolean(process.env[PROVIDERS[p].keyEnv]),
      defaultModel: model,
      defaultModelRateCard: model ? rateCard({ provider: p, model }) : null,
      costTracked: model ? costTracked({ provider: p, model }) : p === "openrouter",
      budgetEnv: PROVIDERS[p].budgetEnv, budgetUsd: budgetUsd(p),
    };
  }));
}

async function complete(role: string, spec: ModelSpec, prompt: string, maxTokens: number) {
  const s = await spend(spec.provider);
  const budget = budgetUsd(spec.provider);
  if (budget !== null && s.spentUsd !== null && s.spentUsd >= budget) {
    out({ error: `${PROVIDERS[spec.provider].budgetEnv} reached: recorded ${spec.provider} spend $${s.spentUsd.toFixed(4)} >= $${budget}.` });
    process.exit(3);
  }
  const effort = flag("effort") as "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  const startedAt = new Date();
  let result;
  try {
    result = await callModel(spec, prompt, { maxTokens, effort });
  } catch (e) {
    out({ error: e instanceof MissingKeyError ? e.message : String(e).slice(0, 600) });
    process.exit(e instanceof MissingKeyError ? 2 : 1);
  }
  const [run] = await client`
    INSERT INTO agent_runs (role, model, unit, status, started_at, finished_at, tokens_in, tokens_out, cost_usd, attempt, datavalues)
    VALUES (${role}, ${result.model}, ${"model-api"}, ${"completed"}, ${startedAt}, ${new Date()},
      ${result.tokensIn}, ${result.tokensOut}, ${result.costUsd}, 1,
      ${JSON.stringify({ provider: spec.provider, harness: "model-api", requestedModel: spec.model, stopReason: result.stopReason, promptSha256: createHash("sha256").update(prompt, "utf8").digest("hex") })}::jsonb)
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
  await complete("fetch", resolveSpec(), "Reply with exactly: pong", 16);
} else if (cmd === "complete") {
  const promptFile = flag("prompt-file");
  const prompt = promptFile
    ? readFileSync(process.env.INIT_CWD ? resolve(process.env.INIT_CWD, promptFile) : promptFile, "utf8")
    : flag("prompt");
  if (!prompt) { out({ error: "complete requires --prompt or --prompt-file" }); process.exit(2); }
  await complete(flag("role") ?? "decision", resolveSpec(), prompt, Number(flag("max-tokens") ?? "800"));
} else {
  out({ error: "usage: model-api.ts ping|complete|budget|models [--provider meta|anthropic|openrouter] [--model provider:model]" });
  process.exit(2);
}
await client.end();
