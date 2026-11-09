# Model APIs for headless agent runs

Agent roles can run headless against three model API providers, picked per
run and per role:

| Provider | `provider:` prefix | Key env (`.env.local`) | Budget env | Cost tracking |
|---|---|---|---|---|
| Meta Model API (Muse) | `meta` | `MODEL_API_KEY` | `MUSE_BUDGET_USD` (default 150) | rate card envs `MUSE_INPUT_USD_PER_MTOK` / `MUSE_OUTPUT_USD_PER_MTOK` |
| Claude API (Anthropic) | `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BUDGET_USD` | built-in list prices per model |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_BUDGET_USD` | billed cost reported on each response |

A model spec is `provider:model`. Examples:

- `meta:muse-spark-1.3`
- `anthropic:claude-opus-5-5`, `anthropic:claude-sonnet-5-5`, `anthropic:claude-haiku-5-5`
- `openrouter:openai/gpt-5`, `openrouter:deepseek/deepseek-r1:free`

A bare model id resolves against `--provider`, which defaults to `meta`.
Code: `packages/cli/src/providers.ts`.

## 1. Keys (never commit them)

Put the keys in `.env.local` at the repo root. It is gitignored via `.env.*`.
Set only the providers you use.

```
# https://dev.meta.ai
MODEL_API_KEY=LLM|your_id|your_secret
# https://platform.claude.com
ANTHROPIC_API_KEY=sk-ant-...
# https://openrouter.ai/keys
OPENROUTER_API_KEY=sk-or-...
# Optional: used when a run names openrouter but no model
OPENROUTER_DEFAULT_MODEL=openai/gpt-5
# Optional per-provider spend ceilings (USD; 0 blocks paid calls)
ANTHROPIC_BUDGET_USD=50
OPENROUTER_BUDGET_USD=25
```

The loader reads whole values, so comments go on their own lines, never
after a value. `.env.local` overrides `.env`, and real environment
variables override both. A malformed budget or rate is an error before any
call, never silently ignored.

`pnpm model:api models` shows which keys are configured, each provider's
default model and rate card, and its budget.

## 2. Single calls — `pnpm model:api`

```bash
pnpm model:api ping --provider anthropic                     # one tiny call
pnpm model:api complete --role reviewer --model anthropic:claude-sonnet-5-5 --prompt-file p.txt
pnpm model:api complete --model openrouter:openai/gpt-5 --prompt "..." --max-tokens 800
pnpm model:api budget [--provider openrouter]                # runs, tokens, spend vs budget
```

`pnpm muse:api` runs the same command with `meta` as the default provider.

## 3. Benchmark runs across models — `pnpm model:loop`

Each `--models` entry is one comparison arm. It runs Decision and Reviewer
over the fixed suite (`benchmarks/v1/tasks.json`), and `benchmarks/run.mjs`
scores the results.

```bash
pnpm model:loop --dry-run --models anthropic:claude-opus-5-5,openrouter:openai/gpt-5
pnpm model:loop --cap-usd 10 --models anthropic:claude-opus-5-5,anthropic:claude-sonnet-5-5,openrouter:openai/gpt-5
pnpm model:loop --cap-usd 5 --models anthropic:claude-haiku-5-5 --reviewer anthropic:claude-opus-5-5
pnpm model:loop --cap-tokens 500000 --models muse-spark-1.3      # no Muse rate card set
```

- `--reviewer <spec>` gives every arm one shared reviewer model. Without it,
  each arm reviews with its own decision model, still as a separate run
  identity.
- `--effort low|medium|high|xhigh|max` applies to Claude models (default
  `high`).
- Uncapped loops are refused. `--cap-usd` needs every model to be
  cost-tracked (see the table above); otherwise use `--cap-tokens`.
- Results go to `benchmarks/runs/<stamp>/`, one determinations file and one
  results file per round and arm, plus `loop-summary.json` with spend per
  provider.

`pnpm muse:loop` is the same loop.

## Recording and gates

Every call writes an `agent_runs` row with `role`, the model that served it,
tokens, `cost_usd`, and `datavalues.provider`, so `pnpm tax analytics` and
`pnpm model:api budget` show spend next to harness runs. Each provider's
budget is checked before every call against that provider's recorded spend,
re-read each time so other runners' spend counts too. A call that fails
after it was sent is recorded as `failed` with `usageUnknown`, and the
budget report counts those as `uncostedRuns`, so reported spend is a lower
bound whenever that count is above zero. Under `--cap-usd`, a response
without a cost stops the loop.

In the loop, a task scores only with a reviewer `pass`. A task that uses up
its attempts is recorded as `failed` with an empty answer. When a cap stops
the loop, the arm it was on is still written and scored, marked
`incomplete`.

A model-API run is a distinct run identity for the publish gates, like any
harness run. These runners write runs and benchmark results only: they
create no proposals and publish nothing, and the human approver is still
last.

## Provider notes

- **Meta** Chat Completions does not support `stop`, `n>1`, or
  `logit_bias`, so the runner sends only `model`, `messages`, and
  `max_tokens`.
- **Claude API** calls use the official `@anthropic-ai/sdk`. Current Claude
  models always think, so `max_tokens` defaults to 16,000 for Claude, and a
  lower explicit `--max-tokens` is rejected, because thinking could use up
  the whole answer. You are billed for tokens generated, not for the
  ceiling. Opus 5.5, Opus 5, Sonnet 5.5 and Fable 5.1
  send server-side refusal fallbacks (`fallbacks: "default"`), and the run
  records the model that actually served the turn. A refusal returns no
  content and is recorded with `stopReason: "refusal"`.
- **OpenRouter** is OpenAI-compatible. The runner asks for
  `usage.include`, so each response carries its billed cost in USD.

## Role guidance

- Orchestrator and Decision are judgment-heavy and low volume. Use a strong
  model (`anthropic:claude-opus-5-5`) or keep them on the harness.
- Fetch triage and Reviewer second opinions are high volume. Use cheaper
  models (`anthropic:claude-haiku-5-5`, `meta:muse-spark-1.3`, or an
  OpenRouter model). For independence, pick a reviewer from a different
  model family than the decision model.
- Role-to-model defaults live in `config/models.yaml`.
