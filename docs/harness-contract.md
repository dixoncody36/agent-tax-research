# Harness Contract — `tax` CLI (v1)

The single harness-neutral interface. Every command prints JSON. No agent writes SQL directly. See `AGENTS.md` for roles and hard rules.

## Commands

| Command | Purpose |
|---|---|
| `pnpm tax status` | Table counts, ledger status, roles |
| `pnpm tax analytics` | Token/cost/time rollups by role and jurisdiction (private by default) |
| `pnpm tax ledger check --jurisdiction <slug>` | **Check-first**: reusable validated determinations + recent handoff notes |
| `pnpm tax context compile --profile contexts/<name>.json [--save]` | Compile operator context to an explicit scope (ancestors always included) |
| `pnpm tax scope start --profile contexts/<name>.json [--goal-ref <ref>]` | Compile + persist an active `scope_runs` row; returns `scopeRunId` |
| `pnpm tax scope status --id <uuid>` | Scope + run counts by role/status |
| `pnpm tax work enqueue --scope <uuid> --role <role> --jurisdiction <slug> [--tax-type <slug>] [--unit <unit>] [--model <id>]` | Queue an assignment; rejects jurisdictions outside the compiled fence (`outside_context_fence`) |
| `pnpm tax work next --role <role> [--scope <uuid>]` | Oldest queued assignment envelope for the role (does not claim) |
| `pnpm tax work claim --id <uuid>` | queued → running (attempt cap enforced) |
| `pnpm tax work submit --id <uuid> --status completed\|failed [--notes ...] [--tokens-in N] [--tokens-out N] [--cost-usd X]` | Record result + metrics + handoff notes |
| `pnpm tax work retry --id <uuid>` | Failed run → next attempt (max 3 total; then `attempt_cap_exceeded`, orchestrator notified via status) |
| `pnpm tax work run --role <role> [--scope <uuid>] [--model provider:model]` or `--id <uuid>` | Headless worker: claim the next queued assignment (or one by id), run its role handler on a model API, record usage + handoff notes + `run_events`; failures raise typed exceptions |
| `pnpm tax work run --loop --scope <uuid> (--cap-usd N \| --cap-tokens N) [--fetch-model …] [--decision-model …] [--reviewer-model …]` | Drain a scope: Fetch → Decision → Reviewer chained, caps checked per assignment, restart-safe; ends with an orchestrator run |
| `pnpm tax review list` | Determinations awaiting review (proposal queue arrives with the proposals schema) |

## Assignment envelope (v1)

```json
{ "assignment": { "v": 1, "assignmentId": "uuid", "scopeRunId": "uuid",
  "role": "fetch", "unit": "discover", "jurisdiction": "us-tx",
  "taxType": "us-tx-sales-use", "attempt": 1, "maxAttempts": 3,
  "model": null, "contextPacks": [], "instructions": ["..."] } }
```

`contextPacks` is populated by jurisdiction context hooks (decree p1.t6 / issue #6).

## Result envelope (v1)

```json
{ "result": { "v": 1, "assignmentId": "uuid", "status": "completed",
  "attempt": 1, "notifyOrchestrator": false, "instruction": "..." } }
```

Errors: `{ "error": "<code>", ... }` with process exit code 2. Codes include `outside_context_fence`, `unknown_jurisdiction`, `attempt_cap_exceeded`, `scope_not_found`, `assignment_not_found`.

## Headless worker (model APIs)

`tax work run` executes assignments without a harness session, on any
`provider:model` from `docs/model-apis.md`. The model is chosen as `--model`,
then the assignment's own model, then the `config/models.yaml` role slot;
`harness` slots refuse rather than guess. Handlers by role:

| Role | Does | Never does |
|---|---|---|
| fetch | Snapshots registered eligible sources; `noted_only`/`prohibited` are never requested; a changed hash invalidates validated ledger rows (`source_changed`); unit `extract` adds verbatim-backed candidate values | Discover sources by search, judge truth |
| decision | Answers `unknown` coverage questions from stored snapshots; a `found` needs an excerpt verbatim in the cited snapshot; files one proposal + pending ledger rows | Answer `confirmed_absent`, re-ask validated or in-review questions |
| reviewer | Re-reads each cited snapshot; code checks (pinned hash, verbatim excerpt, eligible source) fail an item regardless of the model; sets verdicts, proposal → `verified` or `rejected` | Review its own run's proposal, approve, publish |

Nothing a worker writes is published: verified proposals wait in `/review`
for a human, and `tax proposal publish` applies only `pass` items.
