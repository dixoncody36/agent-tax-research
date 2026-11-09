import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { client } from "@agent-tax-research/database";
import {
  buildDecisionPrompt, buildReviewerPrompt, capDecision, extractJsonObject,
  sanitizeAnswer, sanitizeReview, stripHtml, toDetermination, truncateEvidence,
  type BenchTask, type Determination,
} from "./muse-loop-lib.js";
import {
  PROVIDERS, PROVIDER_IDS, ConfigError, budgetUsd, callModel, costTracked, defaultMaxTokens, defaultModelFor,
  formatSpec, loadDotEnv, parseModelSpec, rateCard, validateMaxTokens, type ModelSpec, type ProviderId,
} from "./providers.js";

// Model-API benchmark loop: runs the fixed benchmark suite through distinct
// Fetch (deterministic HTTP + snapshot hash) / Decision / Reviewer passes,
// writes determinations, and scores them with benchmarks/run.mjs. Decision
// and Reviewer can run on any provider/model (Meta Muse, Claude API,
// OpenRouter); each --models entry is one comparison arm. Writes agent_runs
// + result files ONLY — no proposals, nothing publishes (human approves
// last, AGENTS.md). Every model call is budget-gated BEFORE it fires
// (the provider's budget env, re-read per call, plus this loop's caps).
// Usage (`pnpm model:loop`; `pnpm muse:loop` is the same loop):
//   --dry-run [--models ...]
//   --cap-usd 10 --models anthropic:claude-opus-5-5,openrouter:openai/gpt-5,muse-spark-1.3 [--rounds 1]
//   --cap-usd 5 --models anthropic:claude-sonnet-5-5 --reviewer anthropic:claude-opus-5-5
//   --cap-tokens 500000 --rounds 20        (when a model has no rate card)
// A bare model id resolves against --provider (default meta). Without
// --reviewer each arm reviews with its own decision model (still a separate
// run identity); with it, every arm shares that reviewer. A task scores only
// with a reviewer pass; one that exhausts its attempts is recorded failed.
loadDotEnv();

const ROOT = process.env.INIT_CWD ?? process.cwd();
const rest = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const out = (obj: unknown) => console.log(JSON.stringify(obj, null, 2));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
function die(message: string): never {
  out({ error: message });
  process.exit(2);
}

const dryRun = rest.includes("--dry-run");
const defaultProvider = (flag("provider") ?? "meta") as ProviderId;
if (!PROVIDER_IDS.includes(defaultProvider)) die(`unknown --provider ${defaultProvider}; expected one of ${PROVIDER_IDS.join(", ")}`);
const armsFlag = flag("models") ?? flag("model") ?? defaultModelFor(defaultProvider);
if (!armsFlag) die(`no default model for ${defaultProvider}: pass --models ${defaultProvider}:<vendor/model> or set OPENROUTER_DEFAULT_MODEL`);
const arms: ModelSpec[] = armsFlag.split(",").map((s) => s.trim()).filter(Boolean).map((s) => parseModelSpec(s, defaultProvider));
const reviewerSpec: ModelSpec | null = flag("reviewer") ? parseModelSpec(flag("reviewer")!, defaultProvider) : null;

function positiveFlag(name: string, integer: boolean): number | null {
  const raw = flag(name);
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) die(`--${name} must be a finite positive ${integer ? "integer" : "number"} (got ${raw}).`);
  return n;
}
const rounds = positiveFlag("rounds", true) ?? 1;
const capUsd = positiveFlag("cap-usd", false);
const capTokens = positiveFlag("cap-tokens", true);
const maxTokensFlag = positiveFlag("max-tokens", true);
const maxTokensFor = (s: ModelSpec) => maxTokensFlag ?? defaultMaxTokens(s.provider);
const effort = flag("effort") as "low" | "medium" | "high" | "xhigh" | "max" | undefined;
const suiteRel = flag("suite") ?? "benchmarks/v1/tasks.json";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const suite = JSON.parse(readFileSync(resolve(ROOT, suiteRel), "utf8")) as { maxAttempts?: number; tasks: BenchTask[] };
const maxAttempts = Math.min(3, Number(suite.maxAttempts ?? 3));

const allSpecs = [...arms, ...(reviewerSpec ? [reviewerSpec] : [])];
const providersUsed = [...new Set(allSpecs.map((s) => s.provider))];

// Configuration is validated in full before any paid call.
try {
  for (const s of allSpecs) { validateMaxTokens(s, maxTokensFor(s)); rateCard(s); }
  for (const p of providersUsed) budgetUsd(p);
} catch (e) {
  if (e instanceof ConfigError) die(e.message);
  throw e;
}

