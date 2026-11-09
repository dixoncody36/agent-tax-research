import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { client } from "@agent-tax-research/database";
import {
  buildDecisionPrompt, buildReviewerPrompt, capDecision, extractJsonObject,
  sanitizeAnswer, sanitizeReview, stripHtml, toDetermination, truncateEvidence,
  type BenchTask, type CapState, type Determination,
} from "./muse-loop-lib.js";
import {
  PROVIDERS, PROVIDER_IDS, budgetUsd, callModel, costTracked, formatSpec, loadDotEnv,
  parseModelSpec, type ModelSpec, type ProviderId,
} from "./providers.js";

// Model-API benchmark loop: runs the fixed benchmark suite through distinct
// Fetch (deterministic HTTP + snapshot hash) / Decision / Reviewer passes,
// writes determinations, and scores them with benchmarks/run.mjs. Decision
// and Reviewer can run on any provider/model (Meta Muse, Claude API,
// OpenRouter); each --models entry is one comparison arm. Writes agent_runs
// + result files ONLY — no proposals, nothing publishes (human approves
// last, AGENTS.md). Every model call is budget-gated BEFORE it fires
// (the provider's budget env plus this loop's caps).
// Usage (`pnpm model:loop`; `pnpm muse:loop` is the same loop):
//   --dry-run [--models ...]
//   --cap-usd 10 --models anthropic:claude-opus-5-5,openrouter:openai/gpt-5,muse-spark-1.3 [--rounds 1]
//   --cap-usd 5 --models anthropic:claude-sonnet-5-5 --reviewer anthropic:claude-opus-5-5
//   --cap-tokens 500000 --rounds 20        (when a model has no rate card)
// A bare model id resolves against --provider (default meta). Without
// --reviewer each arm reviews with its own decision model (still a separate
// run identity); with it, every arm shares that reviewer.
loadDotEnv();

const ROOT = process.env.INIT_CWD ?? process.cwd();
const rest = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const out = (obj: unknown) => console.log(JSON.stringify(obj, null, 2));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const dryRun = rest.includes("--dry-run");
const defaultProvider = (flag("provider") ?? "meta") as ProviderId;
if (!PROVIDER_IDS.includes(defaultProvider)) {
  out({ error: `unknown --provider ${defaultProvider}; expected one of ${PROVIDER_IDS.join(", ")}` });
  process.exit(2);
}
const arms: ModelSpec[] = (flag("models") ?? flag("model") ?? "muse-spark-1.3")
  .split(",").map((s) => s.trim()).filter(Boolean).map((s) => parseModelSpec(s, defaultProvider));
const reviewerSpec: ModelSpec | null = flag("reviewer") ? parseModelSpec(flag("reviewer")!, defaultProvider) : null;
const rounds = Math.max(1, Number(flag("rounds") ?? "1"));
const capUsd = flag("cap-usd") ? Number(flag("cap-usd")) : null;
const capTokens = flag("cap-tokens") ? Number(flag("cap-tokens")) : null;
const maxTokens = Number(flag("max-tokens") ?? "900");
const effort = flag("effort") as "low" | "medium" | "high" | "xhigh" | "max" | undefined;
const suiteRel = flag("suite") ?? "benchmarks/v1/tasks.json";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve(ROOT, flag("out") ?? `benchmarks/runs/${stamp}`);

const suite = JSON.parse(readFileSync(resolve(ROOT, suiteRel), "utf8")) as { maxAttempts?: number; tasks: BenchTask[] };
const maxAttempts = Math.min(3, Number(suite.maxAttempts ?? 3));

const allSpecs = [...arms, ...(reviewerSpec ? [reviewerSpec] : [])];
const providersUsed = [...new Set(allSpecs.map((s) => s.provider))];

