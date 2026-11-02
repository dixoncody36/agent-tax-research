# Hackathon demo script (issue #23)

Decision (#31): demo countries are **Mexico, then Canada, then Ireland**.
All three stay virgin (`demoHeld`) until demo time. Texas is the
already-populated showcase; the world skeleton is pre-registered.

## Setup (before the room)

```bash
docker compose up -d
pnpm install
pnpm --filter @agent-tax-research/web run build
pnpm --filter @agent-tax-research/web run start   # http://localhost:3100
pnpm tax status     # sanity: jurisdictions ~1591
```

## Beat 1 — The globe (60s)

Open http://localhost:3100 — 217 countries registered, status-colored.
US populated; Mexico/Canada/Ireland amber = held virgin for this demo.
Stats strip: verified rates, proposals awaiting a human, snapshots.

## Beat 2 — Agent-first, human-last in Texas (2 min)

`/review` queue: agent-extracted, agent-reviewed proposals (incl. the
1,202-item Texas city table) wait for one human click. Approve as
yourself → Publish. Re-run the Austin tie-out:

```sql
-- via audit pack, or CLI analytics
pnpm --filter @agent-tax-research/cli exec tsx src/audit-pack.ts us-tx
```

Austin combined = 6.25 + 1.00 + 1.00 = 8.25% from verified components,
each pinned to a SHA-256 source snapshot.

## Beat 3 — Populate a virgin country live (Mexico)

Kick off a scoped run (operator fence = Mexico only):

```bash
pnpm tax scope start --profile contexts/mexico-only.json   # create from brazil-only.json shape
```

Show the four roles working: Fetch snapshots SAT primaries → Decision
answers the country question pack (IVA etc.) → Reviewer verifies →
proposals land in `/review`. Globe point for Mexico turns blue.

## Beat 4 — The gates refuse bad work (60s)

Attempt a self-approval or an ineligible-source publish; the database
rejects it (`publish gate: verdict=pass requires an eligible source
citation`). Vendor sources (Avalara/Vertex) are noted-only, never
evidence.

## Beat 5 — Canada or Ireland as backup

If SAT is unreachable, repeat Beat 3 with Canada (GST/HST primaries),
then Ireland. Snapshot replay: any already-snapshotted source can be
re-extracted offline.

## Failure fallbacks

- Government site down → switch demo country (three held).
- No network → replay from stored snapshots; globe + review still run.
- Harness hiccup → Muse is the proven path; Claude/Codex adapters
  documented in docs/harnesses.md.
