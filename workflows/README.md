# Muse Workflows — Kickoff & Orchestration

## Kickoff (goal-driven)

1. Operator states the ask in plain language ("collect and monitor Texas", "populate Brazil sales taxes").
2. Orchestrator (Wonder) resolves/creates the context profile, runs `pnpm tax scope start --profile contexts/<name>.json --goal-ref <session-goal>`, and creates a Muse **session goal** whose objective is the compiled scope.
3. Orchestrator enqueues structure-first assignments (`tax work enqueue`) and dispatches Fetch → Decision → Reviewer runs (subagents/workflow lanes), each taking work via `tax work next --role <role>`, claiming, and submitting with metrics + handoff notes.
4. Progress = database state: `tax scope status`, `tax analytics`, ledger coverage. The goal completes when no agent work remains; human approvals pending are reported separately (human is last, never the bottleneck for agent completion).
5. Watchdog: 3-attempt cap per assignment; failures surface as failed runs + exceptions for the orchestrator, never silent loops.

## Lane discipline (parallel runs)

- One file-ownership partition per lane; shared files (schema, CLI entry) change only in the owning lane.
- Conductor lands lanes serially: migrate → typecheck → CLI verification → commit per issue.
- Workers never push milestone branches directly in loop mode; the conductor session commits and closes issues.
