import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// Model API providers for headless agent runs: Meta Model API (Muse),
// the Claude API, and OpenRouter. One call shape (`callModel`) and one
// spend picture (provider budget + rate card) for every runner, so a run
// can pick any provider/model per role. Pure helpers (spec parsing, rate
// cards, cost) are unit-tested in providers.test.ts; callModel is the only
// network I/O. Keys live in .env.local (gitignored), never in config.

export type ProviderId = "meta" | "anthropic" | "openrouter";
export const PROVIDER_IDS: readonly ProviderId[] = ["meta", "anthropic", "openrouter"];

export type ProviderInfo = {
  label: string;
  keyEnv: string;
  budgetEnv: string;
  defaultModel: string | null;
  docs: string;
};

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  meta: {
    label: "Meta Model API (Muse)",
    keyEnv: "MODEL_API_KEY",
    budgetEnv: "MUSE_BUDGET_USD",
    defaultModel: "muse-spark-1.3",
    docs: "https://dev.meta.ai — key format LLM|<id>|<secret>",
  },
  anthropic: {
    label: "Claude API (Anthropic)",
    keyEnv: "ANTHROPIC_API_KEY",
    budgetEnv: "ANTHROPIC_BUDGET_USD",
    defaultModel: "claude-opus-5-5",
    docs: "https://platform.claude.com — API keys",
  },
  openrouter: {
    label: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    budgetEnv: "OPENROUTER_BUDGET_USD",
    defaultModel: null, // set OPENROUTER_DEFAULT_MODEL or pass openrouter:<vendor/model>
    docs: "https://openrouter.ai/keys",
  },
};

// Loads .env.local then .env from INIT_CWD/cwd without overriding real env.
export function loadDotEnv(): void {
  const roots = [process.env.INIT_CWD, process.cwd()].filter(Boolean) as string[];
  for (const root of roots) {
    for (const name of [".env.local", ".env"]) {
      const p = resolve(root, name);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
      }
    }
  }
}

export type ModelSpec = { provider: ProviderId; model: string };

// "anthropic:claude-opus-5-5", "openrouter:deepseek/deepseek-r1:free",
// or a bare model id (resolved against defaultProvider). Only a known
// provider prefix is split off, so OpenRouter ids keep their own colons.
export function parseModelSpec(spec: string, defaultProvider: ProviderId = "meta"): ModelSpec {
  const trimmed = spec.trim();
  const i = trimmed.indexOf(":");
  if (i > 0) {
    const prefix = trimmed.slice(0, i) as ProviderId;
    if (PROVIDER_IDS.includes(prefix)) {
      const model = trimmed.slice(i + 1).trim();
      if (!model) throw new Error(`model spec "${spec}" names provider ${prefix} but no model`);
      return { provider: prefix, model };
    }
  }
  if (!trimmed) throw new Error("empty model spec");
  return { provider: defaultProvider, model: trimmed };
}

export function formatSpec(s: ModelSpec): string {
  return `${s.provider}:${s.model}`;
}

export function defaultModelFor(provider: ProviderId, env: NodeJS.ProcessEnv = process.env): string | null {
  if (provider === "openrouter") return env.OPENROUTER_DEFAULT_MODEL || null;
  return PROVIDERS[provider].defaultModel;
}

