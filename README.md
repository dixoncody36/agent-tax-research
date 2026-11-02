# agent-tax-research

Agentic tax research for every jurisdiction on the globe.

## Vision

An agentic tax research platform covering every tax jurisdiction on the planet. Agents gather, collect, structure, and continuously monitor tax rates and rules worldwide — so the data stays current without a human having to watch every tax authority, gazette, and legislature by hand.

Humans set direction, supply expertise, and audit the output. Agents do the collection, monitoring, and first-pass structuring at global scale.

## What the platform will do

1. **Gather** — Discover authoritative sources for each jurisdiction and tax type: statutes, regulations, official guidance, rate tables, and change announcements.
2. **Collect** — Extract tax rates and rules into structured, comparable records: what the rate or rule is, who it applies to, and the period it is effective for.
3. **Cite** — Attach every rate and rule to its authority (law, regulation, or official publication) so any figure can be traced back to its source and re-checked.
4. **Monitor** — Watch those sources for changes — new rates, amended rules, new thresholds, repealed provisions — and flag what changed, when it takes effect, and what it affects.
5. **Review** — Route extracted and changed items through human review where confidence is low, sources conflict, or the change is material. Agents propose; accountable humans approve what becomes trusted data.

## Scope

**Jurisdictions.** National, subnational (state, province, canton, region), and local (city, county, municipality) jurisdictions, plus special regimes and zones where they set their own rates or rules. The target is every jurisdiction on the planet; coverage will be built out in phases and tracked explicitly, so "not yet covered" is always distinguishable from "covered and current."

**Tax types.** The full landscape, phased by research priority:

- Corporate and personal income tax
- VAT / GST / sales and use tax
- Withholding taxes and treaty rates
- Payroll and social contribution taxes
- Excise, customs, and import duties
- Property, transfer, and stamp taxes
- Digital services and other sector-specific levies
- Registration, filing, and threshold rules that determine who a tax applies to

**Per rate or rule, the platform aims to record:** jurisdiction, tax type, rate or rule text, taxpayer / transaction scope, thresholds and exemptions, effective-from and effective-to dates, authority and citation, source location, and change history.

## Principles

- **Source-backed, always.** No rate or rule without a citation to an authoritative source. Unverified or interview-sourced claims stay marked as unverified until confirmed.
- **Effective-dated, never overwritten.** Rates and rules change over time. History is preserved so a past period can be answered as it stood then, not as it stands now.
- **Agents operate, humans audit.** Automation is the default path for gathering and monitoring. Human review is the control for accuracy, not the bottleneck for coverage.
- **Coverage is explicit.** The platform states which jurisdictions and tax types it covers, how fresh each one is, and where the gaps are.
- **Research aid, not tax advice.** Output supports professional research. It does not replace qualified advice on a specific taxpayer's facts.

## Delivery phases

| Phase | Status | What it delivers |
|---|---|---|
| 0 — Research | In progress | Contacts and interviews in [`contacts/`](contacts/); source discovery per jurisdiction. |
| 1 — Data model | **Built** | Containerized PostgreSQL + pgvector schema housing all tax detail, seeded with Texas. See [`docs/data-model.md`](docs/data-model.md). |
| 2 — Agentic population | Planned ([decree](specs/phase-2-agentic-population.html)) | Harness-ready agents work the `sources` queue inside an operator context fence, with per-jurisdiction context hooks layering local-expert knowledge pre/post run: discover, collect, verify, publish (human last), and monitor. Handoff to GitHub milestones/issues pending repo write access. |
| 3 — UI | Planned | Interface to monitor coverage/freshness and demonstrate the platform (Muse hackathon submission). |

## Phase 1: the data model (built)

Containerized PostgreSQL 18 + pgvector with a Drizzle schema. `tax_types` is the hub; everything else hangs off it. **Texas is the example jurisdiction** — all 27 levies from the [Comptroller A-to-Z index](https://comptroller.texas.gov/taxes/a-to-z.php) are seeded, with deep detail for Sales and Use, Franchise, and Hotel Occupancy.

| Table | Holds |
|---|---|
| `jurisdictions` | Whole-world hierarchy: country → state/province → county → city → special district (self-referencing). |
| `tax_types` | One row per administered levy; `category` (`sales_tax`, `excise`, …) makes cross-jurisdiction queries one filter. |
| `tax_rates` | Lookup for other services: one row per imposing-jurisdiction component — combined rates are sums (Texas 6.25% + Austin 1% + CapMetro 1% = 8.25%). |
| `tax_rules` | Applicability, exemptions, thresholds, nexus, penalties/discounts, sourcing — with a pgvector `embedding` for Phase 2 search. |
| `tax_licenses` | Operational permits/licenses/registrations required under a tax (e.g. Texas Sales Tax Permit). |
| `tax_compliance` | How to collect and remit: forms, filing frequency, due-date rules, filing/payment channels, e-file thresholds. |
| `sources` | Every source an agent must check and monitor, with cadence, check method, and freshness state. |
| `source_checks` | Append-only monitoring log; a `changed` check is the Phase 2 review trigger. |

All fact tables are effective-dated and source-backed (`source_id` + citation + verification status). Full design, ERD, and lookup queries: [`docs/data-model.md`](docs/data-model.md).

Run it:

```powershell
docker compose up -d   # Postgres 18 + pgvector on localhost:5433
pnpm install
pnpm db:migrate
pnpm db:seed           # idempotent Texas seed
pnpm db:studio         # browse the data
```

Research inputs still live in [`contacts/`](contacts/): one file per contact, one file per interview. See [`contacts/README.md`](contacts/README.md).

## Repository layout

| Path | Purpose |
|---|---|
| `contacts/` | Research contacts and interview records. |
| `packages/database/` | Drizzle schema, migrations, and Texas seed (`@agent-tax-research/database`). |
| `docs/data-model.md` | Phase 1 model: tables, ERD, conventions, lookup patterns. |
| `specs/phase-2-agentic-population.html` | Phase 2 decree: harness-ready agentic population, context fencing, monitoring, demo (open in a browser). |
| `docker-compose.yml` | Local PostgreSQL 18 + pgvector container. |
| `.claude/project-manifest.json` | Machine-readable project state for agents. |
| `README.md` | This file — project direction and phases. |

## Getting started

1. Read this file, [`docs/data-model.md`](docs/data-model.md), and [`contacts/README.md`](contacts/README.md).
2. Bring the database up (commands above) and explore Texas in Drizzle Studio.
3. To add a research contact, copy `contacts/_template-contact.md`; after each interview, copy `contacts/_template-interview.md` into `contacts/interviews/` the same day.

## Open questions

Tracked here until they become issues or decisions:

- Texas is the Phase 1 example. Which jurisdiction is second — another US state, or a non-US country to stress-test VAT/GST + treaty modeling early?
- Freshness targets per source tier are seeded as weekly. Which Texas sources (rate tables? news?) deserve daily checks in Phase 2?
- Address → applicable-jurisdictions resolution (which overlapping districts apply) is Phase 2 scope. Build on Comptroller rate-locator data, or license boundary data?
- What human review workflow and confidence threshold gate "trusted" (`verified`) data in Phase 2?
- Build vs. license per jurisdiction / tax type, once provider evaluation is done.

## License

MIT — see [`LICENSE`](LICENSE).
