// Pure logic for the model-API benchmark loop (model-loop.ts). No I/O here:
// evidence cleanup, prompt construction, model-JSON extraction, spend caps,
// and determination assembly — all unit-tested in muse-loop-lib.test.ts.

export type BenchTask = {
  id: string;
  jurisdiction: string;
  category: string;
  prompt: string;
  sourceHint: string;
};

// The union answer schema every decision call must fill (subset per task).
// Field names match benchmarks/run.mjs gold mapping; unanswered fields are
// omitted so scorer coverage reflects what the model actually addressed.
export const ANSWER_FIELDS = [
  "rateValue", "rateUnit", "authority", "appliesTo",
  "combinedMaxPercent", "localCapPercent", "thresholdUsdPerDay",
  "determination", "kind", "ircConformedIncomeTax", "collectors",
] as const;
export type AnswerField = (typeof ANSWER_FIELDS)[number];
export type Answer = Partial<Record<AnswerField, unknown>>;

export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateEvidence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[evidence truncated at ${maxChars} chars]`;
}

export function buildDecisionPrompt(task: BenchTask, evidence: string): string {
  return [
    "You are the Decision agent in a four-role tax-research system.",
    "Answer using ONLY the government-source evidence below. Do not use outside knowledge.",
    "If the evidence does not establish a field, omit that field.",
    "For an absence question: determination must be exactly \"found\" or \"confirmed_absent\" —",
    "use confirmed_absent only if the evidence is an authority index that would list the tax and does not.",
    "",
    `Task (${task.jurisdiction}, ${task.category}): ${task.prompt}`,
    "",
    "Reply with ONLY a JSON object using any subset of these fields (no prose, no markdown fences):",
    `  ${ANSWER_FIELDS.join(", ")}`,
    "Numbers as numbers (percent-points: 6.25 means 6.25%). authority = the statute/code citation text.",
    "",
    `Evidence (fetched from ${task.sourceHint}):`,
    evidence,
  ].join("\n");
}

export function buildReviewerPrompt(task: BenchTask, evidence: string, answer: Answer): string {
  return [
    "You are the Reviewer agent: an independent second reader. You did NOT write the determination below.",
    "Re-read the evidence and check every field of the determination against it.",
    "Reply with ONLY a JSON object (no prose, no markdown fences):",
    '  {"verdict": "pass"|"fail", "corrections": {<field>: <corrected value>, ...}, "reason": "<one line>"}',
    "Use pass only if every present field is supported by the evidence and no asked field is missing.",
    "On fail, put corrected values (from the evidence only) in corrections; omit fields the evidence cannot fix.",
    "",
    `Task: ${task.prompt}`,
    "",
    `Determination under review: ${JSON.stringify(answer)}`,
    "",
    `Evidence (fetched from ${task.sourceHint}):`,
    evidence,
  ].join("\n");
}

// Extract the first JSON object from a model reply. Tolerates markdown
// fences and surrounding prose; returns null when nothing parses.
export function extractJsonObject(reply: string | null | undefined): Record<string, unknown> | null {
  if (!reply) return null;
  const text = reply.replace(/```(?:json)?/gi, " ");
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function sanitizeAnswer(raw: Record<string, unknown> | null): Answer {
  const out: Answer = {};
  if (!raw) return out;
  for (const field of ANSWER_FIELDS) {
    const v = raw[field];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[field] = v;
  }
  return out;
}

export type Review = { verdict: "pass" | "fail"; corrections: Answer; reason: string };

export function sanitizeReview(raw: Record<string, unknown> | null): Review {
  const verdict = raw?.verdict === "pass" ? "pass" : "fail";
  const correctionsRaw =
    raw?.corrections !== null && typeof raw?.corrections === "object" && !Array.isArray(raw?.corrections)
      ? (raw.corrections as Record<string, unknown>)
      : null;
  return {
    verdict,
    corrections: sanitizeAnswer(correctionsRaw),
    reason: typeof raw?.reason === "string" ? raw.reason.slice(0, 300) : "",
  };
}

// Spend gate, checked BEFORE every API call. Dollar caps only bite when a
// rate card (or provider-reported cost) produced costed figures; token caps
// always bite. Budgets are per provider: priorSpentUsd is that provider's
// recorded spend before this loop and providerLoopSpentUsd its spend inside
// the loop (falls back to loopSpentUsd for single-provider callers). The
// loop dollar cap (--cap-usd) counts every provider together.
export type CapState = {
  priorSpentUsd: number | null;
  providerLoopSpentUsd?: number | null;
  loopSpentUsd: number | null; // null until any costed call in this loop
  loopTokens: number;
};
export type CapConfig = { budgetUsd: number | null; budgetLabel?: string; capUsd: number | null; capTokens: number | null };

export function capDecision(state: CapState, cfg: CapConfig): { stop: boolean; reason: string | null } {
  const providerLoop = state.providerLoopSpentUsd !== undefined ? state.providerLoopSpentUsd : state.loopSpentUsd;
  const totalUsd =
    state.priorSpentUsd === null && providerLoop === null
      ? null
      : (state.priorSpentUsd ?? 0) + (providerLoop ?? 0);
  if (cfg.budgetUsd !== null && totalUsd !== null && totalUsd >= cfg.budgetUsd) {
    return { stop: true, reason: `${cfg.budgetLabel ?? "MUSE_BUDGET_USD"} reached ($${totalUsd.toFixed(4)} >= $${cfg.budgetUsd})` };
  }
  if (cfg.capUsd !== null && state.loopSpentUsd !== null && state.loopSpentUsd >= cfg.capUsd) {
    return { stop: true, reason: `loop cap reached ($${state.loopSpentUsd.toFixed(4)} >= --cap-usd $${cfg.capUsd})` };
  }
  if (cfg.capTokens !== null && state.loopTokens >= cfg.capTokens) {
    return { stop: true, reason: `token cap reached (${state.loopTokens} >= --cap-tokens ${cfg.capTokens})` };
  }
  return { stop: false, reason: null };
}

export type Determination = {
  taskId: string;
  answer: Answer;
  citations: { url: string; publisherType: "government" }[];
  attempts: number;
  tokensIn: number;
  tokensOut: number;
  wallSeconds: number;
};

export function toDetermination(
  task: BenchTask,
  answer: Answer,
  usage: { tokensIn: number; tokensOut: number; wallSeconds: number; attempts: number },
): Determination {
  return {
    taskId: task.id,
    answer,
    citations: [{ url: task.sourceHint, publisherType: "government" }],
    attempts: usage.attempts,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    wallSeconds: Math.round(usage.wallSeconds * 100) / 100,
  };
}
