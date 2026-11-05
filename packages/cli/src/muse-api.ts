import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { client } from "@agent-tax-research/database";

// Meta Model API (Muse) runner — hackathon provider (see docs/muse-api.md).
// OpenAI-compatible: POST {META_MODEL_API_BASE}/chat/completions with
// Authorization: Bearer $MODEL_API_KEY. Every call is recorded as an
// agent_run (role, model, tokens, cost) so Muse spend is visible in
// `tax analytics` and measurable against the credit budget
// (MUSE_BUDGET_USD, default 150). Distinct-run gates still apply: a
// Muse-API run is its own run identity, exactly like a harness run.
// Usage:
//   pnpm muse:api ping [--model muse-spark-1.3]
//   pnpm muse:api complete --role reviewer --prompt "..." [--prompt-file f] [--model m] [--max-tokens 800]
//   pnpm muse:api budget
function loadDotEnv() {
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
loadDotEnv();

const BASE = (process.env.META_MODEL_API_BASE ?? "https://api.meta.ai/v1").replace(/\/$/, "");
const KEY = process.env.MODEL_API_KEY ?? "";
const BUDGET_USD = Number(process.env.MUSE_BUDGET_USD ?? "150");
const RATE_IN = process.env.MUSE_INPUT_USD_PER_MTOK ? Number(process.env.MUSE_INPUT_USD_PER_MTOK) : null;
const RATE_OUT = process.env.MUSE_OUTPUT_USD_PER_MTOK ? Number(process.env.MUSE_OUTPUT_USD_PER_MTOK) : null;

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const out = (obj: unknown) => console.log(JSON.stringify(obj, null, 2));

async function spentUsd(): Promise<number | null> {
  const [row] = await client`
    SELECT sum(cost_usd) AS spent, count(*)::int AS runs,
      sum(tokens_in)::bigint AS tokens_in, sum(tokens_out)::bigint AS tokens_out,
      count(cost_usd)::int AS costed_runs
    FROM agent_runs WHERE datavalues->>'provider' = 'meta'`;
  return row && row.spent !== null ? Number(row.spent) : null;
}

async function budgetReport() {
  const [row] = await client`
    SELECT count(*)::int AS runs, sum(cost_usd) AS spent_usd,
      sum(tokens_in)::bigint AS tokens_in, sum(tokens_out)::bigint AS tokens_out,
      count(cost_usd)::int AS costed_runs
    FROM agent_runs WHERE datavalues->>'provider' = 'meta'`;
  const spent = row?.spent_usd !== null && row?.spent_usd !== undefined ? Number(row.spent_usd) : null;
  out({
    provider: "meta (Meta Model API / Muse)", base: BASE,
    apiKeyConfigured: Boolean(KEY),
    budgetUsd: BUDGET_USD,
    runsRecorded: row?.runs ?? 0, costedRuns: row?.costed_runs ?? 0,
    tokensIn: row?.tokens_in ?? 0, tokensOut: row?.tokens_out ?? 0,
    spentUsd: spent, remainingUsd: spent === null ? null : Math.round((BUDGET_USD - spent) * 10000) / 10000,
    rateCardConfigured: RATE_IN !== null && RATE_OUT !== null,
    note: spent === null ? "Set MUSE_INPUT_USD_PER_MTOK / MUSE_OUTPUT_USD_PER_MTOK from your Meta console rate card to track dollars; token counts are always recorded." : undefined,
  });
}

async function complete(role: string, model: string, prompt: string, maxTokens: number) {
  if (!KEY) {
    out({ error: "MODEL_API_KEY not set. Create a key at https://dev.meta.ai (Meta Model API), put MODEL_API_KEY=LLM|... in .env.local (gitignored), and re-run." });
    process.exit(2);
  }
  const spent = await spentUsd();
  if (spent !== null && spent >= BUDGET_USD) {
    out({ error: `Muse budget exhausted: recorded spend $${spent.toFixed(4)} >= MUSE_BUDGET_USD $${BUDGET_USD}. Raise the budget only if the credit allows.` });
    process.exit(3);
  }
  const startedAt = new Date();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    out({ error: `Meta Model API ${res.status}`, body: bodyText.slice(0, 500) });
    process.exit(1);
  }
  const body = JSON.parse(bodyText) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };
  const tokensIn = body.usage?.prompt_tokens ?? null;
  const tokensOut = body.usage?.completion_tokens ?? null;
  const cost = RATE_IN !== null && RATE_OUT !== null && tokensIn !== null && tokensOut !== null
    ? (tokensIn * RATE_IN + tokensOut * RATE_OUT) / 1_000_000
    : null;
  const [run] = await client`
    INSERT INTO agent_runs (role, model, unit, status, started_at, finished_at, tokens_in, tokens_out, cost_usd, attempt, datavalues)
    VALUES (${role}, ${body.model ?? model}, ${"muse-api"}, ${"completed"}, ${startedAt}, ${new Date()},
      ${tokensIn}, ${tokensOut}, ${cost}, 1,
      ${JSON.stringify({ provider: "meta", harness: "muse-api", base: BASE, promptSha256: createHash("sha256").update(prompt, "utf8").digest("hex") })}::jsonb)
    RETURNING id`;
  out({
    runId: run?.id, role, model: body.model ?? model,
    tokensIn, tokensOut, costUsd: cost,
    content: body.choices?.[0]?.message?.content ?? null,
  });
}

if (cmd === "budget") {
  await budgetReport();
} else if (cmd === "ping") {
  await complete("fetch", flag("model") ?? "muse-spark-1.3", "Reply with exactly: pong", 16);
} else if (cmd === "complete") {
  const promptFile = flag("prompt-file");
  const prompt = promptFile
    ? readFileSync(process.env.INIT_CWD ? resolve(process.env.INIT_CWD, promptFile) : promptFile, "utf8")
    : flag("prompt");
  if (!prompt) { out({ error: "complete requires --prompt or --prompt-file" }); process.exit(2); }
  await complete(flag("role") ?? "decision", flag("model") ?? "muse-spark-1.3", prompt, Number(flag("max-tokens") ?? "800"));
} else {
  out({ error: "usage: muse-api.ts ping|complete|budget" });
  process.exit(2);
}
await client.end();
