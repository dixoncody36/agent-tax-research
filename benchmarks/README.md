# Benchmarks — Agentic Tax Research Suite

Fixed, versioned tasks any model or harness can run through the four roles
(Orchestrator / Fetch / Decision / Reviewer) to produce a comparable score.
Built for cross-vendor competition: Muse, Anthropic, Google, Microsoft, and
any other harness run identical tasks against identical golden ground truth.

## Rules of the game

- Primary government sources only (vendor content is ineligible evidence and scores 0 for citation validity).
- Max **3 attempts** per task; a 3rd failure is a failed task.
- Check-first applies: reusing a validated ledger determination is legal and *rewarded* by the efficiency component.
- Every determination must carry a citation the scorer can verify against the snapshot.

## Scoring (0–100 per task, published rubric)

| Component | Weight | Measures |
|---|---|---|
| Accuracy | 40 | Determination matches gold (exact rate/value or correct absence) |
| Citation validity | 25 | Cited eligible primary actually supports the claim |
| Coverage | 20 | All asked questions answered: found / confirmed_absent / honestly unknown |
| Efficiency | 15 | Tokens + wall time per correct determination vs suite median |

Results record: harness, per-role models, suite version, tokens, durations, attempts, per-component scores. See `results.example.json`.

## Running the scorer

The scorer is plain Node with zero dependencies. It grades submitted determinations **offline** — it never fetches the web; citation validity is checked structurally (see below).

```sh
node benchmarks/run.mjs <determinations.json> [--suite benchmarks/v1/tasks.json] [--out benchmarks/results.local.json]
```

- Defaults: `--suite benchmarks/v1/tasks.json`, `--out benchmarks/results.local.json` (resolved next to `run.mjs` when omitted; explicit paths resolve from the working directory).
- Output: a results JSON shaped like `results.example.json`, plus `suiteAverage` (mean of per-task totals over **all** suite tasks) and per-task `details`. A per-task summary and the suite average are also printed to stdout.
- Try it: `node benchmarks/run.mjs benchmarks/v1/sample-determinations.json` (all correct) and `node benchmarks/run.mjs benchmarks/v1/sample-flawed.json` (vendor citation, wrong rate, and an over-attempts task, each penalized).

### Input format (determinations file)

```json
{
  "harness": "muse-code",
  "roleModels": { "orchestrator": "...", "fetch": "...", "decision": "...", "reviewer": "..." },
  "determinations": [
    {
      "taskId": "tx-sales-state-rate",
      "answer": { "rateValue": 6.25, "rateUnit": "percent", "authority": "Texas Tax Code Chapter 151" },
      "citations": [{ "url": "https://comptroller.texas.gov/taxes/sales/", "publisherType": "government" }],
      "attempts": 1,
      "tokensIn": 1200,
      "tokensOut": 300,
      "wallSeconds": 40
    }
  ]
}
```

`answer` fields are gold-shaped: use the gold key names from the suite's `tasks.json`. For a gold key ending in `Contains` (e.g. `authorityContains: "151"`, `kindContains: "privilege"`), supply the base field (`authority`, `kind`) with a value containing that text; supplying the literal `*Contains` key is also accepted.

### How each component is scored

- **Accuracy (40):** `40 × (correct gold fields / total gold fields)`. Numbers must match exactly (tolerance 0, so rates are exact); booleans must match strictly; `*Contains` fields match case-insensitively as a substring of the base answer field; a `confirmed_absent` determination must match exactly. Other strings compare case-insensitively after trimming.
- **Citation validity (25):** 25 iff at least one citation has `publisherType: "government"` and a URL host that equals the task `sourceHint` host, ends in `.gov`, or contains `statutes`. Vendor-only or missing citations score 0.
- **Coverage (20):** `20 × (addressed gold fields / total gold fields)`. A field is addressed when the corresponding answer field is present and non-empty (`false` and `0` count as addressed).
- **Efficiency (15):** scored only for fully correct, non-disqualified tasks, against the medians of that same group **within the submitted file**:
  - `ratioTokens = (tokensIn + tokensOut) / medianTokens` (1 when the median is 0)
  - `ratioWall = wallSeconds / medianWall` (1 when the median is 0)
  - `combined = (ratioTokens + ratioWall) / 2`
  - `efficiency = 15 × min(1, 1 / combined)`
  - A task at the median scores 15; one at twice the median scores 7.5; cheaper than the median is capped at 15 (check-first reuse is rewarded, not super-rewarded). Incorrect tasks score 0 efficiency. The medians used are recorded in the output as `efficiencyMedians`.
- **Disqualification and gaps:** `attempts > maxAttempts` (suite value, 3 in v1) makes the task total 0 with a `reason` recorded, regardless of the answer. A suite task with no submitted determination scores 0 with reason `missing determination`. Unknown or duplicate `taskId`s are ignored and listed under `ignoredTaskIds`. Component scores and totals are rounded to 2 decimals.

## Suites

- `v1/` — golden tasks from verified Texas seed facts (this repo's Phase 1 data).

Public leaderboard contribution is opt-in via `config/analytics.yaml` (`mode: public`). Private runs stay private.
