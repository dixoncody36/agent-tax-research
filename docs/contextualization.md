# Contextualization — operator context profiles and the context compiler

Decree reference: [Phase 2 decree, p1.t5](../specs/phase-2-agentic-population.html).
Operating rule: [AGENTS.md](../AGENTS.md) hard rule 2 — work only inside the compiled scope; never self-expand scope.

An operator describes where they operate in a **context profile**. The **context compiler** turns that profile into an explicit, reviewable **compiled scope** (JSON) listing every jurisdiction in scope. No agent runs against a raw profile — only against a compiled scope, optionally saved as a `scope_runs` row.

## JSON now, YAML later

JSON is the compiled form the CLI reads **today**. Human-friendly YAML authoring (`tax-context.yaml`, per the decree's original wording) is a later layer: when it lands it will compile down to this same JSON shape. Until then, author profiles directly as JSON in `contexts/` — the schema below is the contract either way. Do not hand the YAML sketch in the decree to the CLI; it will not parse.

Profiles live in:

- `tax-context.example.json` (repo root) — annotated worked example; copy it into `contexts/` and edit.
- `contexts/<name>.json` — one file per operator profile.

## Profile schema

| Field | Type | Required | Meaning |
|---|---|---|---|
| `profile` | string (non-empty) | yes | Stable profile name. Becomes `scope_runs.profile_name` on `--save`. |
| `description` | string | no | Human note on what this profile is for. Carried into the compiled scope. |
| `footprint` | string[] | yes | Jurisdiction slugs the operator operates in (e.g. `"us-tx"`). Every slug must already be registered in the `jurisdictions` table. `[]` means the **full globe** — every registered jurisdiction. |
| `industries` | string[] | no (default `[]`) | Industry / niche overlay keys (e.g. `"oil_and_gas"`). `[]` = no industry filter. Carried into the compiled scope for downstream question-pack filtering. |
| `categories` | string[] | no (default `[]`) | Global tax-category buckets (`sales_tax`, `vat_gst`, `franchise_margin`, `occupancy`, `excise`, `severance`, `gross_receipts`, `property`, `fee`, `other`). `[]` = all categories. |
| `depth` | integer ≥ 0 or `null` | no (default `null`) | Descendant depth below each footprint slug. `null` = all registered descendants (recursive). `0` = footprint + ancestors only, no descendants. `1` = direct children only, and so on. |
| `history` | string | no (default `"earliest_published"`) | History depth for research in this scope. Default is earliest published data, effective-dated (AGENTS.md hard rule 6). |
| `cadences` | object | no | Monitor cadences. `default` (cadence string, default `"weekly"`), `byCategory` (map category → cadence), `byJurisdiction` (map slug → cadence). Cadence values: `daily`, `weekly`, `monthly`, `quarterly`, `manual`. `monitorCadences` is accepted as an alias for `cadences`. |

Unknown or malformed fields fail compilation with error JSON and exit code `2` — the compiler never guesses.

Minimal valid profile:

```json
{ "profile": "texas-only", "footprint": ["us-tx"] }
```

That compiles with `depth: null`, `history: "earliest_published"`, empty `industries`/`categories`, and a weekly default cadence. Shipped profiles spell every field out explicitly — prefer that for real profiles, so a reviewer can see the whole fence without knowing the defaults.

## The ancestor rule

Each footprint jurisdiction **always pulls in all of its ancestors** up to the root, regardless of `depth`. An ancestor is found by walking `parent_id` in the `jurisdictions` table.

Why: rates and rules stack down the hierarchy. A combined sales-tax rate in a Texas city needs the city, county/district, and state components, and state income/franchise questions need the country-level conformity context. A footprint slug alone would misprice and misread.

Descendants are the mirror image — opt-in via `depth`, expanded only **below footprint slugs**, recursively through `parent_id`. Ancestors' *other* descendants (siblings) are never pulled in: compiling `us-tx` must not leak in Oklahoma through the shared `us` ancestor.

Worked resolution with today's seed (`us → us-tx → us-tx-travis → us-tx-austin`, plus `us-tx-capmetro` under `us-tx`):

- `footprint: ["us-tx"]`, `depth: null` → `us`, `us-tx`, `us-tx-austin`, `us-tx-capmetro`, `us-tx-travis`
- `footprint: ["us-tx"]`, `depth: 0` → `us`, `us-tx`
- `footprint: ["us-tx-austin"]`, `depth: null` → `us`, `us-tx`, `us-tx-austin`, `us-tx-travis` (Austin's ancestors; CapMetro is not an Austin descendant in the seed, so it stays out — overlapping districts resolve at rate-lookup time, not by widening scope)
- `footprint: []` → every registered jurisdiction

## The hard fence

The compiled jurisdiction set is a hard fence, enforced here at compile time and (as later decree tasks land) at assignment claim time:

- **Unknown slug = refusal.** A footprint slug that is not registered in `jurisdictions` produces error JSON (`error: "unknown_jurisdiction"`, with `unknownSlugs`) and exit code `2`. Nothing is compiled, nothing is saved. Register the jurisdiction structure first, then recompile.
- **Agents never self-expand.** Widening scope means editing the profile and recompiling. A discovery outside the fence is out of scope, not a new assignment.
- **Recompiling is how scope grows.** When new jurisdictions are registered under a footprint slug, the next compile picks them up (within `depth`). The profile text does not change; the compiled scope does — which is why the compiled JSON, not the profile, is what gets saved on the `scope_runs` row.

## Compiling

```bash
pnpm tax context compile --profile contexts/texas-only.json
pnpm tax context compile --profile contexts/texas-only.json --save
```

`--profile` paths are resolved relative to where you ran the command (and the repo root as fallback), so both `contexts/texas-only.json` from the repo root and an absolute path work.

Without `--save`, the compiler prints the compiled scope and changes nothing — compile freely to review the fence.

Compiled scope JSON fields:

| Field | Meaning |
|---|---|
| `profile` | Profile name, as given. |
| `description` | Present when the profile carries one. |
| `footprint` | The footprint slugs as given (before expansion). |
| `jurisdictions` | In-scope jurisdiction slugs, sorted, after the ancestor rule and descendant expansion. |
| `jurisdictionCount` | `jurisdictions.length`. |
| `categories`, `industries`, `depth`, `history` | Carried from the profile (defaults applied). |
| `cadences` | Monitor cadences (`default`, `byCategory`, `byJurisdiction`). |

With `--save`, the compiler also inserts one row into `scope_runs`:

- `profile_name` = `profile`
- `root_jurisdiction_id` = id of the first footprint jurisdiction, or `null` for a full-globe (empty-footprint) profile
- `scope_json` = the compiled scope JSON above
- `status` = `active`

…and prints the compiled scope plus `saved: true`, the new `scopeRunId`, and `status`. Check the row landed with `pnpm tax status` (the `scopeRuns` count).

Compile runs no web fetching and starts no agent work — it only reads the `jurisdictions` table (and writes one `scope_runs` row with `--save`).

## Shipped profiles (`contexts/`)

| Profile | Footprint | Compiles today? | What it proves |
|---|---|---|---|
| `full-globe.json` | `[]` (everything registered) | Yes | The operator's always-on world scan. New registrations enter on next compile. `root_jurisdiction_id` is `null` on save. |
| `texas-only.json` | `["us-tx"]`, depth `null` | Yes | A state footprint expands to `us` + `us-tx` + all seeded descendants. |
| `dallas-only.json` | `["us-tx"]`, depth `0` | Yes | Single-city business. Dallas is **not yet registered**, so the footprint names its state at depth `0` for now — ancestors only, so Dallas work never claims Austin. Once Dallas is registered (expected slug `us-tx-dallas`), switch `footprint` to the city slug and the ancestor rule pulls in county + `us-tx` + `us` automatically. |
| `brazil-only.json` | `["br"]`, depth `null` | **No — expected** | Brazil is not yet registered, so compiling fails with `unknown_jurisdiction` for slug `br` and exit code `2`. That refusal is the fence working: register Brazil's structure, then the same profile compiles with no code change — the proof that one clone serves a single city and a new country. |

## Adding a profile

1. Copy `tax-context.example.json` to `contexts/<your-profile>.json`.
2. Edit `profile`, `footprint`, and the rest; keep every field explicit.
3. Compile without `--save` and review `jurisdictions` — that list is the fence agents will work inside.
4. Compile again with `--save` to persist the active scope as a `scope_runs` row.
