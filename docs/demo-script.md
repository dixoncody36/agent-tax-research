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
pnpm tax status     # sanity: jurisdictions ~2297, taxRates 1866
```

## Beat 1 — The globe (60s)

Open http://localhost:3100 (if an old dev server holds 3100, restart it so tonight's web commits load) — 217 countries registered, status-colored.
US populated; Mexico/Canada/Ireland amber = held virgin for this demo.
Stats strip: verified rates, proposals awaiting a human, snapshots.

## Beat 2 — Agent-first, human-last in Texas (2 min)

`/review` queue: agent-extracted, agent-reviewed proposals (incl. the
1,173-item regenerated Texas city table (plus 6 verified geo proposals: 1,481 Census boundaries)) wait for one human click. Approve as
yourself → Publish. Re-run the Austin tie-out:

```sql
-- via audit pack, or CLI analytics
pnpm --filter @agent-tax-research/cli exec tsx src/audit-pack.ts us-tx
```

Austin combined = 6.25 + 1.00 + 1.00 = 8.25% from verified components,
each pinned to a SHA-256 source snapshot.

## Beat 2b — Point to rate: where is 30.2672, -97.7431 taxed? (90s, M8)

Same globe: type the downtown Austin lat/long (or click the globe on
Austin). The cascade resolves from **published Census boundaries**:
Texas → Travis County → Austin → combined rate, each boundary pinned
to a geometry hash in the audit pack (`geo-fixtures.csv`).

```bash
pnpm tax rate at-point --lat 30.2672 --lng -97.7431 --tax-type us-tx-sales-use
```

Honesty beat worth saying out loud: if a transit/SPD boundary is not
published by any government GIS, the answer says **PARTIAL** and names
the undecided component — the platform never presents a floor as the
final rate. Districts with no published polygon are `confirmed_absent`
with the search trail recorded (519 tonight), not hand-drawn.

Fallback if geo approval has not happened yet: `/review` shows the six
verified geo proposals (1,481 boundaries); approve + publish live —
that *is* the human-last beat — then re-run the lookup.

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
