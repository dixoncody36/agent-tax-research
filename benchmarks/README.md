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

## Suites

- `v1/` — golden tasks from verified Texas seed facts (this repo's Phase 1 data).

Public leaderboard contribution is opt-in via `config/analytics.yaml` (`mode: public`). Private runs stay private.