if (!dryRun) {
  const missing = providersUsed.filter((p) => !process.env[PROVIDERS[p].keyEnv]);
  if (missing.length > 0) {
    die(`missing API keys: ${missing.map((p) => `${PROVIDERS[p].keyEnv} (${PROVIDERS[p].label})`).join(", ")}. Add them to .env.local (see docs/model-apis.md), or run with --dry-run.`);
  }
  if (capUsd === null && capTokens === null) die("Refusing an uncapped loop: pass --cap-usd N or --cap-tokens N.");
  const untracked = allSpecs.filter((s) => !costTracked(s));
  if (capUsd !== null && untracked.length > 0) {
    die(`--cap-usd cannot track dollars for ${untracked.map(formatSpec).join(", ")} (no rate card: set MUSE_INPUT/OUTPUT_USD_PER_MTOK for Muse, or use a listed Claude model). Use --cap-tokens instead.`);
  }
}

// An explicit --out is the operator's choice; the default directory is
// unique per invocation so concurrent loops never share result files.
const outDir = flag("out") ? resolve(ROOT, flag("out")!) : resolve(ROOT, `benchmarks/runs/${stamp}-${randomUUID().slice(0, 8)}`);
mkdirSync(flag("out") ? outDir : dirname(outDir), { recursive: true });
if (!flag("out")) mkdirSync(outDir);

async function recordedSpend(p: ProviderId): Promise<number | null> {
  const [row] = await client`SELECT sum(cost_usd) AS spent FROM agent_runs WHERE datavalues->>'provider' = ${p}`;
  return row?.spent !== null && row?.spent !== undefined ? Number(row.spent) : null;
}
const priorSpent: Partial<Record<ProviderId, number | null>> = {};
for (const p of providersUsed) priorSpent[p] = dryRun ? null : await recordedSpend(p);
const loopSpentByProvider: Partial<Record<ProviderId, number>> = {};
const state = { loopSpentUsd: null as number | null, loopTokens: 0, uncostedCalls: 0 };
let stopReason: string | null = null;

// Carries the tokens of a call that completed but triggered the stop, so the
// partial determination still reports its real usage.
class CapStop extends Error {
  constructor(message: string, readonly tokensIn = 0, readonly tokensOut = 0) {
    super(message);
  }
}

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
  // Recorded provider spend is re-read per call (it already includes this
  // loop's rows), so a concurrent runner's spend counts against the budget.
  const gate = capDecision({
    priorSpentUsd: await recordedSpend(spec.provider),
    providerLoopSpentUsd: null,
    loopSpentUsd: state.loopSpentUsd,
    loopTokens: state.loopTokens,
  }, { budgetUsd: budgetUsd(spec.provider), budgetLabel: PROVIDERS[spec.provider].budgetEnv, capUsd, capTokens });
  if (gate.stop) {
    stopReason = gate.reason;
    throw new CapStop(gate.reason ?? "cap");
  }
  const startedAt = new Date();
  const dv = { provider: spec.provider, harness: "model-loop", requestedModel: spec.model, taskId: task.id, promptSha256: sha256(prompt), evidenceSha256: evidenceHash, sourceUrl: task.sourceHint };
  let r;
  try {
    r = await callModel(spec, prompt, { maxTokens: maxTokensFor(spec), effort });
  } catch (e) {
    if (!(e instanceof ConfigError)) {
      state.uncostedCalls += 1;
      await client`
        INSERT INTO agent_runs (role, model, unit, status, started_at, finished_at, attempt, datavalues)
        VALUES (${role}, ${spec.model}, ${`model-loop:${task.id}`}, ${"failed"}, ${startedAt.toISOString()}::timestamptz, ${new Date().toISOString()}::timestamptz, ${attempt},
          ${JSON.stringify({ ...dv, usageUnknown: true, error: String(e).slice(0, 300) })}::jsonb)`;
      if (capUsd !== null) {
        stopReason = `${formatSpec(spec)} call failed after it may have been sent (${String(e).slice(0, 120)}); spend under --cap-usd is no longer bounded`;
        throw new CapStop(stopReason);
      }
    }
    throw e;
  }
  state.loopTokens += r.tokensIn + r.tokensOut;
  if (r.costUsd !== null) {
    state.loopSpentUsd = (state.loopSpentUsd ?? 0) + r.costUsd;
    loopSpentByProvider[spec.provider] = (loopSpentByProvider[spec.provider] ?? 0) + r.costUsd;
  } else {
    state.uncostedCalls += 1;
  }
  await client`
    INSERT INTO agent_runs (role, model, unit, status, started_at, finished_at, tokens_in, tokens_out, cost_usd, attempt, datavalues)
    VALUES (${role}, ${r.model}, ${`model-loop:${task.id}`}, ${"completed"}, ${startedAt.toISOString()}::timestamptz, ${new Date().toISOString()}::timestamptz,
      ${r.tokensIn}, ${r.tokensOut}, ${r.costUsd}, ${attempt},
      ${JSON.stringify({ ...dv, stopReason: r.stopReason, ...(r.costUsd === null ? { costMissing: true } : {}) })}::jsonb)`;
  if (capUsd !== null && r.costUsd === null) {
    // A dollar cap can't be enforced past a call whose charge is unknown.
    stopReason = `${formatSpec(spec)} returned no cost under --cap-usd; spend is no longer bounded`;
    throw new CapStop(stopReason, r.tokensIn, r.tokensOut);
  }
  return { content: r.content, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}

