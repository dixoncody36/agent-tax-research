#!/usr/bin/env node
// Benchmark scorer for agent-tax-research. Plain Node, zero dependencies.
// Grades submitted determinations offline against a versioned gold suite.
// No web fetching: citation validity is checked structurally (publisher
// type + host) against the task's sourceHint, per benchmarks/README.md.
//
// Usage:
//   node benchmarks/run.mjs <determinations.json> \
//     [--suite benchmarks/v1/tasks.json] \
//     [--out benchmarks/results.local.json]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const WEIGHTS = { accuracy: 40, citationValidity: 25, coverage: 20, efficiency: 15 };

function usage() {
  return [
    "Usage: node benchmarks/run.mjs <determinations.json> [--suite <path>] [--out <path>]",
    "  --suite  Gold suite JSON (default: benchmarks/v1/tasks.json)",
    "  --out    Results JSON to write (default: benchmarks/results.local.json)",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { determinationsPath: null, suitePath: null, outPath: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--suite") {
      if (i + 1 >= argv.length) fail("--suite requires a path");
      args.suitePath = argv[++i];
    } else if (arg === "--out") {
      if (i + 1 >= argv.length) fail("--out requires a path");
      args.outPath = argv[++i];
    } else if (arg.startsWith("--")) {
      fail(`unknown option: ${arg}\n${usage()}`);
    } else if (args.determinationsPath === null) {
      args.determinationsPath = arg;
    } else {
      fail(`unexpected extra argument: ${arg}\n${usage()}`);
    }
  }
  if (!args.determinationsPath) fail(`missing determinations file\n${usage()}`);
  return args;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    fail(`cannot read ${label} at ${path}: ${e.message}`);
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, "")); // tolerate a UTF-8 BOM
  } catch (e) {
    fail(`invalid JSON in ${label} at ${path}: ${e.message}`);
  }
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function toNonNegativeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// --- Gold comparison -------------------------------------------------------
// Gold keys ending in "Contains" (e.g. authorityContains: "151") are checked
// case-insensively against the corresponding base field in the answer
// (answer.authority), falling back to the literal gold key if present
// (answer.authorityContains). All other gold keys map to the same-named
// answer field.
function answerValueForGoldKey(answer, goldKey) {
  if (answer === null || typeof answer !== "object") return undefined;
  if (goldKey.endsWith("Contains")) {
    const baseKey = goldKey.slice(0, -"Contains".length);
    if (answer[baseKey] !== undefined) return answer[baseKey];
    return answer[goldKey];
  }
  return answer[goldKey];
}

function isAddressed(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true; // note: false and 0 are addressed values
}

function isFieldCorrect(goldKey, goldValue, answerValue) {
  if (!isAddressed(answerValue)) return false;
  if (goldKey.endsWith("Contains")) {
    return String(answerValue).toLowerCase().includes(String(goldValue).toLowerCase());
  }
  if (typeof goldValue === "number") {
    // Numeric tolerance is 0: rates and amounts must match exactly.
    if (typeof answerValue === "boolean") return false;
    const n = Number(answerValue);
    return Number.isFinite(n) && n === goldValue;
  }
  if (typeof goldValue === "boolean") {
    return answerValue === goldValue;
  }
  if (typeof goldValue === "string") {
    // confirmed_absent (and any `determination` gold) must match exactly.
    if (goldValue === "confirmed_absent" || goldKey === "determination") {
      return typeof answerValue === "string" && answerValue.trim() === goldValue;
    }
    return String(answerValue).trim().toLowerCase() === goldValue.trim().toLowerCase();
  }
  return JSON.stringify(answerValue) === JSON.stringify(goldValue);
}

function evaluateFields(gold, answer) {
  const goldKeys = Object.keys(gold ?? {});
  const fieldResults = {};
  let addressed = 0;
  let correct = 0;
  for (const key of goldKeys) {
    const value = answerValueForGoldKey(answer, key);
    const fieldAddressed = isAddressed(value);
    const fieldCorrect = isFieldCorrect(key, gold[key], value);
    if (fieldAddressed) addressed++;
    if (fieldCorrect) correct++;
    fieldResults[key] = { addressed: fieldAddressed, correct: fieldCorrect };
  }
  return {
    total: goldKeys.length,
    addressed,
    correct,
    fullyCorrect: goldKeys.length > 0 && correct === goldKeys.length,
    fieldResults,
  };
}

