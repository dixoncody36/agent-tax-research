import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { client } from "@agent-tax-research/database";
import {
  buildDecisionPrompt, buildReviewerPrompt, capDecision, extractJsonObject,
  sanitizeAnswer, sanitizeReview, stripHtml, toDetermination, truncateEvidence,
  type BenchTask, type CapState, type Determination,
} from "./muse-loop-lib.js";

// Muse-API benchmark loop: runs the fixed benchmark suite through distinct
// Fetch (deterministic HTTP + snapshot hash) / Decision (Muse Spark) /
// Reviewer (Muse Spark, separate run identity) passes, writes determinations,
// and scores them with benchmarks/run.mjs. Writes agent_runs + result files
// ONLY — no proposals, nothing publishes (human approves last, AGENTS.md).
// Every model call is budget-gated BEFORE it fires (MUSE_BUDGET_USD plus
// this loop's caps). ponytail: dotenv + complete() duplicate muse-api.ts —
// promote to a shared module when a third Muse-API consumer appears.
// Usage:
//   pnpm muse:loop --dry-run [--models muse-spark-1.3]
//   pnpm muse:loop --cap-usd 10 [--models muse-spark-1.3,muse-spark-1.2] [--rounds 1]
//   pnpm muse:loop --cap-tokens 500000 --rounds 20        (no rate card set)
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
const ROOT = process.env.INIT_CWD ?? process.cwd();

const rest = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const dryRun = rest.includes("--dry-run");
const models = (flag("models") ?? flag("model") ?? "muse-spark-1.3").split(",").map((s) => s.trim()).filter(Boolean);
const rounds = Math.max(1, Number(flag("rounds") ?? "1"));
const capUsd = flag("cap-usd") ? Number(flag("cap-usd")) : null;
const capTokens = flag("cap-tokens") ? Number(flag("cap-tokens")) : null;
const maxTokens = Number(flag("max-tokens") ?? "900");
const suiteRel = flag("suite") ?? "benchmarks/v1/tasks.json";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve(ROOT, flag("out") ?? `benchmarks/runs/${stamp}`);
const out = (obj: unknown) => console.log(JSON.stringify(obj, null, 2));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const suite = JSON.parse(readFileSync(resolve(ROOT, suiteRel), "utf8")) as { maxAttempts?: number; tasks: BenchTask[] };
const maxAttempts = Math.min(3, Number(suite.maxAttempts ?? 3));

if (!dryRun) {
  if (!KEY) {
    out({ error: "MODEL_API_KEY not set. Add MODEL_API_KEY=LLM|... to .env.local (see docs/muse-api.md), or run with --dry-run." });
    process.exit(2);
  }
  if (capUsd === null && capTokens === null) {
    out({ error: "Refusing an uncapped loop: pass --cap-usd N (needs rate-card envs) or --cap-tokens N." });
    process.exit(2);
  }
  if (capUsd !== null && (RATE_IN === null || RATE_OUT === null)) {
    out({ error: "--cap-usd needs MUSE_INPUT_USD_PER_MTOK + MUSE_OUTPUT_USD_PER_MTOK in .env.local; without a rate card dollars are untracked. Use --cap-tokens instead." });
    process.exit(2);
  }
}

const [priorRow] = dryRun
  ? [{ spent: null }]
  : await client`SELECT sum(cost_usd) AS spent FROM agent_runs WHERE datavalues->>'provider' = 'meta'`;
const state: CapState = {
  priorSpentUsd: priorRow?.spent !== null && priorRow?.spent !== undefined ? Number(priorRow.spent) : null,
  loopSpentUsd: null,
  loopTokens: 0,
};
const caps = { budgetUsd: BUDGET_USD, capUsd, capTokens };
let stopReason: string | null = null;

