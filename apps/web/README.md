# Web UI — Globe + Human Review (M6)

Next.js app: jurisdictional globe by verification status, live agent
activity feed, and the human review queue (approve/publish).

## Run

```bash
docker compose up -d                 # database (repo root)
pnpm install
pnpm --filter @agent-tax-research/web run build
pnpm --filter @agent-tax-research/web run start   # http://localhost:3100
```

Dev mode: `pnpm --filter @agent-tax-research/web run dev`.

## Rules

- The web layer is read-only against the database. Approve/publish
  actions shell out to the `tax` CLI (the single writer path), so the
  DB publish gates (eligible sources; distinct extractor, verifier,
  approver) apply unchanged.
- Globe markers sit at capital coordinates stored in
  `jurisdictions.datavalues` by `packages/cli/src/register-world.ts`.
  Color = aggregate verification state from live proposal/type data;
  amber = `demoHeld` (mx/ca/ie stay virgin until the demo).
- The activity feed polls every 5s; there is no websocket yet.
