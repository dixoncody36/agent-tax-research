import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Phase 1 data model — agentic tax research platform.
 *
 * Reading guide:
 * - `jurisdictions` is the whole-world hierarchy (country -> state/province
 *   -> county -> city -> special district). Every tax fact hangs off it.
 * - `tax_types` is the hub table. One row per levy as administered by a
 *   jurisdiction (e.g. "Texas Sales and Use Tax"). `category` is the global
 *   comparable bucket (e.g. `sales_tax`) for cross-jurisdiction queries.
 * - `tax_rates`, `tax_rules`, `tax_licenses`, `tax_compliance` all belong
 *   to a tax type and are effective-dated (`effective_from`/`effective_to`)
 *   so history is never overwritten.
 * - `sources` is the agent work queue: every URL/API/feed an agent must
 *   check and monitor. `source_checks` is the append-only monitoring log.
 *
 * Lookup pattern for other services: a combined rate at a place is the sum
 * of the currently-effective `tax_rates` rows for the tax type across the
 * applicable jurisdictions (state + city + county + district components).
 * See docs/data-model.md.
 */

export const jurisdictionLevel = pgEnum("jurisdiction_level", [
  "country",
  "state",
  "province",
  "region",
  "county",
  "city",
  "special_district",
  "other",
]);

export const verificationStatus = pgEnum("verification_status", [
  "unverified",
  "verified",
  "needs_review",
]);

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);

const datavalues = () =>
  jsonb("datavalues")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

const effectiveDates = {
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
};

const provenance = {
  citation: text("citation"),
  verificationStatus: verificationStatus("verification_status")
    .notNull()
    .default("unverified"),
};

// ---------------------------------------------------------------------------
// Jurisdictions — whole-world hierarchy, self-referencing.
// Texas example: US (country) -> Texas (state) -> Travis County (county)
// -> Austin (city); transit/special districts hang off their parent too.
// Overlapping districts (one address in several districts at once) are
// resolved at rate-lookup time, not forced into a single tree path.
// ---------------------------------------------------------------------------
export const jurisdictions = pgTable(
  "jurisdictions",
  {
    id: id(),
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => jurisdictions.id,
    ),
    level: jurisdictionLevel("level").notNull(),
    /** Stable machine slug, e.g. `us`, `us-tx`, `us-tx-austin`. */
    slug: text("slug").notNull(),
    /** Official code where one exists: ISO 3166 (`US`, `US-TX`), FIPS, etc. */
    code: text("code"),
    name: text("name").notNull(),
    officialName: text("official_name"),
    /** ISO 3166-1 alpha-2 of the containing country; denormalized for queries. */
    countryCode: text("country_code"),
    currencyCode: text("currency_code"),
    timezone: text("timezone"),
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("jurisdictions_slug_idx").on(t.slug),
    index("jurisdictions_parent_idx").on(t.parentId),
    index("jurisdictions_level_idx").on(t.level),
  ],
);

// ---------------------------------------------------------------------------
// Tax types — the hub. One row per administered levy.
// ---------------------------------------------------------------------------
export const taxTypes = pgTable(
  "tax_types",
  {
    id: id(),
    /** Administering jurisdiction (e.g. Texas for Texas Sales and Use Tax). */
    jurisdictionId: uuid("jurisdiction_id")
      .notNull()
      .references(() => jurisdictions.id),
    /** Stable machine slug, e.g. `us-tx-sales-use`. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /**
     * Global comparable category so "every sales tax on the planet" is one
     * query: sales_tax | vat_gst | franchise_margin | occupancy | excise |
     * severance | gross_receipts | property | fee | other (free text —
     * new world categories must not need a migration).
     */
    category: text("category").notNull().default("other"),
    description: text("description"),
    administeringAgency: text("administering_agency"),
    /** Canonical landing page for this levy (also mirrored as a source). */
    officialUrl: text("official_url"),
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tax_types_slug_idx").on(t.slug),
    index("tax_types_jurisdiction_idx").on(t.jurisdictionId),
    index("tax_types_category_idx").on(t.category),
  ],
);