if (!dryRun) {
  const missing = providersUsed.filter((p) => !process.env[PROVIDERS[p].keyEnv]);
  if (missing.length > 0) {
    out({ error: `missing API keys: ${missing.map((p) => `${PROVIDERS[p].keyEnv} (${PROVIDERS[p].label})`).join(", ")}. Add them to .env.local (see docs/model-apis.md), or run with --dry-run.` });
    process.exit(2);
  }
  if (capUsd === null && capTokens === null) {
    out({ error: "Refusing an uncapped loop: pass --cap-usd N or --cap-tokens N." });
    process.exit(2);
  }
  const untracked = allSpecs.filter((s) => !costTracked(s));
  if (capUsd !== null && untracked.length > 0) {
    out({ error: `--cap-usd cannot track dollars for ${untracked.map(formatSpec).join(", ")} (no rate card: set MUSE_INPUT/OUTPUT_USD_PER_MTOK for Muse, or use a listed Claude model). Use --cap-tokens instead.` });
    process.exit(2);
  }
}

// Recorded spend per provider before this loop, for the provider budgets.
const priorSpent: Partial<Record<ProviderId, number | null>> = {};
for (const p of providersUsed) {
  if (dryRun) { priorSpent[p] = null; continue; }
  const [row] = await client`SELECT sum(cost_usd) AS spent FROM agent_runs WHERE datavalues->>'provider' = ${p}`;
  priorSpent[p] = row?.spent !== null && row?.spent !== undefined ? Number(row.spent) : null;
}
const loopSpentByProvider: Partial<Record<ProviderId, number>> = {};
const state: Pick<CapState, "loopSpentUsd" | "loopTokens"> = { loopSpentUsd: null, loopTokens: 0 };
let stopReason: string | null = null;