export function budgetUsd(provider: ProviderId, env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[PROVIDERS[provider].budgetEnv];
  if (raw === undefined || raw === "") return provider === "meta" ? 150 : null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// USD per 1M tokens. Anthropic first-party list prices (claude-api skill,
// cached 2026-10-06); Meta from the operator's console rate card envs;
// OpenRouter reports the billed cost on each response instead.
const ANTHROPIC_RATES: Record<string, { in: number; out: number }> = {
  "claude-fable-5-1": { in: 10, out: 50 },
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export function rateCard(spec: ModelSpec, env: NodeJS.ProcessEnv = process.env): { in: number; out: number } | null {
  if (spec.provider === "anthropic") return ANTHROPIC_RATES[spec.model] ?? null;
  if (spec.provider === "meta") {
    const i = env.MUSE_INPUT_USD_PER_MTOK;
    const o = env.MUSE_OUTPUT_USD_PER_MTOK;
    return i && o ? { in: Number(i), out: Number(o) } : null;
  }
  return null;
}

// Whether a run can be dollar-capped before it starts: a rate card exists,
// or the provider returns billed cost per response (OpenRouter).
export function costTracked(spec: ModelSpec, env: NodeJS.ProcessEnv = process.env): boolean {
  return spec.provider === "openrouter" || rateCard(spec, env) !== null;
}

export function costFromRates(rates: { in: number; out: number } | null, tokensIn: number, tokensOut: number): number | null {
  if (!rates) return null;
  return (tokensIn * rates.in + tokensOut * rates.out) / 1_000_000;
}

// Anthropic models that accept server-side refusal fallbacks ("default" form).
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export type CallOptions = { maxTokens: number; effort?: "low" | "medium" | "high" | "xhigh" | "max" };
export type CallResult = {
  content: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  model: string;
  stopReason: string | null;
};

export class MissingKeyError extends Error {}

function requireKey(provider: ProviderId): string {
  const info = PROVIDERS[provider];
  const key = process.env[info.keyEnv];
  if (!key) {
    throw new MissingKeyError(`${info.keyEnv} not set for ${info.label}. Get a key at ${info.docs} and put ${info.keyEnv}=... in .env.local (gitignored).`);
  }
  return key;
}

type ChatCompletion = {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  model?: string;
};

async function callOpenAiCompatible(spec: ModelSpec, prompt: string, opts: CallOptions): Promise<CallResult> {
  const key = requireKey(spec.provider);
  const base = spec.provider === "meta"
    ? (process.env.META_MODEL_API_BASE ?? "https://api.meta.ai/v1")
    : (process.env.OPENROUTER_API_BASE ?? "https://openrouter.ai/api/v1");
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${key}` };
  // Meta's Chat Completions rejects extra params (stop, n, logit_bias), so
  // it gets only model/messages/max_tokens. OpenRouter is asked to report
  // billed cost and given an app title for its dashboard.
  const body: Record<string, unknown> = { model: spec.model, messages: [{ role: "user", content: prompt }], max_tokens: opts.maxTokens };
  if (spec.provider === "openrouter") {
    body.usage = { include: true };
    headers["x-title"] = "agent-tax-research";
  }
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${PROVIDERS[spec.provider].label} ${res.status}: ${text.slice(0, 400)}`);
  const parsed = JSON.parse(text) as ChatCompletion;
  const tokensIn = parsed.usage?.prompt_tokens ?? 0;
  const tokensOut = parsed.usage?.completion_tokens ?? 0;
  const costUsd = spec.provider === "openrouter"
    ? (typeof parsed.usage?.cost === "number" ? parsed.usage.cost : null)
    : costFromRates(rateCard(spec), tokensIn, tokensOut);
  return {
    content: parsed.choices?.[0]?.message?.content ?? null,
    tokensIn, tokensOut, costUsd,
    model: parsed.model ?? spec.model,
    stopReason: parsed.choices?.[0]?.finish_reason ?? null,
  };
}

let anthropicClient: Anthropic | null = null;

async function callAnthropic(spec: ModelSpec, prompt: string, opts: CallOptions): Promise<CallResult> {
  anthropicClient ??= new Anthropic({ apiKey: requireKey("anthropic") });
  // Current Claude models always think; a small max_tokens can be spent
  // entirely on thinking and return no answer, so the floor is 16k
  // (billing is for tokens generated, not the ceiling).
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: spec.model,
    max_tokens: Math.max(opts.maxTokens, 16_000),
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: opts.effort ?? "high" },
  };
  if (FALLBACK_MODELS.has(spec.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const msg = await anthropicClient.beta.messages.create(params);
  const content = msg.stop_reason === "refusal"
    ? null
    : msg.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join("") || null;
  const tokensIn = msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
  const tokensOut = msg.usage.output_tokens;
  return {
    content, tokensIn, tokensOut,
    // msg.model is the model that served the turn (differs after a fallback).
    costUsd: costFromRates(rateCard({ provider: "anthropic", model: msg.model }) ?? rateCard(spec), tokensIn, tokensOut),
    model: msg.model,
    stopReason: msg.stop_reason ?? null,
  };
}

export async function callModel(spec: ModelSpec, prompt: string, opts: CallOptions): Promise<CallResult> {
  return spec.provider === "anthropic" ? callAnthropic(spec, prompt, opts) : callOpenAiCompatible(spec, prompt, opts);
}
