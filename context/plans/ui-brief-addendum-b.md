## Addendum B — functional surfaces (operator request, supersedes "no new product surfaces")

After the restyle commits are pushed, build these three surfaces in the same worktree/branch as additional commits. All read-only over the database; published data is the default view, anything unpublished must be visibly labeled. No new top-level dependencies (hand-roll CSV). Token/CSS theming only — no shadcn init, no Radix, no Remix icons (this app is pre-stamp). Read packages/database/src/schema.ts and docs/data-model.md first for exact table/column names; follow the existing route-handler DB access pattern.

### B1. Jurisdiction Explorer — walk the data model
- New route: /explore. Jurisdiction search (by name/slug) + level-grouped browsing (country → state/province → county → city → special district).
- Clicking a jurisdiction opens its detail: breadcrumb of ancestors (clickable), children list (clickable), and tabs/sections per data-model table — Rates (tax type, rate %, effective from–to, status), Rules, Licenses, Compliance obligations, Geo boundary (level, status incl. confirmed_absent, geometry hash, source), Sources & evidence (title, URL, snapshot date), Research ledger status.
- New read API: GET /api/jurisdictions/detail?slug=<slug> returning the above as JSON. Do not change existing API routes/contracts.
- Data-model overview: a section listing every table with row counts (total + published where applicable) and a one-line purpose from docs/data-model.md; each table row links into the explorer.
- Globe: clicking an existing lookup/pin result links to /explore for that jurisdiction slug.

### B2. Downloads — published data exports
- New read APIs with Content-Disposition attachment (filename = slug + date):
  - GET /api/export/rates?jurisdiction=<slug>&taxType=<slug?>&format=csv|json — published, effective-dated rates with source citation columns (source title/URL). jurisdiction omitted = all published rates.
  - GET /api/export/rules?jurisdiction=<slug>&format=csv|json
  - GET /api/export/geo?jurisdiction=<slug> — published boundary as GeoJSON download.
- JSON exports carry a meta block: generatedAt, publishedOnly: true, draft: true. CSVs are clean data rows with citation columns.
- UI: download buttons on the explorer detail (per jurisdiction) plus a Downloads section for the global exports.

### B3. Ask — agentic Q&A (feasibility build)
- New route: /ask, labeled "Ask (feasibility)". One question box + example-question chips.
- Engine must work with NO external API key: deterministic intent + entity resolution over published data. Support:
  - "What is the <tax> rate in <place>?" → published rate(s) with component breakdown when stacked, effective dates, citations.
  - "Does <place> have a <tax>?" → present / confirmed_absent / unknown, per ledger.
  - "Which jurisdictions levy <tax type>?" → list with rates.
  - "Rate at <lat>, <lng>" → reuse GET /api/geo/resolve.
- Answer card always shows: the parsed interpretation (jurisdiction/tax/date), the result, evidence links, and any PARTIAL/unknown flags — never invent a number; unknown input explains what was not understood and offers the examples.
- Optional LLM hook: if MODEL_API_KEY is set server-side, an LLM may assist parsing/phrasing (see packages/cli/src/muse-api.ts for the provider shape), but the deterministic path is the deliverable and the fallback.
- New read API: GET /api/ask?q=<question> returning { interpretation, answer, evidence[] }.

### Cross-cutting
- Nav gains: Explore, Downloads, Ask.
- New testids: explorer-search, explorer-detail, download-rates, ask-input, ask-answer. All pre-existing testids/routes/APIs unchanged.
- Field sense: sort rates by effective-from descending on values (never strings), percents formatted consistently, dates displayed locale-style with ISO available, level/status enums in domain order, long lists searchable, empty states that say why.
- Commits: feat(web): jurisdiction explorer and data-model views / feat(web): published data downloads (CSV/JSON/GeoJSON) / feat(web): ask — deterministic Q&A over published data. Typecheck + production build + port 3102 verification after each; push each.
- Final message of the whole brief (restyle + Addendum B) still ends with the sentinel exactly: UI dash REDESIGNED (word dash spelled out, per original brief).