// Fetch role: deterministic HTTP over the task's public government primary.
// Cached per URL within this process (rounds/models share one snapshot).
const evidenceCache = new Map<string, { text: string; hash: string }>();
async function fetchEvidence(task: BenchTask): Promise<{ text: string; hash: string }> {
  const hit = evidenceCache.get(task.sourceHint);
  if (hit) return hit;
  const res = await fetch(task.sourceHint, {
    headers: { "user-agent": "agent-tax-research model-loop (benchmark evidence fetch)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`fetch ${task.sourceHint} -> HTTP ${res.status}`);
  const text = truncateEvidence(stripHtml(await res.text()), 12_000);
  const entry = { text, hash: sha256(text) };
  evidenceCache.set(task.sourceHint, entry);
  return entry;
}

type CallResult = { content: string | null; tokensIn: number; tokensOut: number };
async function complete(role: "decision" | "reviewer", spec: ModelSpec, task: BenchTask, prompt: string, attempt: number, evidenceHash: string): Promise<CallResult> {
  const gate = capDecision({
    priorSpentUsd: priorSpent[spec.provider] ?? null,
    providerLoopSpentUsd: loopSpentByProvider[spec.provider] ?? null,
    loopSpentUsd: state.loopSpentUsd,
    loopTokens: state.loopTokens,
  }, { budgetUsd: budgetUsd(spec.provider), budgetLabel: PROVIDERS[spec.provider].budgetEnv, capUsd, capTokens });
  if (gate.stop) {
    stopReason = gate.reason;
    throw new Error(`cap-stop: ${gate.reason}`);
  }
  const startedAt = new Date();
  const r = await callModel(spec, prompt, { maxTokens, effort });
  state.loopTokens += r.tokensIn + r.tokensOut;
  if (r.costUsd !== null) {
    state.loopSpentUsd = (state.loopSpentUsd ?? 0) + r.costUsd;
    loopSpentByProvider[spec.provider] = (loopSpentByProvider[spec.provider] ?? 0) + r.costUsd;
  }
  // ponytail: prompt stored as hash + evidence hash, not full text — #58
  // (persist full prompt) upgrades this when it lands.
  await client`
    INSERT INTO agent_runs (role, model, unit, status, started_at, finished_at, tokens_in, tokens_out, cost_usd, attempt, datavalues)
    VALUES (${role}, ${r.model}, ${`model-loop:${task.id}`}, ${"completed"}, ${startedAt}, ${new Date()},
      ${r.tokensIn}, ${r.tokensOut}, ${r.costUsd}, ${attempt},
      ${JSON.stringify({ provider: spec.provider, harness: "model-loop", requestedModel: spec.model, stopReason: r.stopReason, taskId: task.id, promptSha256: sha256(prompt), evidenceSha256: evidenceHash, sourceUrl: task.sourceHint })}::jsonb)`;
  return { content: r.content, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}

async function runTask(task: BenchTask, decisionSpec: ModelSpec, reviewSpec: ModelSpec): Promise<Determination> {
  const t0 = Date.now();
  const evidence = await fetchEvidence(task);
  let tokensIn = 0;
  let tokensOut = 0;
  let answer = sanitizeAnswer(null);
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const decision = await complete("decision", decisionSpec, task, buildDecisionPrompt(task, evidence.text), attempt, evidence.hash);
    tokensIn += decision.tokensIn; tokensOut += decision.tokensOut;
    const candidate = sanitizeAnswer(extractJsonObject(decision.content));
    const reviewCall = await complete("reviewer", reviewSpec, task, buildReviewerPrompt(task, evidence.text, candidate), attempt, evidence.hash);
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
const armLabel = (s: ModelSpec) => formatSpec(s).replace(/[^A-Za-z0-9._-]+/g, "_");

if (dryRun) {
  for (const task of suite.tasks) {
    const evidence = await fetchEvidence(task);
    const prompt = buildDecisionPrompt(task, evidence.text);
    summaries.push({
      taskId: task.id, source: task.sourceHint, evidenceChars: evidence.text.length,
      evidenceSha256: evidence.hash, promptChars: prompt.length,
      arms: arms.map(formatSpec), reviewer: reviewerSpec ? formatSpec(reviewerSpec) : "same as decision",
    });
    writeFileSync(resolve(outDir, `dry-run-${task.id}.prompt.txt`), prompt, "utf8");
  }
  writeFileSync(resolve(outDir, "dry-run.json"), JSON.stringify({ dryRun: true, suite: suiteRel, rounds, caps: { capUsd, capTokens }, tasks: summaries }, null, 2) + "\n", "utf8");
  out({ dryRun: true, outDir, tasks: summaries.length, note: "Evidence fetched + prompts written; no API calls, no agent_runs, no spend." });
  await client.end();
  process.exit(0);
}

outer: for (let round = 1; round <= rounds; round++) {
  for (const arm of arms) {
    const reviewSpec = reviewerSpec ?? arm;
    const determinations: Determination[] = [];
    for (const task of suite.tasks) {
      try {
        determinations.push(await runTask(task, arm, reviewSpec));
      } catch (e) {
        if (String(e).includes("cap-stop")) break outer;
        determinations.push(toDetermination(task, {}, { tokensIn: 0, tokensOut: 0, wallSeconds: 0, attempts: maxAttempts }));
        console.error(`task ${task.id} failed: ${String(e).slice(0, 300)}`);
      }
    }
    const detFile = resolve(outDir, `determinations-r${round}-${armLabel(arm)}.json`);
    writeFileSync(detFile, JSON.stringify({
      harness: "model-loop",
      roleModels: { orchestrator: "deterministic (model-loop)", fetch: "deterministic-http", decision: formatSpec(arm), reviewer: formatSpec(reviewSpec) },
      determinations,
    }, null, 2) + "\n", "utf8");
    const resultsFile = resolve(outDir, `results-r${round}-${armLabel(arm)}.json`);
    const scorerOut = execFileSync("node", ["benchmarks/run.mjs", detFile, "--suite", resolve(ROOT, suiteRel), "--out", resultsFile], { cwd: ROOT, encoding: "utf8" });
    const scored = JSON.parse(readFileSync(resultsFile, "utf8")) as { suiteAverage: number };
    summaries.push({ round, decision: formatSpec(arm), reviewer: formatSpec(reviewSpec), suiteAverage: scored.suiteAverage, determinations: detFile, results: resultsFile });
    console.log(scorerOut.trim().split("\n").slice(-2).join("\n"));
  }
}

const summary = {
  outDir, suite: suiteRel, roundsRequested: rounds, arms: arms.map(formatSpec),
  reviewer: reviewerSpec ? formatSpec(reviewerSpec) : "same as decision", summaries,
  loopTokens: state.loopTokens, loopSpentUsd: state.loopSpentUsd, loopSpentByProvider, priorSpentByProvider: priorSpent,
  stopReason, note: "Runs + scores only. Full budget view: pnpm model:api budget",
};
writeFileSync(resolve(outDir, "loop-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
out(summary);
await client.end();
