# Muse API setup (Meta Model API)

This repo's hackathon provider. The Muse models are served by the
**Meta Model API** — OpenAI-compatible at `https://api.meta.ai/v1`
(`POST /chat/completions`), Anthropic-compatible Messages also
available. Models: `muse-spark-1.3` (recommended), `muse-spark-1.2`,
`muse-spark-1.1`.

## 1. Get a key

1. Go to https://dev.meta.ai (Meta Developer Console) → Model API.
2. Create an API key. Format: `LLM|<numeric_id>|<secret>`.
3. The hackathon credit ($150) attaches to that account.

## 2. Configure (never commit the key)

Create `.env.local` in the repo root (gitignored via `.env.*`):

```
MODEL_API_KEY=LLM|your_id|your_secret
MUSE_BUDGET_USD=150
# optional, from your console rate card (USD per 1M tokens):
MUSE_INPUT_USD_PER_MTOK=
MUSE_OUTPUT_USD_PER_MTOK=
```

## 3. Verify + use

```bash
pnpm muse:api ping            # one tiny call; records an agent_run
pnpm muse:api budget          # runs, tokens, spend vs MUSE_BUDGET_USD
pnpm muse:api complete --role reviewer --prompt "…" [--model muse-spark-1.3]
```

Every call writes an `agent_runs` row (`datavalues.provider = meta`)
with token counts and — when the rate-card envs are set — `cost_usd`,
so `pnpm tax analytics` and `pnpm muse:api budget` show Muse spend
next to harness runs. `complete` refuses new calls once recorded
spend reaches `MUSE_BUDGET_USD`.

## Role guidance under a fixed credit

- Orchestrator/Decision: stay on the harness (Muse session) —
  judgment-heavy, low volume.
- Fetch triage + Reviewer second-opinion: good Muse Spark slots
  (see the commented mix in `config/models.yaml`).
- Publish gates unchanged: a Muse-API reviewer run is a distinct run
  identity, but the human approver is still last.

## Notes

- Chat Completions on this API does not support `stop`, `n>1`, or
  `logit_bias`; the runner sends only `model`, `messages`, `max_tokens`.
- No key in `.env.local` → `ping`/`complete` exit with setup
  instructions; `budget` still reports recorded runs.
