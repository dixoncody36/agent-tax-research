# Harness Setup Notes

One codebase, any agent harness. The contract is `AGENTS.md` + the `tax` CLI (`docs/harness-contract.md`). Adapters below are intentionally thin — if a note here ever conflicts with `AGENTS.md`, `AGENTS.md` wins.

## All harnesses

```powershell
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm tax status          # sanity: counts + roles
```

Pick/create a context profile (`contexts/*.json`), assign role models in `config/models.yaml`, then kick off: `pnpm tax scope start --profile contexts/texas-only.json`.

## Muse (first-class, hackathon primary)

- Orchestrator runs as Wonder conducting; kickoff creates a session **goal** from the scope (see `workflows/README.md`) and reports progress from DB state (`tax scope status`, `tax analytics`).
- Fetch/Decision/Reviewer run as subagents or workflow lanes with fresh minimal contexts: AGENTS.md + role file + one assignment envelope (`tax work next`).
- Parallel lanes: strict file ownership per lane, serialized landing by the orchestrator session.

## Muse

- `CLAUDE.md` points at `AGENTS.md`. Same CLI, same envelopes. Role models map via `config/models.yaml` (`provider: harness`).

## Codex / Grok / OpenCode

- Read `AGENTS.md` natively. No adapter files needed beyond pointing the harness at the repo root. All state transitions go through `pnpm tax ...`.

## Herdr (Windows terminal/orchestration surface)

- Lanes/panes are an optional operator surface for watching parallel runs; never required. The database + GitHub issues remain the canonical state if Herdr is absent.

## Headless (Azure AI Foundry API runner)

- Set role slots to `provider: foundry` in `config/models.yaml` and provide `AZURE_AI_FOUNDRY_*` env vars (see `.env.example`). The runner consumes/produces the identical assignment/result envelopes; no interactive harness involved.