async function runTask(task: BenchTask, decisionSpec: ModelSpec, reviewSpec: ModelSpec): Promise<{ det: Determination; capStop: boolean }> {
  const t0 = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;
  let attempts = 0;
  const usage = () => ({ tokensIn, tokensOut, wallSeconds: (Date.now() - t0) / 1000, attempts });
  try {
    const evidence = await fetchEvidence(task);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      const decision = await complete("decision", decisionSpec, task, buildDecisionPrompt(task, evidence.text), attempt, evidence.hash);
      tokensIn += decision.tokensIn; tokensOut += decision.tokensOut;
      const candidate = sanitizeAnswer(extractJsonObject(decision.content));
      const reviewCall = await complete("reviewer", reviewSpec, task, buildReviewerPrompt(task, evidence.text, candidate), attempt, evidence.hash);
      tokensIn += reviewCall.tokensIn; tokensOut += reviewCall.tokensOut;
      const review = sanitizeReview(extractJsonObject(reviewCall.content));
      if (review.verdict === "pass" && Object.keys(candidate).length > 0) {
        return { det: toDetermination(task, candidate, usage()), capStop: false };
      }
    }
    return { det: toDetermination(task, {}, usage(), `no reviewer pass after ${attempts} attempts`), capStop: false };
  } catch (e) {
    const capStop = e instanceof CapStop;
    if (capStop) { tokensIn += e.tokensIn; tokensOut += e.tokensOut; }
    if (!capStop) console.error(`task ${task.id} failed: ${String(e).slice(0, 300)}`);
    return { det: toDetermination(task, {}, usage(), capStop ? `stopped: ${stopReason}` : String(e).slice(0, 200)), capStop };
  }
}

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
    let stopped = false;
    for (const task of suite.tasks) {
      const { det, capStop } = await runTask(task, arm, reviewSpec);
      determinations.push(det);
      if (capStop) { stopped = true; break; }
    }
    // A stopped arm is still written and scored (its calls were paid for),
    // marked incomplete so it is never compared as a full run.
    const detFile = resolve(outDir, `determinations-r${round}-${armLabel(arm)}.json`);
    writeFileSync(detFile, JSON.stringify({
      harness: "model-loop",
      roleModels: { orchestrator: "deterministic (model-loop)", fetch: "deterministic-http", decision: formatSpec(arm), reviewer: formatSpec(reviewSpec) },
      ...(stopped ? { incomplete: true, stopReason } : {}),
      determinations,
    }, null, 2) + "\n", "utf8");
    const resultsFile = resolve(outDir, `results-r${round}-${armLabel(arm)}.json`);
    const scorerOut = execFileSync("node", ["benchmarks/run.mjs", detFile, "--suite", resolve(ROOT, suiteRel), "--out", resultsFile], { cwd: ROOT, encoding: "utf8" });
    const scored = JSON.parse(readFileSync(resultsFile, "utf8")) as { suiteAverage: number };
    if (stopped) {
      // The scorer does not know the arm stopped early; mark the results file
      // so no comparison treats it as a full run.
      writeFileSync(resultsFile, JSON.stringify({ ...scored, incomplete: true, stopReason, tasksRun: determinations.length }, null, 2) + "\n", "utf8");
    }
    summaries.push({
      round, decision: formatSpec(arm), reviewer: formatSpec(reviewSpec), suiteAverage: scored.suiteAverage,
      tasksRun: determinations.length, tasksFailed: determinations.filter((d) => d.failed).length,
      incomplete: stopped, determinations: detFile, results: resultsFile,
    });
    console.log(scorerOut.trim().split("\n").slice(-2).join("\n"));
    if (stopped) break outer;
  }
}

const summary = {
  outDir, suite: suiteRel, roundsRequested: rounds, arms: arms.map(formatSpec),
  reviewer: reviewerSpec ? formatSpec(reviewerSpec) : "same as decision", summaries,
  loopTokens: state.loopTokens, loopSpentUsd: state.loopSpentUsd, loopSpentByProvider, priorSpentByProvider: priorSpent,
  uncostedCalls: state.uncostedCalls,
  stopReason, note: "Runs + scores only. uncostedCalls > 0 means loopSpentUsd is a lower bound. Full budget view: pnpm model:api budget",
};
writeFileSync(resolve(outDir, "loop-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
out(summary);
await client.end();
