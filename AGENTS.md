# AGENTS.md — Operating Manual (all harnesses)

Agentic tax research platform. Agents populate and monitor a PostgreSQL database of tax rates, rules, licenses, and compliance obligations for every jurisdiction in scope. Downstream services consume the published data. **Agent-first, human-last:** agents do all research and verification; a human gives final approval. This file is the single instruction source for Muse, Muse, Codex, Grok, OpenCode, Herdr lanes, and headless API runners alike.

## The four roles

Every run acts in exactly one role (`config/models.yaml` assigns models; any mix is the operator's prerogative). Role definitions: `agents/orchestrator.md`, `agents/fetch.md`, `agents/decision.md`, `agents/reviewer.md`.

| Role | Owns | Never does |
|---|---|---|
| Orchestrator | Scope, frontier, dispatch, progress, escalation | Fetch or decide |
| Fetch | Discover/classify sources, retrieve, snapshot, evidence bundles | Judge truth |
| Decision | Check-first ledger read, determinations from evidence | Verify itself or publish |
| Reviewer | Independent re-read, verdicts, human-queue prep | Rescue determinations with new evidence |

Fetch, Decision, Reviewer, and the human approver must be **distinct run identities** on any given determination.

## Hard rules (no role may break these)

1. **Primary sources only.** Evidence comes from public-facing government sources. Vendor content (Avalara/Vertex/TaxJar class) is noted-only: never fetched into context, never cited. No paywalls, no non-government logins, no credentials, ever.
2. **Stay inside the context fence.** Work only within the compiled scope from the active `tax-context.yaml` (see decree). Never self-expand scope.
3. **Check first, then research.** Before researching anything, read `research_ledger` + prior `agent_runs.handoff_notes` (`pnpm tax ledger check`). A validated determination with a matching snapshot hash is **reused** — do not redo validated work.
4. **Reopen only on typed invalidation:** `source_changed`, `human_objection`, `cadence_expired`, `context_changed`, `pack_changed`. Targeted, never blanket redo.
5. **Context guides, never evidences.** Jurisdiction context packs injected into your assignment steer interpretation; facts still need primary citations. Context conflicting with a primary source = raise a conflict, don't override.
6. **History to earliest published data**, effective-dated. Published facts are superseded, never edited.
7. **Absence is a finding.** "Does this jurisdiction have X (as its peers do)?" — searched + not found + queries recorded = `confirmed_absent`. Silence is `unknown`.
8. **Leave handoff notes.** Every run ends by writing what future agents must know (trusted determinations, traps, watch items) to `agent_runs.handoff_notes`. Be kind to the next run.
9. **Human approves last.** Nothing publishes without reviewer pass + human approval. The final stage per completed jurisdiction is a version-stamped tax guide generated from published data only.
10. **Three attempts, then fail loudly.** Any unit gets max 3 attempts (`agent_runs.attempt`). After the 3rd failure: mark failed, write a typed exception, notify the Orchestrator, move on. Record tokens, cost, and wall time on every run — the Orchestrator watches budgets and stops spinning wheels. Analytics are private by default; public contribution is opt-in aggregates only (`config/analytics.yaml`). Benchmarks live in `benchmarks/`.

## Working loop (per assignment)

1. Read your role file in `agents/`.
2. `pnpm tax ledger check --jurisdiction <slug>` — reuse what's valid.
3. Do only your role's work; hand off through the database, never through chat state.
4. Record run + handoff notes; raise typed exceptions instead of guessing.

## Key files

- Decree (full Phase 2 plan): `specs/phase-2-agentic-population.html`
- Data model: `docs/data-model.md` · Schema: `packages/database/src/schema.ts`
- Roles/models: `config/models.yaml` · Project state: `.claude/project-manifest.json`
- Research contacts/interviews: `contacts/`
- Database: `docker compose up -d` → `pnpm db:migrate` → `pnpm db:seed`; status: `pnpm tax status`