// --- Citation validity -----------------------------------------------------
// Valid iff at least one citation has publisherType "government" (case-
// insensitive) and a URL whose host is the task sourceHint host, ends in
// .gov, or contains "statutes". Vendor-only (or no) citations score 0.
function hasValidCitation(citations, sourceHint) {
  if (!Array.isArray(citations)) return false;
  let sourceHost = null;
  try {
    sourceHost = new URL(sourceHint).hostname.toLowerCase();
  } catch {
    sourceHost = null;
  }
  return citations.some((citation) => {
    if (citation === null || typeof citation !== "object") return false;
    if (String(citation.publisherType ?? "").trim().toLowerCase() !== "government") return false;
    let host;
    try {
      host = new URL(citation.url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (!host) return false;
    return (
      (sourceHost !== null && host === sourceHost) ||
      host.endsWith(".gov") ||
      host.includes("statutes")
    );
  });
}

// --- Efficiency ------------------------------------------------------------
// Computed only across fully-correct, non-disqualified tasks in the file.
//   ratioTokens = (tokensIn+tokensOut) / medianTokens   (1 if median is 0)
//   ratioWall   = wallSeconds / medianWall              (1 if median is 0)
//   combined    = (ratioTokens + ratioWall) / 2
//   efficiency  = 15 * min(1, 1 / combined)             (0 if not correct)
// A task at the median scores 15; one at twice the median scores 7.5;
// cheaper than the median is capped at 15 (check-first reuse is rewarded,
// not super-rewarded). Incorrect tasks score 0 efficiency.
function efficiencyScore(entry, medianTokens, medianWall) {
  if (!entry.evaluation.fullyCorrect) return 0;
  if (medianTokens === null && medianWall === null) return 0;
  const tokens = entry.tokensIn + entry.tokensOut;
  const ratioTokens = medianTokens > 0 ? tokens / medianTokens : 1;
  const ratioWall = medianWall > 0 ? entry.wallSeconds / medianWall : 1;
  const combined = (ratioTokens + ratioWall) / 2;
  if (combined <= 0) return WEIGHTS.efficiency;
  return WEIGHTS.efficiency * Math.min(1, 1 / combined);
}

// --- Main ------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  // Explicit paths resolve from the cwd; defaults resolve next to this
  // script so the scorer also works outside the repo root.
  const suitePath = args.suitePath ? resolve(args.suitePath) : resolve(scriptDir, "v1", "tasks.json");
  const outPath = args.outPath ? resolve(args.outPath) : resolve(scriptDir, "results.local.json");
  const determinationsPath = resolve(args.determinationsPath);

  const suite = readJson(suitePath, "suite file");
  if (!Array.isArray(suite.tasks)) fail(`suite file ${suitePath} has no tasks array`);
  const maxAttempts = Number.isFinite(Number(suite.maxAttempts)) ? Number(suite.maxAttempts) : 3;

  const submission = readJson(determinationsPath, "determinations file");
  if (!Array.isArray(submission.determinations)) {
    fail(`determinations file ${determinationsPath} has no determinations array`);
  }

  // Index submissions by taskId; first occurrence wins.
  const byTaskId = new Map();
  const ignoredTaskIds = [];
  const suiteIds = new Set(suite.tasks.map((t) => t.id));
  for (const det of submission.determinations) {
    const taskId = det?.taskId;
    if (typeof taskId !== "string" || !suiteIds.has(taskId) || byTaskId.has(taskId)) {
      if (typeof taskId === "string") ignoredTaskIds.push(taskId);
      continue;
    }
    byTaskId.set(taskId, det);
  }

  // First pass: evaluate fields, collect medians across correct tasks.
  const entries = suite.tasks.map((task) => {
    const det = byTaskId.get(task.id) ?? null;
    const attemptsRaw = det ? Number(det.attempts) : 0;
    const attempts = det ? (Number.isFinite(attemptsRaw) ? attemptsRaw : 1) : 0;
    const entry = {
      task,
      det,
      attempts,
      tokensIn: det ? toNonNegativeNumber(det.tokensIn) : 0,
      tokensOut: det ? toNonNegativeNumber(det.tokensOut) : 0,
      wallSeconds: det ? toNonNegativeNumber(det.wallSeconds) : 0,
      disqualified: det !== null && attempts > maxAttempts,
      evaluation: evaluateFields(task.gold, det?.answer),
      citationValid: det ? hasValidCitation(det.citations, task.sourceHint) : false,
    };
    return entry;
  });

  const correctEntries = entries.filter(
    (e) => e.det !== null && !e.disqualified && e.evaluation.fullyCorrect,
  );
  const medianTokens = median(correctEntries.map((e) => e.tokensIn + e.tokensOut));
  const medianWall = median(correctEntries.map((e) => e.wallSeconds));

  // Second pass: score.
  const results = entries.map((entry) => {
    const { task, det, evaluation } = entry;
    let reason;
    let scores;
    if (det === null) {
      reason = "missing determination";
      scores = { accuracy: 0, citationValidity: 0, coverage: 0, efficiency: 0, total: 0 };
    } else if (entry.disqualified) {
      reason = `attempts ${entry.attempts} exceeds maxAttempts ${maxAttempts}`;
      scores = { accuracy: 0, citationValidity: 0, coverage: 0, efficiency: 0, total: 0 };
    } else {
      const accuracy = evaluation.total > 0
        ? WEIGHTS.accuracy * (evaluation.correct / evaluation.total)
        : 0;
      const citationValidity = entry.citationValid ? WEIGHTS.citationValidity : 0;
      const coverage = evaluation.total > 0
        ? WEIGHTS.coverage * (evaluation.addressed / evaluation.total)
        : 0;
      const efficiency = efficiencyScore(entry, medianTokens, medianWall);
      scores = {
        accuracy: round2(accuracy),
        citationValidity: round2(citationValidity),
        coverage: round2(coverage),
        efficiency: round2(efficiency),
        total: round2(accuracy + citationValidity + coverage + efficiency),
      };
    }
    const result = {
      taskId: task.id,
      attempts: entry.attempts,
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
      wallSeconds: entry.wallSeconds,
      scores,
    };
    if (reason) result.reason = reason;
    result.details = {
      goldFields: evaluation.total,
      addressedFields: evaluation.addressed,
      correctFields: evaluation.correct,
      fieldResults: evaluation.fieldResults,
      citationValid: entry.citationValid,
    };
    return result;
  });

  const suiteAverage = results.length > 0
    ? round2(results.reduce((sum, r) => sum + r.scores.total, 0) / results.length)
    : 0;

  const output = {
    suite: suite.suite ?? "agent-tax-research-benchmarks",
    suiteVersion: suite.version ?? "v1",
    harness: submission.harness ?? "unknown",
    roleModels: submission.roleModels ?? {},
    results,
    suiteAverage,
    efficiencyMedians: { tokens: medianTokens, wallSeconds: medianWall },
  };
  if (ignoredTaskIds.length > 0) output.ignoredTaskIds = ignoredTaskIds;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");

  // Stdout summary.
  console.log(`Benchmark scorer — ${output.suite} ${output.suiteVersion} (${results.length} tasks)`);
  console.log(`Harness: ${output.harness}`);
  for (const r of results) {
    const s = r.scores;
    const line =
      `  ${r.taskId.padEnd(28)} total ${String(s.total.toFixed(2)).padStart(6)}` +
      `  (accuracy ${s.accuracy}, citation ${s.citationValidity}, coverage ${s.coverage}, efficiency ${s.efficiency})`;
    console.log(r.reason ? `${line}  [${r.reason}]` : line);
  }
  if (ignoredTaskIds.length > 0) {
    console.log(`Ignored unknown/duplicate taskIds: ${ignoredTaskIds.join(", ")}`);
  }
  console.log(`Suite average: ${suiteAverage.toFixed(2)}`);
  console.log(`Results written to ${outPath}`);
}

main();