// ---------------------------------------------------------------------------
// Sources — every information source an agent must check and monitor.
// The agent's reading list and watch list in one table: a Phase 2 agent
// picks due sources by `monitor_cadence` + `last_checked_at`, records a
// `source_checks` row, and files proposed rate/rule changes on `changed`.
// ---------------------------------------------------------------------------
export const sources = pgTable(
  "sources",
  {
    id: id(),
    jurisdictionId: uuid("jurisdiction_id").references(() => jurisdictions.id),
    taxTypeId: uuid("tax_type_id").references(() => taxTypes.id),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /**
     * statute | regulation | agency_guidance | rate_table | form_library |
     * faq | news_feed | api | dataset (free text, see category note).
     */
    sourceType: text("source_type").notNull().default("agency_guidance"),
    publisher: text("publisher"),
    language: text("language").notNull().default("en"),
    isAuthoritative: boolean("is_authoritative").notNull().default(false),
    /** daily | weekly | monthly | quarterly | manual */
    monitorCadence: text("monitor_cadence").notNull().default("weekly"),
    /** content_hash | http_etag | rss | api | manual */
    checkMethod: text("check_method").notNull().default("content_hash"),
    /** active | paused | broken */
    status: text("status").notNull().default("active"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    contentHash: text("content_hash"),
    notes: text("notes"),
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("sources_url_idx").on(t.url),
    index("sources_tax_type_idx").on(t.taxTypeId),
    index("sources_jurisdiction_idx").on(t.jurisdictionId),
    index("sources_due_idx").on(t.status, t.monitorCadence, t.lastCheckedAt),
  ],
);

// ---------------------------------------------------------------------------
// Tax rates — the lookup table for other services.
// One row per imposing jurisdiction component. Texas sales tax in Austin
// is three rows (state 6.25 + city 1.00 + transit 1.00); consumers sum the
// effective components. `rate_value` + `rate_unit` covers percent taxes,
// per-unit excise (usd_per_gallon), and flat fees (usd_flat) in one shape.
// ---------------------------------------------------------------------------
export const taxRates = pgTable(
  "tax_rates",
  {
    id: id(),
    taxTypeId: uuid("tax_type_id")
      .notNull()
      .references(() => taxTypes.id),
    /** Jurisdiction imposing this rate component. */
    jurisdictionId: uuid("jurisdiction_id")
      .notNull()
      .references(() => jurisdictions.id),
    sourceId: uuid("source_id").references(() => sources.id),
    /** Percent values are stored as percent points: 6.25 means 6.25%. */
    rateValue: numeric("rate_value", { precision: 14, scale: 6 }).notNull(),
    /** percent | usd_flat | usd_per_gallon | usd_per_pack | ... */
    rateUnit: text("rate_unit").notNull().default("percent"),
    /** What the rate applies to, e.g. "retail sales price", "cost of a room". */
    appliesTo: text("applies_to"),
    /** Human qualifier, e.g. "retail/wholesale", "EZ computation". */
    conditions: text("conditions"),
    ...effectiveDates,
    ...provenance,
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [
    index("tax_rates_lookup_idx").on(
      t.taxTypeId,
      t.jurisdictionId,
      t.effectiveFrom,
    ),
    index("tax_rates_jurisdiction_idx").on(t.jurisdictionId),
  ],
);

// ---------------------------------------------------------------------------
// Tax rules — context that is not a rate: who it applies to, exemptions,
// thresholds, nexus, calculation, penalties/interest/discounts, sourcing.
// Full text is kept for agent retrieval; `embedding` (pgvector) is Phase 2
// semantic search over the same rows. Dimensions match text-embedding-3
// class models; re-embed if the Foundry deployment differs.
// ---------------------------------------------------------------------------
export const taxRules = pgTable(
  "tax_rules",
  {
    id: id(),
    taxTypeId: uuid("tax_type_id")
      .notNull()
      .references(() => taxTypes.id),
    /** Null means the tax type's administering jurisdiction. */
    jurisdictionId: uuid("jurisdiction_id").references(() => jurisdictions.id),
    sourceId: uuid("source_id").references(() => sources.id),
    /**
     * applicability | nexus | exemption | exclusion | threshold |
     * calculation | sourcing | penalty | interest | discount | refund |
     * definition | other (free text, see category note).
     */
    ruleType: text("rule_type").notNull().default("other"),
    /** statute | regulation | guidance | faq */
    authorityLevel: text("authority_level").notNull().default("guidance"),
    title: text("title").notNull(),
    summary: text("summary"),
    fullText: text("full_text"),
    embedding: vector("embedding", { dimensions: 1536 }),
    ...effectiveDates,
    ...provenance,
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [
    index("tax_rules_tax_type_idx").on(t.taxTypeId, t.ruleType),
    index("tax_rules_jurisdiction_idx").on(t.jurisdictionId),
  ],
);

// ---------------------------------------------------------------------------
// Tax licenses — operational permits/licenses/registrations a taxpayer
// needs in order to operate under the tax (e.g. Texas Sales Tax Permit).
// ---------------------------------------------------------------------------
export const taxLicenses = pgTable(
  "tax_licenses",
  {
    id: id(),
    taxTypeId: uuid("tax_type_id")
      .notNull()
      .references(() => taxTypes.id),
    jurisdictionId: uuid("jurisdiction_id").references(() => jurisdictions.id),
    sourceId: uuid("source_id").references(() => sources.id),
    name: text("name").notNull(),
    /** permit | license | registration | bond */
    licenseType: text("license_type").notNull().default("permit"),
    requiredFor: text("required_for"),
    issuingAgency: text("issuing_agency"),
    applicationUrl: text("application_url"),
    formNumber: text("form_number"),
    feeAmount: numeric("fee_amount", { precision: 14, scale: 2 }),
    feeCurrency: text("fee_currency"),
    /** Human renewal cadence, e.g. "none — no renewal", "annual". */
    renewalPeriod: text("renewal_period"),
    ...effectiveDates,
    ...provenance,
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [index("tax_licenses_tax_type_idx").on(t.taxTypeId)],
);

// ---------------------------------------------------------------------------
// Tax compliance — how to collect and remit: forms, filing frequency and
// due-date rules, filing/payment channels, e-file thresholds. This is the
// operational half agents answer from ("what do I file, when, how do I pay").
// ---------------------------------------------------------------------------
export const taxCompliance = pgTable(
  "tax_compliance",
  {
    id: id(),
    taxTypeId: uuid("tax_type_id")
      .notNull()
      .references(() => taxTypes.id),
    jurisdictionId: uuid("jurisdiction_id").references(() => jurisdictions.id),
    sourceId: uuid("source_id").references(() => sources.id),
    /**
     * return_filing | payment | information_report |
     * registration_renewal | recordkeeping
     */
    obligationType: text("obligation_type").notNull().default("return_filing"),
    formNumber: text("form_number"),
    formName: text("form_name"),
    formUrl: text("form_url"),
    /** monthly | quarterly | annual | per_transaction | varies_by_liability */
    filingFrequency: text("filing_frequency"),
    /**
     * Human due-date rule, e.g. "20th of month following period end; next
     * business day if weekend/holiday". Machine form goes in datavalues
     * until promoted (see docs/data-model.md).
     */
    dueDateRule: text("due_date_rule"),
    filingMethods: text("filing_methods"),
    paymentMethods: text("payment_methods"),
    /** Liability at/above which electronic filing/payment is mandatory. */
    efileThreshold: numeric("efile_threshold", { precision: 14, scale: 2 }),
    efileThresholdCurrency: text("efile_threshold_currency"),
    /** Who collects from whom, and remits to whom — the collect/remit chain. */
    collectRemitSummary: text("collect_remit_summary"),
    ...effectiveDates,
    ...provenance,
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [index("tax_compliance_tax_type_idx").on(t.taxTypeId)],
);

// ---------------------------------------------------------------------------
// Source checks — append-only monitoring log. Every agent visit to a
// source lands here; `changed = true` is the trigger for Phase 2 review.
// ---------------------------------------------------------------------------
export const sourceChecks = pgTable(
  "source_checks",
  {
    id: id(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Agent/run identifier that performed the check (Phase 2). */
    checkedBy: text("checked_by"),
    httpStatus: integer("http_status"),
    contentHash: text("content_hash"),
    changed: boolean("changed").notNull().default(false),
    notes: text("notes"),
  },
  (t) => [index("source_checks_source_idx").on(t.sourceId, t.checkedAt)],
);

// ---------------------------------------------------------------------------
// Four-role agent foundation (built ahead of any fetching, per decree
// Phase 2 amendment). Roles are objective slots — orchestrator, fetch,
// decision, reviewer — with models assigned in config/models.yaml.
// The research ledger is the future-agent kindness layer: validated
// determinations are checked BEFORE any re-research and reused while
// their snapshot hash still matches. Reopening requires a typed
// invalidation reason; human objections are one of them.
// ---------------------------------------------------------------------------
export const agentRole = pgEnum("agent_role", [
  "orchestrator",
  "fetch",
  "decision",
  "reviewer",
]);

export const scopeRuns = pgTable(
  "scope_runs",
  {
    id: id(),
    /** Context profile this run was compiled from (e.g. full-globe, dallas-only). */
    profileName: text("profile_name").notNull(),
    rootJurisdictionId: uuid("root_jurisdiction_id").references(
      () => jurisdictions.id,
    ),
    /** Compiled scope: jurisdiction set, categories, cadences (compiler output). */
    scopeJson: jsonb("scope_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** active | agent_complete | closed */
    status: text("status").notNull().default("active"),
    /** Harness goal/session reference that kicked this run off, if any. */
    goalRef: text("goal_ref"),
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [index("scope_runs_status_idx").on(t.status)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    scopeRunId: uuid("scope_run_id").references(() => scopeRuns.id),
    role: agentRole("role").notNull(),
    /** Model that filled the role slot for this run (config/models.yaml). */
    model: text("model"),
    jurisdictionId: uuid("jurisdiction_id").references(() => jurisdictions.id),
    taxTypeId: uuid("tax_type_id").references(() => taxTypes.id),
    /** Workflow unit worked (discover, fetch, extract, decide, verify, report...). */
    unit: text("unit"),
    /** queued | running | completed | failed */
    status: text("status").notNull().default("queued"),
    /** What future agents must know: what to trust, watch, and not redo. */
    handoffNotes: text("handoff_notes"),
    /** Analytics (populate/maintain/review cost per jurisdiction, role, model). */
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 4 }),
    /** 1-based attempt number; hard cap 3 — after attempt 3 fails, the
     *  run is failed and the orchestrator is notified (no silent loops). */
    attempt: integer("attempt").notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [
    index("agent_runs_assignment_idx").on(t.jurisdictionId, t.taxTypeId, t.role),
    index("agent_runs_scope_idx").on(t.scopeRunId, t.status),
  ],
);

export const researchLedger = pgTable(
  "research_ledger",
  {
    id: id(),
    jurisdictionId: uuid("jurisdiction_id")
      .notNull()
      .references(() => jurisdictions.id),
    taxTypeId: uuid("tax_type_id").references(() => taxTypes.id),
    /** Stable question/determination key, e.g. sales_tax.state_rate. */
    questionKey: text("question_key").notNull(),
    /** Short statement of what was determined. */
    determination: text("determination"),
    /** validated | pending_review | invalidated */
    status: text("status").notNull().default("pending_review"),
    /** Snapshot hash the determination was validated against. */
    snapshotHash: text("snapshot_hash"),
    validatedByRunId: uuid("validated_by_run_id").references(() => agentRuns.id),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    /**
     * source_changed | human_objection | cadence_expired |
     * context_changed | pack_changed — the only reasons validated work
     * may be reopened. Null while valid.
     */
    invalidatedReason: text("invalidated_reason"),
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [
    index("research_ledger_check_idx").on(
      t.jurisdictionId,
      t.taxTypeId,
      t.questionKey,
      t.status,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Coverage question packs (decree p2) — the checklist an open jurisdiction
// is interrogated against. Questions are seeded data (seed-data/
// question-packs.ts), grouped by `category` (a tax_types category, the
// `federal_conformity` pack, or a niche overlay key). Every question is
// answerable found / confirmed_absent / unknown; `absenceRequires` states
// what recorded search evidence a confirmed_absent verdict demands.
// ---------------------------------------------------------------------------
export const coverageQuestions = pgTable(
  "coverage_questions",
  {
    id: id(),
    /**
     * Pack key: tax_types category (sales_tax, vat_gst, income, ...) or
     * federal_conformity / niche overlay key (oil_and_gas, marketplace, ...).
     */
    category: text("category").notNull(),
    /** Stable key within the pack, e.g. `state_rate`, `economic_nexus`. */
    questionKey: text("question_key").notNull(),
    question: text("question").notNull(),
    /** What evidence answers this question (eligible source types/citations). */
    evidenceRequired: text("evidence_required"),
    /** What a `confirmed_absent` answer requires (searches to record). */
    absenceRequires: text("absence_requires"),
    sortOrder: integer("sort_order").notNull().default(0),
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("coverage_questions_category_key_idx").on(
      t.category,
      t.questionKey,
    ),
    index("coverage_questions_category_idx").on(t.category, t.sortOrder),
  ],
);

export const coverageAnswers = pgTable(
  "coverage_answers",
  {
    id: id(),
    jurisdictionId: uuid("jurisdiction_id")
      .notNull()
      .references(() => jurisdictions.id),
    /** Null when the pack is jurisdiction-level (e.g. federal_conformity). */
    taxTypeId: uuid("tax_type_id").references(() => taxTypes.id),
    /** Matches coverage_questions.question_key within the pack in use. */
    questionKey: text("question_key").notNull(),
    /** found | confirmed_absent | unknown */
    status: text("status").notNull().default("unknown"),
    answer: text("answer"),
    /**
     * Evidence bundle: source/snapshot refs, citations, and — for
     * confirmed_absent — the searches tried (AGENTS.md rule 7).
     */
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    answeredByRunId: uuid("answered_by_run_id").references(() => agentRuns.id),
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [
    index("coverage_answers_check_idx").on(
      t.jurisdictionId,
      t.taxTypeId,
      t.questionKey,
    ),
    index("coverage_answers_status_idx").on(t.jurisdictionId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Jurisdiction context packs (decree p1.t6) — versioned local-expert
// guidance injected into assignments. Context guides, never evidences
// (AGENTS.md rule 5). Memory updates are proposed rows a human approves;
// versions are append-only, never silently edited.
// ---------------------------------------------------------------------------
export const jurisdictionContext = pgTable(
  "jurisdiction_context",
  {
    id: id(),
    jurisdictionId: uuid("jurisdiction_id")
      .notNull()
      .references(() => jurisdictions.id),
    version: integer("version").notNull(),
    /** How to evaluate this jurisdiction's sources; traps, terminology. */
    guidance: text("guidance").notNull(),
    /** Accumulated local memory carried across runs (human-approved). */
    memory: text("memory"),
    author: text("author").notNull(),
    approvedBy: text("approved_by"),
    /** active | proposed */
    status: text("status").notNull().default("proposed"),
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("jurisdiction_context_version_idx").on(
      t.jurisdictionId,
      t.version,
    ),
    index("jurisdiction_context_active_idx").on(t.jurisdictionId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Source snapshots (decree p1.t4 / p3 fetch) — retrieved content of an
// eligible source at fetch time. `contentHash` is what validated ledger
// determinations pin to; a changed hash reopens extraction. Append-only:
// a re-fetch inserts a new snapshot, never edits one.
// ---------------------------------------------------------------------------
export const sourceSnapshots = pgTable(
  "source_snapshots",
  {
    id: id(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    contentHash: text("content_hash").notNull(),
    /** Retrieved text inline; large/blob payloads carry their ref in datavalues. */
    retrievedText: text("retrieved_text"),
    fetchedByRunId: uuid("fetched_by_run_id").references(() => agentRuns.id),
    datavalues: datavalues(),
    ...timestamps,
  },
  (t) => [
    index("source_snapshots_source_idx").on(t.sourceId, t.createdAt),
    index("source_snapshots_hash_idx").on(t.contentHash),
  ],
);

export type Jurisdiction = typeof jurisdictions.$inferSelect;
export type TaxType = typeof taxTypes.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type TaxRate = typeof taxRates.$inferSelect;
export type TaxRule = typeof taxRules.$inferSelect;
export type TaxLicense = typeof taxLicenses.$inferSelect;
export type TaxCompliance = typeof taxCompliance.$inferSelect;
export type SourceCheck = typeof sourceChecks.$inferSelect;
export type ScopeRun = typeof scopeRuns.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type ResearchLedgerEntry = typeof researchLedger.$inferSelect;
export type CoverageQuestion = typeof coverageQuestions.$inferSelect;
export type CoverageAnswer = typeof coverageAnswers.$inferSelect;
export type JurisdictionContext = typeof jurisdictionContext.$inferSelect;
export type SourceSnapshot = typeof sourceSnapshots.$inferSelect;



