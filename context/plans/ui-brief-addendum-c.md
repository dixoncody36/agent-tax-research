## Addendum C — agent transparency + competition surfaces (operator request)

Build after Addendum B, same worktree/branch, additional commits. Read-only. Never fabricate values: fields that were not recorded render as "not recorded".

### C1. Agent activity — see what every scan did
- New route: /agents. Table of agent_runs: role, model, unit, jurisdiction, status, attempt, tokens in/out, cost, started/finished. Sortable by time (values, not strings); filter by role/jurisdiction/status.
- Click a run → detail: full handoff_notes, linked proposal (extractor/verifier linkage) and its status/verdict, research_ledger determinations touched (question, determination, snapshot hash, validation state), evidence sources referenced.
- In the Explorer jurisdiction detail (Addendum B1), add an "Agent activity" section: every run that touched that jurisdiction, chronological — the scan history of the place.
- New read APIs: GET /api/agents/runs (filters: role, jurisdiction, status), GET /api/agents/runs/detail?id=<uuid>.
- Known data reality (render honestly): model and token fields are sparse on historical harness runs; prompts are not persisted anywhere today — do not invent prompt text. Show unit + handoff notes + proposal payloads as the recorded analysis trail.

### C2. Competition — which agent/harness researches best
- New route: /benchmarks. Two blocks:
  1. Live leaderboard from agent_runs grouped by model (+ datavalues provider/harness when present) per role: runs, completed %, verified-proposal rate (proposals where the run was extractor and status reached verified/published), attempts, tokens, cost, median wall time. Unknown model groups under "not recorded".
  2. Benchmark suite results: read the shape from benchmarks/results.example.json and benchmarks/v1/tasks.json; if real result files exist render the latest (per-task pass/fail by model/harness), else show the suite description + "no recorded results yet" empty state.
- New read API: GET /api/agents/leaderboard.
- Nav gains: Agents, Benchmarks.
- New testids: agents-table, agent-run-detail, leaderboard-table.

### C3. Out of scope here (flag in your final report, do not build)
- Persisting prompt text / context-pack hash / model on agent_runs at submit time is a CLI change owned by another lane. Your surfaces simply expose what is recorded.

Commits: feat(web): agent activity transparency views / feat(web): agent leaderboard and benchmark results. Typecheck + production build + port 3102 verification after each; push each. The whole brief (restyle + B + C) still ends with the sentinel: UI dash REDESIGNED (word dash spelled out).