// Fetch role: deterministic HTTP over the task's public government primary.
// Cached per URL within this process (rounds/models share one snapshot).
const evidenceCache = new Map<string, { text: string; hash: string }>();
async function fetchEvidence(task: BenchTask): Promise<{ text: string; hash: string }> {
  const hit = evidenceCache.get(task.sourceHint);
  if (hit) return hit;
  const res = await fetch(task.sourceHint, {
    headers: { "user-agent": "agent-tax-research muse-loop (benchmark evidence fetch)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`fetch ${task.sourceHint} -> HTTP ${res.status}`);
  const text = truncateEvidence(stripHtml(await res.text()), 12_000);
  const entry = { text, hash: sha256(text) };
  evidenceCache.set(task.sourceHint, entry);
  return entry;
}

type CallResult = { content: string | null; tokensIn: number; tokensOut: number; costUsd: number | null; model: string };
async function complete(role: "decision" | "reviewer", model: string, task: BenchTask, prompt: string, attempt: number, evidenceHash: string): Promise<CallResult> {
  const gate = capDecision(state, caps);
  if (gate.stop) {
    stopReason = gate.reason;
    throw new Error(`cap-stop: ${gate.reason}`);
  }
  const startedAt = new Date();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
    signal: AbortSignal.timeout(120_000),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`Meta Model API ${res.status}: ${bodyText.slice(0, 300)}`);
  const body = JSON.parse(bodyText) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };
  const tokensIn = body.usage?.prompt_tokens ?? 0;
  const tokensOut = body.usage?.completion_tokens ?? 0;
  const cost = RATE_IN !== null && RATE_OUT !== null ? (tokensIn * RATE_IN + tokensOut * RATE_OUT) / 1_000_000 : null;
  state.loopTokens += tokensIn + tokensOut;
  if (cost !== null) state.loopSpentUsd = (state.loopSpentUsd ?? 0) + cost;
  // ponytail: prompt stored as hash + evidence hash, not full text — #58
  // (persist full prompt) upgrades this when it lands.
  await client`
    INSERT INTO agent_runs (role, model, unit, status, started_at, finished_at, tokens_in, tokens_out, cost_usd, attempt, datavalues)
    VALUES (${role}, ${body.model ?? model}, ${`muse-loop:${task.id}`}, ${"completed"}, ${startedAt}, ${new Date()},
      ${tokensIn}, ${tokensOut}, ${cost}, ${attempt},
      ${JSON.stringify({ provider: "meta", harness: "muse-loop", base: BASE, taskId: task.id, promptSha256: sha256(prompt), evidenceSha256: evidenceHash, sourceUrl: task.sourceHint })}::jsonb)`;
  return { content: body.choices?.[0]?.message?.content ?? null, tokensIn, tokensOut, costUsd: cost, model: body.model ?? model };
}

async function runTask(task: BenchTask, model: string): Promise<Determination> {
  const t0 = Date.now();
  const evidence = await fetchEvidence(task);
  let tokensIn = 0;
  let tokensOut = 0;
  let answer = sanitizeAnswer(null);
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const decision = await complete("decision", model, task, buildDecisionPrompt(task, evidence.text), attempt, evidence.hash);
    tokensIn += decision.tokensIn; tokensOut += decision.tokensOut;
    const candidate = sanitizeAnswer(extractJsonObject(decision.content));
    const reviewCall = await complete("reviewer", model, task, buildReviewerPrompt(task, evidence.text, candidate), attempt, evidence.hash);
    tokensIn += reviewCall.tokensIn; tokensOut += reviewCall.tokensOut;
    const review = sanitizeReview(extractJsonObject(reviewCall.content));
    answer = { ...candidate, ...review.corrections };
    if (review.verdict === "pass" && Object.keys(candidate).length > 0) break;
    if (Object.keys(review.corrections).length > 0) break; // reviewer fixed it from evidence; ship corrected
  }
  return toDetermination(task, answer, { tokensIn, tokensOut, wallSeconds: (Date.now() - t0) / 1000, attempts });
}

mkdirSync(outDir, { recursive: true });
const summaries: unknown[] = [];

if (dryRun) {
  for (const task of suite.tasks) {
    const evidence = await fetchEvidence(task);
    const prompt = buildDecisionPrompt(task, evidence.text);
    summaries.push({
      taskId: task.id, source: task.sourceHint, evidenceChars: evidence.text.length,
      evidenceSha256: evidence.hash, promptChars: prompt.length, models,
    });
    writeFileSync(resolve(outDir, `dry-run-${task.id}.prompt.txt`), prompt, "utf8");
  }
  writeFileSync(resolve(outDir, "dry-run.json"), JSON.stringify({ dryRun: true, suite: suiteRel, rounds, caps, tasks: summaries }, null, 2) + "\n", "utf8");
  out({ dryRun: true, outDir, tasks: summaries.length, note: "Evidence fetched + prompts written; no API calls, no agent_runs, no spend." });
  await client.end();
  process.exit(0);
}

outer: for (let round = 1; round <= rounds; round++) {
  for (const model of models) {
    const determinations: Determination[] = [];
    for (const task of suite.tasks) {
      try {
        determinations.push(await runTask(task, model));
      } catch (e) {
        if (String(e).includes("cap-stop")) break outer;
        determinations.push(toDetermination(task, {}, { tokensIn: 0, tokensOut: 0, wallSeconds: 0, attempts: maxAttempts }));
        console.error(`task ${task.id} failed: ${String(e).slice(0, 300)}`);
      }
    }
    const detFile = resolve(outDir, `determinations-r${round}-${model}.json`);
    writeFileSync(detFile, JSON.stringify({
      harness: "muse-loop",
      roleModels: { orchestrator: "deterministic (muse-loop)", fetch: "deterministic-http", decision: model, reviewer: model },
      determinations,
    }, null, 2) + "\n", "utf8");
    const resultsFile = resolve(outDir, `results-r${round}-${model}.json`);
    const scorerOut = execFileSync("node", ["benchmarks/run.mjs", detFile, "--suite", resolve(ROOT, suiteRel), "--out", resultsFile], { cwd: ROOT, encoding: "utf8" });
    const scored = JSON.parse(readFileSync(resultsFile, "utf8")) as { suiteAverage: number };
    summaries.push({ round, model, suiteAverage: scored.suiteAverage, determinations: detFile, results: resultsFile });
    console.log(scorerOut.trim().split("\n").slice(-2).join("\n"));
  }
}

const summary = {
  outDir, suite: suiteRel, roundsRequested: rounds, models, summaries,
  loopTokens: state.loopTokens, loopSpentUsd: state.loopSpentUsd, priorSpentUsd: state.priorSpentUsd,
  stopReason, note: "Runs + scores only. Full budget view: pnpm muse:api budget",
};
writeFileSync(resolve(outDir, "loop-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
out(summary);
await client.end();
