# Coverage Engine — Question Packs & Peer Interrogation

Coverage is interrogation, not collection. Every jurisdiction gets a checklist generated from data (`coverage_questions`, seeded from `packages/database/src/seed-data/question-packs.ts` — 110 questions across 17 packs):

- **Category packs** (per tax type category): sales_tax, vat_gst, franchise_margin, income, occupancy, excise, severance, gross_receipts, property, fee — rate, base, exemptions, thresholds/nexus, permits, filing, penalties/discounts, history.
- **federal_conformity** — IRC conformity type (rolling vs fixed-date), starting point (federal AGI/taxable income), decouplings, federal deductibility.
- **Niche overlays** — oil_and_gas, telecom, short_term_rentals, marketplace, software_digital, delivery.

## Commands

```powershell
pnpm tax coverage packs
pnpm tax coverage open --jurisdiction us-tx     # generate unknown answers (idempotent)
pnpm tax coverage show --jurisdiction us-tx     # found / confirmed_absent / unknown counts
pnpm tax coverage answer --jurisdiction us-tx --question <key> --status found --answer "..."
pnpm tax coverage answer --jurisdiction us-tx --question peer_existence.income --status confirmed_absent --searches "authority A-to-Z index scan; statute title search: income tax"
```

## Rules

- `tax coverage open` creates one `unknown` per (own tax type × its category pack) plus one `peer_existence.<category>` question for every catalog category this jurisdiction has no tax type for — peers' findings interrogate every new jurisdiction, and new categories back-ask on the next open.
- `confirmed_absent` is rejected without `--searches` (recorded negative search). Absence is an evidenced finding, never silence.
- A jurisdiction is coverage-complete when zero answers remain `unknown`.

## Worked example — Texas absence (recorded 2026-11-01/02 loop run)

`peer_existence.income` → `confirmed_absent`: "Texas imposes no personal income tax." Searches recorded: Comptroller A-to-Z full scan (27 levies, none an income tax), Tax Code title review (no personal income tax chapter), Texas Constitution Art. VIII restriction. The same command without `--searches` is rejected with `absence_requires_searches`.

## Federal conformity & niche overlays

The `federal_conformity` pack (6 questions) is answered per US state against the federal profile; answers that establish a link also create `tax_type_relationships` rows (`conforms_to`, `piggybacks_on`, `deductible_against`, `credit_for`). Texas worked answers: conformity N/A (no income tax; franchise margin under ch. 171 is not IRC-conformed), starting point is Texas-computed taxable margin, no federal-AGI starting point. Niche overlays (`oil_and_gas`, `telecom`, `short_term_rentals`, `marketplace`, `software_digital`, `delivery`) ride on top of category packs via context-profile industries — depth follows the operator's niches, and rules carry `datavalues.industry` until promoted.
