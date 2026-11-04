import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  agentRuns,
  client,
  coverageAnswers,
  coverageQuestions,
  db,
  exceptions,
  jurisdictionContext,
  jurisdictions,
  proposalItems,
  proposals,
  researchLedger,
  scopeRuns,
  taxRates as taxRatesTable,
  taxRules as taxRulesTable,
  productCategories as productCategoriesTable,
  productTaxTreatments as productTreatmentsTable,
  sourceChecks,
  sourceSnapshots,
  sources,
  taxRates,
  taxRules,
  taxTypes,
  taxCompliance as taxComplianceTable,
  jurisdictionGeo as jurisdictionGeoTable,
} from "@agent-tax-research/database";
import { runGeoIngest } from "./geo-ingest.js";
import { runGeoResolve, runRateAtPoint } from "./geo-resolve.js";

/**
 * tax CLI — the harness-neutral work contract (foundation cut).
 *
 * Every command prints JSON so any harness (Muse, Muse, Codex,
 * Grok, OpenCode, headless runners) consumes identical output.
 *
 *   pnpm tax status
 *   pnpm tax ledger check --jurisdiction us-tx
 *   pnpm tax context compile --profile contexts/texas-only.json [--save]
 *
 * The full assignment lifecycle (work next/claim/submit, publish gate)
 * lands with decree Phase 1 milestones; this cut proves the check-first
 * read path future agents must use plus the context compiler foundation
 * (see docs/contextualization.md).
 */

function out(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

async function status() {
  const [j, tt, s, r, ru, sr, ar, rl] = await Promise.all([
    db.select({ n: count() }).from(jurisdictions),
    db.select({ n: count() }).from(taxTypes),
    db.select({ n: count() }).from(sources),
    db.select({ n: count() }).from(taxRates),
    db.select({ n: count() }).from(taxRules),
    db.select({ n: count() }).from(scopeRuns),
    db.select({ n: count() }).from(agentRuns),
    db.select({ n: count() }).from(researchLedger),
  ]);
  const ledgerByStatus = await db
    .select({ status: researchLedger.status, n: count() })
    .from(researchLedger)
    .groupBy(researchLedger.status);
  out({
    jurisdictions: j[0]?.n ?? 0,
    taxTypes: tt[0]?.n ?? 0,
    sources: s[0]?.n ?? 0,
    taxRates: r[0]?.n ?? 0,
    taxRules: ru[0]?.n ?? 0,
    scopeRuns: sr[0]?.n ?? 0,
    agentRuns: ar[0]?.n ?? 0,
    researchLedger: rl[0]?.n ?? 0,
    ledgerByStatus,
    roles: ["orchestrator", "fetch", "decision", "reviewer"],
    next: "No fetching until an assignment is issued inside a compiled context scope (see AGENTS.md).",
  });
}

async function ledgerCheck(slug: string) {
  const [jur] = await db
    .select()
    .from(jurisdictions)
    .where(eq(jurisdictions.slug, slug))
    .limit(1);
  if (!jur) {
    out({ jurisdiction: slug, found: false, instruction: "Unknown jurisdiction slug; register structure before research." });
    return;
  }
  const entries = await db
    .select({
      questionKey: researchLedger.questionKey,
      determination: researchLedger.determination,
      status: researchLedger.status,
      snapshotHash: researchLedger.snapshotHash,
      validatedAt: researchLedger.validatedAt,
      invalidatedReason: researchLedger.invalidatedReason,
    })
    .from(researchLedger)
    .where(eq(researchLedger.jurisdictionId, jur.id))
    .orderBy(researchLedger.questionKey);
  const runs = await db
    .select({
      role: agentRuns.role,
      unit: agentRuns.unit,
      status: agentRuns.status,
      handoffNotes: agentRuns.handoffNotes,
      finishedAt: agentRuns.finishedAt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.jurisdictionId, jur.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(10);
  const reusable = entries.filter((e) => e.status === "validated").length;
  out({
    jurisdiction: slug,
    found: true,
    determinations: entries,
    reusableValidated: reusable,
    recentRuns: runs,
    instruction:
      reusable > 0
        ? "Reuse validated determinations whose snapshot hash still matches. Reopen only on typed invalidation."
        : "No validated determinations yet for this jurisdiction. Research may proceed inside scope; record every determination to the ledger so future runs can reuse it.",
  });
}

// ---------------------------------------------------------------------------
// Context compiler (decree p1.t5 foundation). JSON is the compiled form
// today; YAML authoring is a later layer over the same shape — see
// docs/contextualization.md and tax-context.example.json.
// ---------------------------------------------------------------------------
const CADENCES = ["daily", "weekly", "monthly", "quarterly", "manual"] as const;
type Cadence = (typeof CADENCES)[number];

interface ContextProfile {
  profile: string;
  description?: string;
  footprint: string[];
  industries: string[];
  categories: string[];
  /** Descendant depth from each footprint slug; null = all descendants. */
  depth: number | null;
  history: string;
  cadences: {
    default: Cadence;
    byCategory: Record<string, Cadence>;
    byJurisdiction: Record<string, Cadence>;
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === "")) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...(v as string[])];
}

function cadence(v: unknown, field: string): Cadence {
  if (typeof v !== "string" || !(CADENCES as readonly string[]).includes(v)) {
    throw new Error(`${field} must be one of ${CADENCES.join(" | ")}`);
  }
  return v as Cadence;
}

function cadenceMap(v: unknown, field: string): Record<string, Cadence> {
  if (v === undefined) return {};
  if (!isRecord(v)) throw new Error(`${field} must be an object mapping keys to cadences`);
  const entries = Object.entries(v).map(
    ([k, val]) => [k, cadence(val, `${field}.${k}`)] as const,
  );
  return Object.fromEntries(entries);
}

function parseProfile(raw: unknown): ContextProfile {
  if (!isRecord(raw)) throw new Error("profile must be a JSON object");
  if (typeof raw.profile !== "string" || raw.profile === "") {
    throw new Error("profile (non-empty string) is required");
  }
  if (raw.footprint === undefined) {
    throw new Error("footprint (array of jurisdiction slugs; [] = full globe) is required");
  }
  const depthRaw = raw.depth;
  if (
    depthRaw !== undefined &&
    depthRaw !== null &&
    (typeof depthRaw !== "number" || !Number.isInteger(depthRaw) || depthRaw < 0)
  ) {
    throw new Error("depth must be a non-negative integer or null (all descendants)");
  }
  if (raw.history !== undefined && (typeof raw.history !== "string" || raw.history === "")) {
    throw new Error("history must be a non-empty string, e.g. earliest_published");
  }
  if (
    raw.description !== undefined &&
    (typeof raw.description !== "string" || raw.description === "")
  ) {
    throw new Error("description must be a non-empty string when present");
  }
  // Canonical name is `cadences`; `monitorCadences` is accepted as an alias.
  const cadRaw = raw.cadences ?? raw.monitorCadences;
  if (cadRaw !== undefined && !isRecord(cadRaw)) {
    throw new Error("cadences must be an object with default / byCategory / byJurisdiction");
  }
  const cadences = cadRaw ?? {};
  return {
    profile: raw.profile,
    ...(raw.description !== undefined ? { description: raw.description as string } : {}),
    footprint: stringArray(raw.footprint, "footprint"),
    industries: stringArray(raw.industries, "industries"),
    categories: stringArray(raw.categories, "categories"),
    depth: depthRaw === undefined ? null : (depthRaw as number | null),
    history: (raw.history as string | undefined) ?? "earliest_published",
    cadences: {
      default:
        cadences.default === undefined ? "weekly" : cadence(cadences.default, "cadences.default"),
      byCategory: cadenceMap(cadences.byCategory, "cadences.byCategory"),
      byJurisdiction: cadenceMap(cadences.byJurisdiction, "cadences.byJurisdiction"),
    },
  };
}

function profilePathCandidates(given: string): string[] {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const candidates = [resolve(given)];
  // `pnpm tax` runs from packages/cli; INIT_CWD is where the operator ran it.
  if (process.env.INIT_CWD) candidates.push(resolve(process.env.INIT_CWD, given));
  candidates.push(resolve(repoRoot, given));
  return [...new Set(candidates)];
}

async function contextCompile(profileArg: string, save: boolean) {
  const tried = profilePathCandidates(profileArg);
  const found = tried.find((p) => existsSync(p));
  if (!found) {
    out({ error: "profile_not_found", profile: profileArg, tried });
    process.exitCode = 2;
    return;
  }
  let profile: ContextProfile;
  try {
    profile = parseProfile(JSON.parse(readFileSync(found, "utf8")) as unknown);
  } catch (err: unknown) {
    out({
      error: "invalid_profile",
      profile: profileArg,
      detail: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 2;
    return;
  }

  const all = await db
    .select({ id: jurisdictions.id, slug: jurisdictions.slug, parentId: jurisdictions.parentId })
    .from(jurisdictions);
  const bySlug = new Map(all.map((j) => [j.slug, j]));
  const byId = new Map(all.map((j) => [j.id, j]));
  const children = new Map<string, typeof all>();
  for (const j of all) {
    if (!j.parentId) continue;
    children.set(j.parentId, [...(children.get(j.parentId) ?? []), j]);
  }

  const unknownSlugs = profile.footprint.filter((s) => !bySlug.has(s));
  if (unknownSlugs.length > 0) {
    out({
      error: "unknown_jurisdiction",
      profile: profile.profile,
      unknownSlugs,
      instruction:
        "Unknown jurisdiction slug(s); register jurisdiction structure before compiling. Agents never self-expand scope — widening the fence means registering structure and recompiling.",
    });
    process.exitCode = 2;
    return;
  }

  const included = new Set<string>();
  if (profile.footprint.length === 0) {
    // Empty footprint = full globe: every registered jurisdiction.
    for (const j of all) included.add(j.id);
  } else {
    for (const slug of profile.footprint) {
      const root = bySlug.get(slug);
      if (!root) continue; // unreachable: unknown slugs rejected above
      // Ancestors are always included (rate stacking / conformity).
      const walkSeen = new Set<string>();
      let cur: typeof root | undefined = root;
      while (cur && !walkSeen.has(cur.id)) {
        walkSeen.add(cur.id);
        included.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      // Descendants of the footprint root only, to `depth` (null = all).
      // Ancestors' other descendants (siblings) are never pulled in.
      const visited = new Set<string>([root.id]);
      let frontier = [root];
      let level = 0;
      while (frontier.length > 0 && (profile.depth === null || level < profile.depth)) {
        const next: typeof all = [];
        for (const node of frontier) {
          for (const child of children.get(node.id) ?? []) {
            included.add(child.id);
            if (!visited.has(child.id)) {
              visited.add(child.id);
              next.push(child);
            }
          }
        }
        frontier = next;
        level += 1;
      }
    }
  }

  const jurisdictionSlugs = all
    .filter((j) => included.has(j.id))
    .map((j) => j.slug)
    .sort();

  const compiled: Record<string, unknown> = {
    profile: profile.profile,
    ...(profile.description !== undefined ? { description: profile.description } : {}),
    footprint: profile.footprint,
    jurisdictions: jurisdictionSlugs,
    jurisdictionCount: jurisdictionSlugs.length,
    categories: profile.categories,
    industries: profile.industries,
    depth: profile.depth,
    history: profile.history,
    cadences: profile.cadences,
  };

  if (!save) {
    out(compiled);
    return;
  }

  const firstFootprint =
    profile.footprint[0] !== undefined ? bySlug.get(profile.footprint[0]) : undefined;
  const [row] = await db
    .insert(scopeRuns)
    .values({
      profileName: profile.profile,
      rootJurisdictionId: firstFootprint?.id ?? null,
      scopeJson: compiled,
      status: "active",
    })
    .returning({ id: scopeRuns.id });
  out({ ...compiled, saved: true, scopeRunId: row?.id ?? null, status: "active" });
}

// ---------------------------------------------------------------------------
// Work contract (issue #1): scope + assignment lifecycle over
// scope_runs/agent_runs. Envelopes are documented in
// docs/harness-contract.md. Proposals/publish gate land with #4/#13.
// ---------------------------------------------------------------------------
const ROLES = ["orchestrator", "fetch", "decision", "reviewer"] as const;
type Role = (typeof ROLES)[number];
const MAX_ATTEMPTS = 3;

function argVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function jurisdictionBySlug(slug: string) {
  const [j] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  return j;
}

async function scopeStart(profileArg: string, goalRef?: string) {
  // Reuse the compiler in-process by compiling with save semantics here.
  const tried = profilePathCandidates(profileArg);
  const found = tried.find((p) => existsSync(p));
  if (!found) { out({ error: "profile_not_found", profile: profileArg, tried }); process.exitCode = 2; return; }
  let profile: ContextProfile;
  try { profile = parseProfile(JSON.parse(readFileSync(found, "utf8")) as unknown); }
  catch (err: unknown) { out({ error: "invalid_profile", detail: err instanceof Error ? err.message : String(err) }); process.exitCode = 2; return; }
  const all = await db.select({ id: jurisdictions.id, slug: jurisdictions.slug, parentId: jurisdictions.parentId }).from(jurisdictions);
  const bySlug = new Map(all.map((j) => [j.slug, j]));
  const unknownSlugs = profile.footprint.filter((s) => !bySlug.has(s));
  if (unknownSlugs.length > 0) { out({ error: "unknown_jurisdiction", unknownSlugs }); process.exitCode = 2; return; }
  const byId = new Map(all.map((j) => [j.id, j]));
  const included = new Set<string>();
  if (profile.footprint.length === 0) for (const j of all) included.add(j.id);
  else for (const slug of profile.footprint) {
    let cur = bySlug.get(slug);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); included.add(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    // descendants to depth
    const kids = new Map<string, typeof all>();
    for (const j of all) if (j.parentId) kids.set(j.parentId, [...(kids.get(j.parentId) ?? []), j]);
    let frontier = [bySlug.get(slug)!]; let level = 0;
    const visited = new Set(frontier.map((f) => f.id));
    while (frontier.length && (profile.depth === null || level < profile.depth)) {
      const next: typeof all = [];
      for (const n of frontier) for (const c of kids.get(n.id) ?? []) { included.add(c.id); if (!visited.has(c.id)) { visited.add(c.id); next.push(c); } }
      frontier = next; level += 1;
    }
  }
  const slugs = all.filter((j) => included.has(j.id)).map((j) => j.slug).sort();
  const compiled = { profile: profile.profile, footprint: profile.footprint, jurisdictions: slugs, jurisdictionCount: slugs.length, categories: profile.categories, industries: profile.industries, depth: profile.depth, history: profile.history, cadences: profile.cadences };
  const first = profile.footprint[0] ? bySlug.get(profile.footprint[0]) : undefined;
  const [row] = await db.insert(scopeRuns).values({ profileName: profile.profile, rootJurisdictionId: first?.id ?? null, scopeJson: compiled, status: "active", goalRef: goalRef ?? null }).returning({ id: scopeRuns.id });
  out({ scopeRunId: row?.id ?? null, status: "active", ...compiled });
}

async function scopeStatus(id: string) {
  const [scope] = await db.select().from(scopeRuns).where(eq(scopeRuns.id, id)).limit(1);
  if (!scope) { out({ error: "scope_not_found", id }); process.exitCode = 2; return; }
  const runs = await db.select({ role: agentRuns.role, status: agentRuns.status, n: count() }).from(agentRuns).where(eq(agentRuns.scopeRunId, id)).groupBy(agentRuns.role, agentRuns.status);
  out({ scopeRunId: id, profileName: scope.profileName, status: scope.status, goalRef: scope.goalRef, scopeJson: scope.scopeJson, runs });
}

async function workEnqueue(args: string[]) {
  const scopeId = argVal(args, "--scope"); const role = argVal(args, "--role") as Role | undefined;
  const jurSlug = argVal(args, "--jurisdiction"); const unit = argVal(args, "--unit") ?? "discover";
  const taxTypeSlug = argVal(args, "--tax-type"); const model = argVal(args, "--model");
  if (!scopeId || !role || !(ROLES as readonly string[]).includes(role) || !jurSlug) {
    out({ error: "usage: tax work enqueue --scope <uuid> --role <role> --jurisdiction <slug> [--tax-type <slug>] [--unit <unit>] [--model <id>]" }); process.exitCode = 2; return;
  }
  const [scope] = await db.select().from(scopeRuns).where(eq(scopeRuns.id, scopeId)).limit(1);
  if (!scope) { out({ error: "scope_not_found", scopeId }); process.exitCode = 2; return; }
  const allowed = ((scope.scopeJson as Record<string, unknown>).jurisdictions as string[] | undefined) ?? [];
  if (!allowed.includes(jurSlug)) { out({ error: "outside_context_fence", jurisdiction: jurSlug, instruction: "Jurisdiction is outside the compiled context scope. Widen the profile and recompile; agents never self-expand scope." }); process.exitCode = 2; return; }
  const jur = await jurisdictionBySlug(jurSlug);
  if (!jur) { out({ error: "unknown_jurisdiction", jurisdiction: jurSlug }); process.exitCode = 2; return; }
  let taxTypeId: string | null = null;
  if (taxTypeSlug) {
    const [tt] = await db.select().from(taxTypes).where(eq(taxTypes.slug, taxTypeSlug)).limit(1);
    if (!tt) { out({ error: "unknown_tax_type", taxType: taxTypeSlug }); process.exitCode = 2; return; }
    const cats = ((scope.scopeJson as Record<string, unknown>).categories as string[] | undefined) ?? [];
    if (cats.length > 0 && !cats.includes(tt.category)) {
      out({ error: "outside_context_fence", taxType: taxTypeSlug, category: tt.category, instruction: "Tax category is outside the compiled context profile. Widen the profile and recompile." });
      process.exitCode = 2; return;
    }
    taxTypeId = tt.id;
  }
  const [row] = await db.insert(agentRuns).values({ scopeRunId: scopeId, role, model: model ?? null, jurisdictionId: jur.id, taxTypeId, unit, status: "queued", attempt: 1 }).returning({ id: agentRuns.id });
  out({ assignmentId: row?.id ?? null, scopeRunId: scopeId, role, unit, jurisdiction: jurSlug, taxType: taxTypeSlug ?? null, status: "queued", attempt: 1 });
}

async function resolveContextPacks(jurisdictionId: string | null) {
  if (!jurisdictionId) return [];
  const all = await db.select().from(jurisdictions);
  const byId = new Map(all.map((j) => [j.id, j]));
  const chain: typeof all = [];
  let cur = byId.get(jurisdictionId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); chain.push(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
  const packs: unknown[] = [];
  for (const j of chain) {
    const rows = await db.select().from(jurisdictionContext)
      .where(sql`${jurisdictionContext.jurisdictionId} = ${j.id} and ${jurisdictionContext.status} = 'active'`)
      .orderBy(desc(jurisdictionContext.version)).limit(1);
    const p = rows[0];
    if (p) packs.push({ jurisdiction: j.slug, version: p.version, guidance: p.guidance, memory: p.memory, author: p.author });
  }
  return packs;
}

async function envelopeFor(run: typeof agentRuns.$inferSelect) {
  const jur = run.jurisdictionId ? (await db.select().from(jurisdictions).where(eq(jurisdictions.id, run.jurisdictionId)).limit(1))[0] : undefined;
  const tt = run.taxTypeId ? (await db.select().from(taxTypes).where(eq(taxTypes.id, run.taxTypeId)).limit(1))[0] : undefined;
  return {
    assignment: {
      v: 1, assignmentId: run.id, scopeRunId: run.scopeRunId, role: run.role, unit: run.unit,
      jurisdiction: jur?.slug ?? null, taxType: tt?.slug ?? null, attempt: run.attempt, maxAttempts: MAX_ATTEMPTS,
      model: run.model ?? loadRoleModels()[run.role]?.model ?? loadRoleModels()[run.role]?.deployment ?? null,
      contextPacks: await resolveContextPacks(run.jurisdictionId), // pre-run hook: local expert guidance, most specific first
      instructions: [
        "Check first: pnpm tax ledger check for this jurisdiction; reuse validated determinations.",
        "Primary government sources only; vendor content is noted-only.",
        "End with handoff notes via tax work submit.",
      ],
    },
  };
}

async function workNext(args: string[]) {
  const role = argVal(args, "--role") as Role | undefined;
  const scopeId = argVal(args, "--scope");
  if (!role || !(ROLES as readonly string[]).includes(role)) { out({ error: "usage: tax work next --role <role> [--scope <uuid>]" }); process.exitCode = 2; return; }
  const where = scopeId
    ? and(eq(agentRuns.role, role), eq(agentRuns.status, "queued"), eq(agentRuns.scopeRunId, scopeId))
    : and(eq(agentRuns.role, role), eq(agentRuns.status, "queued"));
  const rows = await db.select().from(agentRuns).where(where).orderBy(agentRuns.createdAt).limit(1);
  const run = rows[0];
  if (!run) { out({ assignment: null, instruction: "No queued work for this role." }); return; }
  out(await envelopeFor(run));
}

async function workClaim(id: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  if (!run) { out({ error: "assignment_not_found", id }); process.exitCode = 2; return; }
  if (run.status !== "queued") { out({ error: "not_claimable", status: run.status }); process.exitCode = 2; return; }
  if (run.attempt > MAX_ATTEMPTS) { out({ error: "attempt_cap_exceeded", attempt: run.attempt, maxAttempts: MAX_ATTEMPTS }); process.exitCode = 2; return; }
  await db.update(agentRuns).set({ status: "running", startedAt: new Date(), updatedAt: new Date() }).where(eq(agentRuns.id, id));
  out({ assignmentId: id, status: "running", attempt: run.attempt });
}

async function workSubmit(args: string[]) {
  const id = argVal(args, "--id"); const st = argVal(args, "--status");
  if (!id || (st !== "completed" && st !== "failed")) { out({ error: "usage: tax work submit --id <uuid> --status completed|failed [--notes <text>] [--tokens-in N] [--tokens-out N] [--cost-usd X] [--model <id>]" }); process.exitCode = 2; return; }
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  if (!run) { out({ error: "assignment_not_found", id }); process.exitCode = 2; return; }
  const num = (v?: string) => (v === undefined ? null : Number(v));
  await db.update(agentRuns).set({
    status: st, finishedAt: new Date(), updatedAt: new Date(),
    handoffNotes: argVal(args, "--notes") ?? run.handoffNotes,
    tokensIn: num(argVal(args, "--tokens-in")), tokensOut: num(argVal(args, "--tokens-out")),
    costUsd: argVal(args, "--cost-usd") ?? null, model: argVal(args, "--model") ?? run.model,
  }).where(eq(agentRuns.id, id));
  out({
    result: { v: 1, assignmentId: id, status: st, attempt: run.attempt,
      notifyOrchestrator: st === "failed" && run.attempt >= MAX_ATTEMPTS,
      instruction: st === "failed" ? (run.attempt >= MAX_ATTEMPTS ? "Attempt cap reached: assignment failed permanently; orchestrator notified via status." : "Retryable: tax work retry --id <uuid> creates the next attempt.") : "Recorded. Handoff notes saved for future agents." },
  });
}

async function workRetry(id: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  if (!run) { out({ error: "assignment_not_found", id }); process.exitCode = 2; return; }
  if (run.status !== "failed") { out({ error: "not_failed", status: run.status }); process.exitCode = 2; return; }
  if (run.attempt >= MAX_ATTEMPTS) { out({ error: "attempt_cap_exceeded", attempt: run.attempt, maxAttempts: MAX_ATTEMPTS, notifyOrchestrator: true }); process.exitCode = 2; return; }
  const [row] = await db.insert(agentRuns).values({ scopeRunId: run.scopeRunId, role: run.role, model: run.model, jurisdictionId: run.jurisdictionId, taxTypeId: run.taxTypeId, unit: run.unit, status: "queued", attempt: run.attempt + 1 }).returning({ id: agentRuns.id });
  out({ assignmentId: row?.id ?? null, retryOf: id, attempt: run.attempt + 1, status: "queued" });
}

async function contextPackList(slug: string) {
  const jur = await jurisdictionBySlug(slug);
  if (!jur) { out({ error: "unknown_jurisdiction", jurisdiction: slug }); process.exitCode = 2; return; }
  out({ jurisdiction: slug, resolvedPacks: await resolveContextPacks(jur.id), note: "Guidance only — never evidence; conflicts with primaries raise typed exceptions." });
}

async function contextPackAdd(args: string[]) {
  const slug = argVal(args, "--jurisdiction"); const author = argVal(args, "--author"); const guidance = argVal(args, "--guidance");
  if (!slug || !author || !guidance) { out({ error: "usage: tax context-pack add --jurisdiction <slug> --author <name> --guidance <text> [--memory <text>]" }); process.exitCode = 2; return; }
  const jur = await jurisdictionBySlug(slug);
  if (!jur) { out({ error: "unknown_jurisdiction", jurisdiction: slug }); process.exitCode = 2; return; }
  const existing = await db.select({ v: jurisdictionContext.version }).from(jurisdictionContext).where(eq(jurisdictionContext.jurisdictionId, jur.id)).orderBy(desc(jurisdictionContext.version)).limit(1);
  const version = (existing[0]?.v ?? 0) + 1;
  const [row] = await db.insert(jurisdictionContext).values({ jurisdictionId: jur.id, version, guidance, memory: argVal(args, "--memory") ?? null, author, status: "proposed" }).returning({ id: jurisdictionContext.id });
  out({ contextPackId: row?.id ?? null, jurisdiction: slug, version, status: "proposed", instruction: "Human approves memory/guidance changes: tax context-pack approve --id <uuid> --approved-by <name>" });
}

async function contextPackApprove(args: string[]) {
  const id = argVal(args, "--id"); const by = argVal(args, "--approved-by");
  if (!id || !by) { out({ error: "usage: tax context-pack approve --id <uuid> --approved-by <name>" }); process.exitCode = 2; return; }
  const [pack] = await db.select().from(jurisdictionContext).where(eq(jurisdictionContext.id, id)).limit(1);
  if (!pack) { out({ error: "context_pack_not_found", id }); process.exitCode = 2; return; }
  if (pack.author === by) { out({ error: "self_approval_rejected", instruction: "Approver must differ from pack author." }); process.exitCode = 2; return; }
  await db.update(jurisdictionContext).set({ status: "active", approvedBy: by, updatedAt: new Date() }).where(eq(jurisdictionContext.id, id));
  out({ contextPackId: id, status: "active", approvedBy: by });
}

async function coveragePacks() {
  const rows = await db.select({ category: coverageQuestions.category, n: count() }).from(coverageQuestions).groupBy(coverageQuestions.category).orderBy(coverageQuestions.category);
  out({ packs: rows, totalQuestions: rows.reduce((a, r) => a + r.n, 0) });
}

async function coverageOpen(args: string[]) {
  const slug = argVal(args, "--jurisdiction");
  if (!slug) { out({ error: "usage: tax coverage open --jurisdiction <slug>" }); process.exitCode = 2; return; }
  const jur = await jurisdictionBySlug(slug);
  if (!jur) { out({ error: "unknown_jurisdiction", jurisdiction: slug }); process.exitCode = 2; return; }
  // Peer-profile catalog: every category present anywhere in tax_types,
  // plus conformity for US states. New categories discovered anywhere
  // back-ask every open jurisdiction on its next coverage open.
  const typeRows = await db.select({ id: taxTypes.id, slug: taxTypes.slug, category: taxTypes.category, jurisdictionId: taxTypes.jurisdictionId }).from(taxTypes);
  const ownTypes = typeRows.filter((t) => t.jurisdictionId === jur.id);
  const catalogCategories = [...new Set(typeRows.map((t) => t.category))];
  const questions = await db.select().from(coverageQuestions);
  const existing = await db.select({ taxTypeId: coverageAnswers.taxTypeId, questionKey: coverageAnswers.questionKey }).from(coverageAnswers).where(eq(coverageAnswers.jurisdictionId, jur.id));
  const have = new Set(existing.map((e) => `${e.taxTypeId ?? "jur"}:${e.questionKey}`));
  let created = 0;
  // Per own tax type: its category pack.
  for (const tt of ownTypes) {
    for (const q of questions.filter((x) => x.category === tt.category)) {
      const key = `${tt.id}:${q.questionKey}`;
      if (have.has(key)) continue;
      await db.insert(coverageAnswers).values({ jurisdictionId: jur.id, taxTypeId: tt.id, questionKey: q.questionKey, status: "unknown" });
      created += 1;
    }
  }
  // Jurisdiction-level peer interrogation: one existence question per
  // catalog category this jurisdiction has no tax type for.
  const ownCats = new Set(ownTypes.map((t) => t.category));
  for (const cat of catalogCategories) {
    if (ownCats.has(cat)) continue;
    const qk = `peer_existence.${cat}`;
    if (have.has(`jur:${qk}`)) continue;
    await db.insert(coverageAnswers).values({ jurisdictionId: jur.id, taxTypeId: null, questionKey: qk, status: "unknown", evidence: { peerCategory: cat, note: "Peer jurisdictions have this category; determine found (register the tax type) or confirmed_absent with recorded negative search." } });
    created += 1;
  }
  out({ jurisdiction: slug, created, catalogCategories, instruction: "Answer via tax coverage answer; confirmed_absent requires evidence.searches (recorded negative search)." });
}

async function coverageShow(slug: string) {
  const jur = await jurisdictionBySlug(slug);
  if (!jur) { out({ error: "unknown_jurisdiction", jurisdiction: slug }); process.exitCode = 2; return; }
  const rows = await db.select({ status: coverageAnswers.status, n: count() }).from(coverageAnswers).where(eq(coverageAnswers.jurisdictionId, jur.id)).groupBy(coverageAnswers.status);
  const total = rows.reduce((a, r) => a + r.n, 0);
  const unknown = rows.find((r) => r.status === "unknown")?.n ?? 0;
  out({ jurisdiction: slug, total, byStatus: rows, coverageComplete: total > 0 && unknown === 0 });
}

async function coverageAnswer(args: string[]) {
  const slug = argVal(args, "--jurisdiction"); const qk = argVal(args, "--question"); const st = argVal(args, "--status");
  const answer = argVal(args, "--answer"); const searches = argVal(args, "--searches");
  if (!slug || !qk || !st || !["found", "confirmed_absent", "unknown"].includes(st)) {
    out({ error: "usage: tax coverage answer --jurisdiction <slug> [--tax-type <slug>] --question <key> --status found|confirmed_absent|unknown [--answer <text>] [--searches <semicolon-list>]" }); process.exitCode = 2; return;
  }
  if (st === "confirmed_absent" && !searches) {
    out({ error: "absence_requires_searches", instruction: "confirmed_absent requires --searches recording the negative search (authority index, statutes, queries tried)." }); process.exitCode = 2; return;
  }
  const jur = await jurisdictionBySlug(slug);
  if (!jur) { out({ error: "unknown_jurisdiction", jurisdiction: slug }); process.exitCode = 2; return; }
  let taxTypeId: string | null = null;
  const ttSlug = argVal(args, "--tax-type");
  if (ttSlug) {
    const [tt] = await db.select().from(taxTypes).where(eq(taxTypes.slug, ttSlug)).limit(1);
    if (!tt) { out({ error: "unknown_tax_type", taxType: ttSlug }); process.exitCode = 2; return; }
    taxTypeId = tt.id;
  }
  const rows = await db.select().from(coverageAnswers).where(sql`${coverageAnswers.jurisdictionId} = ${jur.id} and ${coverageAnswers.questionKey} = ${qk} and ${taxTypeId ? sql`${coverageAnswers.taxTypeId} = ${taxTypeId}` : sql`${coverageAnswers.taxTypeId} is null`}`).limit(1);
  const evidence = searches ? { searches: searches.split(";").map((s) => s.trim()).filter(Boolean) } : {};
  if (rows[0]) {
    await db.update(coverageAnswers).set({ status: st, answer: answer ?? rows[0].answer, evidence, updatedAt: new Date() }).where(eq(coverageAnswers.id, rows[0].id));
    out({ updated: rows[0].id, question: qk, status: st });
  } else {
    const [row] = await db.insert(coverageAnswers).values({ jurisdictionId: jur.id, taxTypeId, questionKey: qk, status: st, answer: answer ?? null, evidence }).returning({ id: coverageAnswers.id });
    out({ created: row?.id ?? null, question: qk, status: st });
  }
}

async function reviewList() {
  const rows = await db.select({ questionKey: researchLedger.questionKey, determination: researchLedger.determination, status: researchLedger.status, jurisdictionId: researchLedger.jurisdictionId })
    .from(researchLedger).where(eq(researchLedger.status, "pending_review")).limit(50);
  out({ pendingReview: rows, count: rows.length, note: "Proposal-based review queue lands with schema issue #4; this lists ledger determinations awaiting review." });
}

// ponytail: minimal YAML reader for our own config files (flat role blocks
// only). Swap for a real YAML parser if configs gain nesting beyond this.
function loadRoleModels(): Record<string, { provider: string; model: string | null; deployment: string | null }> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const path = resolve(repoRoot, "config/models.yaml");
  const result: Record<string, { provider: string; model: string | null; deployment: string | null }> = {};
  if (!existsSync(path)) return result;
  let current: string | null = null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const role = line.match(/^ {2}(orchestrator|fetch|decision|reviewer|embedder):\s*$/);
    if (role) { current = role[1]!; result[current] = { provider: "harness", model: null, deployment: null }; continue; }
    if (!current) continue;
    const kv = line.match(/^ {4}(provider|model|deployment):\s*(.+?)\s*(?:#.*)?$/);
    if (kv) {
      const val = kv[2]!.replace(/\$\{([A-Z0-9_]+):-([^}]*)\}/g, (_m, name: string, dflt: string) => process.env[name] ?? dflt);
      if (kv[1] === "provider") result[current]!.provider = val;
      if (kv[1] === "model") result[current]!.model = val;
      if (kv[1] === "deployment") result[current]!.deployment = val || null;
    }
  }
  return result;
}

async function configShow() {
  const roles = loadRoleModels();
  out({
    roles,
    foundry: {
      endpointConfigured: Boolean(process.env.AZURE_AI_FOUNDRY_ENDPOINT),
      apiKeyConfigured: Boolean(process.env.AZURE_AI_FOUNDRY_API_KEY),
      embeddingDeployment: process.env.AZURE_AI_EMBEDDING_DEPLOYMENT ?? null,
    },
    analyticsFile: "config/analytics.yaml (mode private by default)",
    note: "Mix and match any model per role. provider=harness uses the running harness's model; provider=foundry calls the deployment directly (headless runner consumes identical envelopes).",
  });
}

async function scopeDispatch(scopeId: string) {
  const [scope] = await db.select().from(scopeRuns).where(eq(scopeRuns.id, scopeId)).limit(1);
  if (!scope) { out({ error: "scope_not_found", scopeId }); process.exitCode = 2; return; }
  const slugs = ((scope.scopeJson as Record<string, unknown>).jurisdictions as string[] | undefined) ?? [];
  const existing = await db.select({ jurisdictionId: agentRuns.jurisdictionId }).from(agentRuns)
    .where(sql`${agentRuns.scopeRunId} = ${scopeId} and ${agentRuns.role} = 'fetch' and ${agentRuns.unit} = 'discover' and ${agentRuns.status} in ('queued','running','completed')`);
  const covered = new Set(existing.map((e) => e.jurisdictionId));
  let created = 0;
  for (const slug of slugs) {
    const jur = await jurisdictionBySlug(slug);
    if (!jur || covered.has(jur.id)) continue;
    await db.insert(agentRuns).values({ scopeRunId: scopeId, role: "fetch", jurisdictionId: jur.id, unit: "discover", status: "queued", attempt: 1 });
    created += 1;
  }
  // Orchestrator run record for the dispatch itself.
  await db.insert(agentRuns).values({ scopeRunId: scopeId, role: "orchestrator", unit: "dispatch", status: "completed", attempt: 1, startedAt: new Date(), finishedAt: new Date(), handoffNotes: `Dispatched ${created} discover assignments across ${slugs.length} in-scope jurisdictions. Structure before depth; ledger check-first applies per assignment.` });
  out({ scopeRunId: scopeId, dispatched: created, inScopeJurisdictions: slugs.length, instruction: "Fetch role: pnpm tax work next --role fetch. Orchestrator never fetches or decides." });
}

async function sourceClassify(args: string[]) {
  const url = argVal(args, "--url"); const publisherType = argVal(args, "--publisher") ?? "government";
  const eligibility = argVal(args, "--eligibility") ?? "eligible";
  if (!url || !["government", "vendor", "other"].includes(publisherType) || !["eligible", "noted_only", "prohibited", "gov_login_gated"].includes(eligibility)) {
    out({ error: "usage: tax source classify --url <url> [--publisher government|vendor|other] [--eligibility eligible|noted_only|prohibited|gov_login_gated] [--name <name>] [--jurisdiction <slug>] [--reason <text>]" }); process.exitCode = 2; return;
  }
  if (publisherType === "vendor" && eligibility === "eligible") {
    out({ error: "vendor_never_eligible", instruction: "Vendor sources are noted_only at best (source policy). Classify as noted_only and find the government primary." }); process.exitCode = 2; return;
  }
  let jurisdictionId: string | null = null;
  const js = argVal(args, "--jurisdiction");
  if (js) { const j = await jurisdictionBySlug(js); if (!j) { out({ error: "unknown_jurisdiction", jurisdiction: js }); process.exitCode = 2; return; } jurisdictionId = j.id; }
  const [row] = await db.insert(sources).values({ name: argVal(args, "--name") ?? url, url, publisherType, eligibility, exclusionReason: argVal(args, "--reason") ?? null, jurisdictionId, sourceType: argVal(args, "--type") ?? "agency_guidance", isAuthoritative: publisherType === "government" && eligibility === "eligible" })
    .onConflictDoUpdate({ target: sources.url, set: { publisherType, eligibility, updatedAt: new Date() } }).returning({ id: sources.id });
  out({ sourceId: row?.id ?? null, url, publisherType, eligibility, fetchable: eligibility === "eligible" });
}

async function doFetch(source: typeof sources.$inferSelect, runId?: string) {
  const started = Date.now();
  let httpStatus: number | null = null; let body = ""; let fetchError: string | null = null;
  try {
    const res = await fetch(source.url, { headers: { "user-agent": "agent-tax-research/0.1 (primary-source research; respectful rate)" }, redirect: "follow" });
    httpStatus = res.status; body = await res.text();
  } catch (e: unknown) { fetchError = e instanceof Error ? e.message : String(e); }
  const hash = createHash("sha256").update(body).digest("hex");
  const changed = source.contentHash !== null && source.contentHash !== hash;
  const firstSeen = source.contentHash === null;
  let snapshotId: string | null = null;
  if (!fetchError && httpStatus !== null && httpStatus < 400) {
    const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200000);
    const [snap] = await db.insert(sourceSnapshots).values({ sourceId: source.id, contentHash: hash, retrievedText: text, fetchedByRunId: runId ?? null }).returning({ id: sourceSnapshots.id });
    snapshotId = snap?.id ?? null;
    await db.update(sources).set({ contentHash: hash, lastCheckedAt: new Date(), ...(changed ? { lastChangedAt: new Date() } : {}), updatedAt: new Date() }).where(eq(sources.id, source.id));
  }
  await db.insert(sourceChecks).values({ sourceId: source.id, checkedBy: runId ?? "fetch-cli", httpStatus, contentHash: fetchError ? null : hash, changed, notes: fetchError ?? (firstSeen ? "first snapshot" : changed ? "content changed" : "unchanged") });
  return { sourceId: source.id, url: source.url, snapshotId, contentHash: fetchError ? null : hash, httpStatus, changed, firstSeen, bytes: body.length, wallMs: Date.now() - started, error: fetchError };
}

async function fetchSource(args: string[]) {
  const sourceIdArg = argVal(args, "--source-id"); const urlArg = argVal(args, "--url"); const runId = argVal(args, "--run");
  let source: typeof sources.$inferSelect | undefined;
  if (sourceIdArg) [source] = await db.select().from(sources).where(eq(sources.id, sourceIdArg)).limit(1);
  else if (urlArg) [source] = await db.select().from(sources).where(eq(sources.url, urlArg)).limit(1);
  if (!source) { out({ error: "source_not_found", instruction: "Classify first: tax source classify --url <url> ..." }); process.exitCode = 2; return; }
  if (source.eligibility !== "eligible") {
    out({ error: "source_not_fetchable", eligibility: source.eligibility, instruction: source.eligibility === "noted_only" ? "Noted-only sources are never fetched into context. Find the government primary." : "This source may not be fetched by agents." });
    process.exitCode = 2; return;
  }
  const bundle = await doFetch(source, runId);
  out({ evidenceBundle: bundle });
  if (bundle.error) process.exitCode = 1;
}

async function monitorRefresh(args: string[]) {
  const limit = Number(argVal(args, "--limit") ?? "10");
  const due = await db.select().from(sources)
    .where(sql`${sources.eligibility} = 'eligible' and ${sources.status} = 'active'`)
    .orderBy(sql`${sources.lastCheckedAt} asc nulls first`).limit(Number.isFinite(limit) && limit > 0 ? limit : 10);
  const results: unknown[] = [];
  let changedCount = 0; let failedCount = 0;
  for (const source of due) {
    const b = await doFetch(source, argVal(args, "--run"));
    if (b.error) {
      failedCount += 1;
      await db.insert(exceptions).values({ sourceId: source.id, jurisdictionId: source.jurisdictionId, exceptionType: "transient", severity: "medium", detail: `refresh fetch failed: ${b.error}` });
    }
    if (b.changed) changedCount += 1;
    results.push({ url: b.url, changed: b.changed, firstSeen: b.firstSeen, httpStatus: b.httpStatus, error: b.error });
  }
  out({ refreshed: due.length, changed: changedCount, failed: failedCount, maxAttemptsNote: "Per-source failures retry on next refresh; assignment-level cap is 3 attempts then failed + orchestrator notification.", results });
}

async function proposalCreate(args: string[]) {
  const slug = argVal(args, "--jurisdiction"); const ttSlug = argVal(args, "--tax-type");
  const extractorRunId = argVal(args, "--extractor-run"); const scopeRunId = argVal(args, "--scope");
  if (!slug) { out({ error: "usage: tax proposal create --jurisdiction <slug> [--tax-type <slug>] [--scope <uuid>] [--extractor-run <uuid>]" }); process.exitCode = 2; return; }
  const jur = await jurisdictionBySlug(slug);
  if (!jur) { out({ error: "unknown_jurisdiction", jurisdiction: slug }); process.exitCode = 2; return; }
  let taxTypeId: string | null = null;
  if (ttSlug) { const [tt] = await db.select().from(taxTypes).where(eq(taxTypes.slug, ttSlug)).limit(1); if (!tt) { out({ error: "unknown_tax_type", taxType: ttSlug }); process.exitCode = 2; return; } taxTypeId = tt.id; }
  const [row] = await db.insert(proposals).values({ jurisdictionId: jur.id, taxTypeId, scopeRunId: scopeRunId ?? null, extractorRunId: extractorRunId ?? null, status: "proposed" }).returning({ id: proposals.id });
  out({ proposalId: row?.id ?? null, status: "proposed", instruction: "Decision adds items; Reviewer (distinct run) verifies; human approves last." });
}

async function proposalAddItem(args: string[]) {
  const proposalId = argVal(args, "--proposal"); const targetTable = argVal(args, "--target");
  const payloadFile = argVal(args, "--payload-file");
  const payloadRaw = payloadFile ? readFileSync(payloadFile, "utf8") : argVal(args, "--payload");
  const citation = argVal(args, "--citation");
  const sourceId = argVal(args, "--source-id"); const snapshotId = argVal(args, "--snapshot-id");
  if (!proposalId || !targetTable || !payloadRaw) { out({ error: "usage: tax proposal add-item --proposal <uuid> --target tax_rates|tax_rules|tax_licenses|tax_compliance --payload <json> [--citation <text>] [--source-id <uuid>] [--snapshot-id <uuid>]" }); process.exitCode = 2; return; }
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(payloadRaw) as Record<string, unknown>; } catch { out({ error: "payload_not_json" }); process.exitCode = 2; return; }
  const [row] = await db.insert(proposalItems).values({ proposalId, targetTable, payload, citation: citation ?? null, sourceId: sourceId ?? null, snapshotId: snapshotId ?? null, verdict: "pending" }).returning({ id: proposalItems.id });
  out({ proposalItemId: row?.id ?? null, verdict: "pending" });
}

async function ledgerRecord(args: string[]) {
  const slug = argVal(args, "--jurisdiction"); const qk = argVal(args, "--question");
  const det = argVal(args, "--determination"); const status = argVal(args, "--status") ?? "pending_review";
  const hash = argVal(args, "--snapshot-hash"); const runId = argVal(args, "--run"); const reason = argVal(args, "--invalidated-reason");
  if (!slug || !qk || !det || !["validated", "pending_review", "invalidated"].includes(status)) {
    out({ error: "usage: tax ledger record --jurisdiction <slug> --question <key> --determination <text> [--status validated|pending_review|invalidated] [--snapshot-hash <hash>] [--run <uuid>] [--invalidated-reason <reason>]" }); process.exitCode = 2; return;
  }
  if (status === "invalidated" && !reason) { out({ error: "invalidation_requires_reason", allowed: ["source_changed", "human_objection", "cadence_expired", "context_changed", "pack_changed"] }); process.exitCode = 2; return; }
  const jur = await jurisdictionBySlug(slug);
  if (!jur) { out({ error: "unknown_jurisdiction", jurisdiction: slug }); process.exitCode = 2; return; }
  let taxTypeId: string | null = null;
  const ttSlug = argVal(args, "--tax-type");
  if (ttSlug) { const [tt] = await db.select().from(taxTypes).where(eq(taxTypes.slug, ttSlug)).limit(1); if (!tt) { out({ error: "unknown_tax_type", taxType: ttSlug }); process.exitCode = 2; return; } taxTypeId = tt.id; }
  const [row] = await db.insert(researchLedger).values({ jurisdictionId: jur.id, taxTypeId, questionKey: qk, determination: det, status, snapshotHash: hash ?? null, validatedByRunId: runId ?? null, validatedAt: status === "validated" ? new Date() : null, invalidatedReason: reason ?? null }).returning({ id: researchLedger.id });
  out({ ledgerId: row?.id ?? null, question: qk, status, instruction: status === "validated" ? "Future runs must reuse this while the snapshot hash matches." : "Recorded." });
}

async function proposalVerify(args: string[]) {
  const id = argVal(args, "--id"); const verifierRunId = argVal(args, "--verifier-run");
  if (!id || !verifierRunId) { out({ error: "usage: tax proposal verify --id <uuid> --verifier-run <agent_run uuid>" }); process.exitCode = 2; return; }
  const [prop] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  if (!prop) { out({ error: "proposal_not_found", id }); process.exitCode = 2; return; }
  if (prop.extractorRunId && prop.extractorRunId === verifierRunId) { out({ error: "self_verification_rejected", instruction: "Reviewer run must differ from extractor run." }); process.exitCode = 2; return; }
  const items = await db.select().from(proposalItems).where(eq(proposalItems.proposalId, id));
  const verdicts: { itemId: string; verdict: string; reasons: string[] }[] = [];
  for (const item of items) {
    const reasons: string[] = [];
    let src: typeof sources.$inferSelect | undefined;
    if (item.sourceId) [src] = await db.select().from(sources).where(eq(sources.id, item.sourceId)).limit(1);
    if (!src) reasons.push("missing source");
    else if (src.eligibility !== "eligible") reasons.push(`source not eligible (${src.eligibility})`);
    if (!item.snapshotId) reasons.push("missing snapshot evidence");
    if (!item.citation) reasons.push("missing citation");
    if (Object.keys(item.payload).length === 0) reasons.push("empty payload");
    const verdict = reasons.length === 0 ? "pass" : "fail";
    await db.update(proposalItems).set({ verdict, updatedAt: new Date() }).where(eq(proposalItems.id, item.id));
    verdicts.push({ itemId: item.id, verdict, reasons });
  }
  const allPass = verdicts.length > 0 && verdicts.every((v) => v.verdict === "pass");
  await db.update(proposals).set({ verifierRunId, status: allPass ? "verified" : "proposed", updatedAt: new Date() }).where(eq(proposals.id, id));
  out({ proposalId: id, status: allPass ? "verified" : "proposed", verdicts, instruction: allPass ? "Human approves last: tax proposal approve --id <uuid> --approved-by <name>" : "Fix failed items and re-verify with a distinct reviewer run." });
}

async function proposalApprove(args: string[]) {
  const id = argVal(args, "--id"); const by = argVal(args, "--approved-by");
  if (!id || !by) { out({ error: "usage: tax proposal approve --id <uuid> --approved-by <human name>" }); process.exitCode = 2; return; }
  const [prop] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  if (!prop) { out({ error: "proposal_not_found", id }); process.exitCode = 2; return; }
  if (prop.status !== "verified") { out({ error: "not_verified", status: prop.status }); process.exitCode = 2; return; }
  await db.update(proposals).set({ status: "approved", approvedBy: by, updatedAt: new Date() }).where(eq(proposals.id, id));
  out({ proposalId: id, status: "approved", approvedBy: by });
}

async function proposalPublish(id: string) {
  const [prop] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
  if (!prop) { out({ error: "proposal_not_found", id }); process.exitCode = 2; return; }
  if (prop.status !== "approved") { out({ error: "not_approved", status: prop.status, instruction: "Publish requires reviewer pass + human approval." }); process.exitCode = 2; return; }
  const items = await db.select().from(proposalItems).where(eq(proposalItems.proposalId, id));
  const published: string[] = [];
  for (const item of items) {
    const p = item.payload as Record<string, unknown>;
    if (item.targetTable === "tax_rates") {
      if (!prop.taxTypeId) { out({ error: "publish_needs_tax_type", proposalId: id }); process.exitCode = 2; return; }
      let rateJurisdictionId = prop.jurisdictionId;
      if (typeof p.jurisdictionSlug === "string") {
        const rj = await jurisdictionBySlug(p.jurisdictionSlug);
        if (!rj) { out({ error: "unknown_payload_jurisdiction", slug: p.jurisdictionSlug }); process.exitCode = 2; return; }
        rateJurisdictionId = rj.id;
      }
      const [row] = await db.insert(taxRatesTable).values({
        taxTypeId: prop.taxTypeId, jurisdictionId: rateJurisdictionId, sourceId: item.sourceId,
        rateValue: String(p.rateValue ?? ""), rateUnit: String(p.rateUnit ?? "percent"),
        appliesTo: (p.appliesTo as string) ?? null, conditions: (p.conditions as string) ?? null,
        effectiveFrom: String(p.effectiveFrom ?? new Date().toISOString().slice(0, 10)),
        effectiveTo: (p.effectiveTo as string) ?? null, citation: item.citation, verificationStatus: "verified",
      }).returning({ id: taxRatesTable.id });
      if (row) published.push(`tax_rates:${row.id}`);
    } else if (item.targetTable === "tax_rules") {
      if (!prop.taxTypeId) { out({ error: "publish_needs_tax_type", proposalId: id }); process.exitCode = 2; return; }
      const [row] = await db.insert(taxRulesTable).values({
        taxTypeId: prop.taxTypeId, jurisdictionId: prop.jurisdictionId, sourceId: item.sourceId,
        ruleType: String(p.ruleType ?? "other"), authorityLevel: String(p.authorityLevel ?? "guidance"),
        title: String(p.title ?? "Untitled rule"), summary: (p.summary as string) ?? null, fullText: (p.fullText as string) ?? null,
        effectiveFrom: String(p.effectiveFrom ?? new Date().toISOString().slice(0, 10)),
        effectiveTo: (p.effectiveTo as string) ?? null, citation: item.citation, verificationStatus: "verified",
      }).returning({ id: taxRulesTable.id });
      if (row) published.push(`tax_rules:${row.id}`);
    } else if (item.targetTable === "product_tax_treatments") {
      if (!prop.taxTypeId) { out({ error: "publish_needs_tax_type", proposalId: id }); process.exitCode = 2; return; }
      const categorySlug = typeof p.categorySlug === "string" ? p.categorySlug : null;
      const treatment = typeof p.treatment === "string" ? p.treatment : null;
      if (!categorySlug || !treatment || !["taxable", "exempt", "reduced_rate", "special_rule", "confirmed_absent"].includes(treatment)) {
        out({ error: "bad_treatment_payload", instruction: "payload needs categorySlug + treatment in taxable|exempt|reduced_rate|special_rule|confirmed_absent" }); process.exitCode = 2; return;
      }
      const [cat] = await db.select({ id: productCategoriesTable.id }).from(productCategoriesTable).where(eq(productCategoriesTable.slug, categorySlug)).limit(1);
      if (!cat) { out({ error: "unknown_category", categorySlug }); process.exitCode = 2; return; }
      let treatmentJurisdictionId = prop.jurisdictionId;
      if (typeof p.jurisdictionSlug === "string") {
        const rj = await jurisdictionBySlug(p.jurisdictionSlug);
        if (!rj) { out({ error: "unknown_payload_jurisdiction", slug: p.jurisdictionSlug }); process.exitCode = 2; return; }
        treatmentJurisdictionId = rj.id;
      }
      const [row] = await db.insert(productTreatmentsTable).values({
        categoryId: cat.id, jurisdictionId: treatmentJurisdictionId, taxTypeId: prop.taxTypeId, sourceId: item.sourceId,
        treatment, taxableFraction: p.taxableFraction === undefined || p.taxableFraction === null ? null : String(p.taxableFraction),
        summary: (p.summary as string) ?? null, sourcingRule: (p.sourcingRule as string) ?? null,
        effectiveFrom: String(p.effectiveFrom ?? new Date().toISOString().slice(0, 10)),
        effectiveTo: (p.effectiveTo as string) ?? null, citation: item.citation, verificationStatus: "verified",
      }).returning({ id: productTreatmentsTable.id });
      if (row) published.push(`product_tax_treatments:${row.id}`);
    } else if (item.targetTable === "tax_compliance") {
      if (!prop.taxTypeId) { out({ error: "publish_needs_tax_type", proposalId: id }); process.exitCode = 2; return; }
      let complianceJurisdictionId = prop.jurisdictionId;
      if (typeof p.jurisdictionSlug === "string") {
        const rj = await jurisdictionBySlug(p.jurisdictionSlug);
        if (!rj) { out({ error: "unknown_payload_jurisdiction", slug: p.jurisdictionSlug }); process.exitCode = 2; return; }
        complianceJurisdictionId = rj.id;
      }
      const [row] = await db.insert(taxComplianceTable).values({
        taxTypeId: prop.taxTypeId, jurisdictionId: complianceJurisdictionId, sourceId: item.sourceId,
        obligationType: String(p.obligationType ?? "other"),
        formNumber: (p.formNumber as string) ?? null, formName: (p.formName as string) ?? null,
        formUrl: (p.formUrl as string) ?? null,
        filingFrequency: (p.filingFrequency as string) ?? null, dueDateRule: (p.dueDateRule as string) ?? null,
        filingMethods: (p.filingMethods as string) ?? null, paymentMethods: (p.paymentMethods as string) ?? null,
        collectRemitSummary: (p.collectRemitSummary as string) ?? null,
        effectiveFrom: String(p.effectiveFrom ?? new Date().toISOString().slice(0, 10)),
        effectiveTo: (p.effectiveTo as string) ?? null, citation: item.citation, verificationStatus: "verified",
      }).returning({ id: taxComplianceTable.id });
      if (row) published.push(`tax_compliance:${row.id}`);
    } else if (item.targetTable === "jurisdiction_geo") {
      if (typeof p.jurisdictionSlug !== "string" || typeof p.geometryHash !== "string") {
        out({ error: "bad_geo_payload", instruction: "payload needs jurisdictionSlug + geometryHash" }); process.exitCode = 2; return;
      }
      const rj = await jurisdictionBySlug(p.jurisdictionSlug);
      if (!rj) { out({ error: "unknown_payload_jurisdiction", slug: p.jurisdictionSlug }); process.exitCode = 2; return; }
      const num = (v: unknown) => (v === undefined || v === null ? null : String(v));
      const [row] = await db.insert(jurisdictionGeoTable).values({
        jurisdictionId: rj.id, sourceId: item.sourceId,
        geoKind: String(p.geoKind ?? "boundary"),
        centroidLat: num(p.centroidLat), centroidLng: num(p.centroidLng),
        minLat: num(p.minLat), maxLat: num(p.maxLat), minLng: num(p.minLng), maxLng: num(p.maxLng),
        boundaryGeojson: (p.boundaryGeojson as Record<string, unknown>) ?? null,
        geometryHash: p.geometryHash, simplification: (p.simplification as string) ?? null,
        precision: String(p.precision ?? "published"),
        effectiveFrom: String(p.effectiveFrom ?? new Date().toISOString().slice(0, 10)),
        effectiveTo: (p.effectiveTo as string) ?? null, citation: item.citation, verificationStatus: "verified",
      }).returning({ id: jurisdictionGeoTable.id });
      if (row) published.push(`jurisdiction_geo:${row.id}`);
    } else {
      out({ error: "unsupported_target_v1", targetTable: item.targetTable, instruction: "Publish applies tax_rates, tax_rules and product_tax_treatments; other targets fail closed." }); process.exitCode = 2; return;
    }
  }
  await db.update(proposals).set({ status: "published", updatedAt: new Date() }).where(eq(proposals.id, id));
  out({ proposalId: id, status: "published", published });
}

async function proposalList(status: string) {
  const rows = await db
    .select({
      id: proposals.id, status: proposals.status,
      jurisdiction: jurisdictions.slug, taxType: taxTypes.slug,
      items: sql<number>`(select count(*) from proposal_items pi where pi.proposal_id = ${proposals.id})`,
      summary: sql<string>`(select string_agg(pi.target_table || ':' || coalesce(pi.payload->>'rateValue', pi.payload->>'title', '?'), ', ') from proposal_items pi where pi.proposal_id = ${proposals.id})`,
      createdAt: proposals.createdAt,
    })
    .from(proposals)
    .leftJoin(jurisdictions, eq(proposals.jurisdictionId, jurisdictions.id))
    .leftJoin(taxTypes, eq(proposals.taxTypeId, taxTypes.id))
    .where(eq(proposals.status, status))
    .orderBy(proposals.createdAt);
  out({
    status, count: rows.length, proposals: rows,
    howToApprove: "pnpm tax proposal approve --id <proposalId> --approved-by <your name>  then  pnpm tax proposal publish --id <proposalId>  — or just tell the agent in chat which to approve.",
  });
}

async function analytics() {
  const byRole = await db
    .select({
      role: agentRuns.role,
      runs: count(),
      tokensIn: sql<number>`coalesce(sum(${agentRuns.tokensIn}), 0)`,
      tokensOut: sql<number>`coalesce(sum(${agentRuns.tokensOut}), 0)`,
      costUsd: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)`,
    })
    .from(agentRuns)
    .groupBy(agentRuns.role);
  const byJurisdiction = await db
    .select({
      slug: jurisdictions.slug,
      runs: count(),
      tokens: sql<number>`coalesce(sum(coalesce(${agentRuns.tokensIn}, 0) + coalesce(${agentRuns.tokensOut}, 0)), 0)`,
      failedRuns: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')`,
      maxAttempt: sql<number>`coalesce(max(${agentRuns.attempt}), 0)`,
    })
    .from(agentRuns)
    .leftJoin(jurisdictions, eq(agentRuns.jurisdictionId, jurisdictions.id))
    .groupBy(jurisdictions.slug);
  out({
    mode: "private (default; see config/analytics.yaml)",
    maxAttempts: 3,
    retryRule: "After attempt 3 fails: run failed, exception written, orchestrator notified.",
    runsByRole: byRole,
    runsByJurisdiction: byJurisdiction,
    instruction:
      "Populate/maintain/review cost per jurisdiction accumulates here as runs record tokens, cost, wall time, and attempts. First-run estimates come from benchmarks/ medians.",
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "status") {
    await status();
  } else if (cmd === "analytics") {
    await analytics();
  } else if (cmd === "ledger" && args[1] === "check") {
    const i = args.indexOf("--jurisdiction");
    const slug = i >= 0 ? args[i + 1] : undefined;
    if (!slug) {
      out({ error: "usage: tax ledger check --jurisdiction <slug>" });
      process.exitCode = 2;
      return;
    }
    await ledgerCheck(slug);
  } else if (cmd === "context" && args[1] === "compile") {
    const i = args.indexOf("--profile");
    const profilePath = i >= 0 ? args[i + 1] : undefined;
    if (!profilePath) {
      out({ error: "usage: tax context compile --profile contexts/<name>.json [--save]" });
      process.exitCode = 2;
      return;
    }
    await contextCompile(profilePath, args.includes("--save"));
  } else if (cmd === "scope" && args[1] === "start") {
    const profilePath = argVal(args, "--profile");
    if (!profilePath) { out({ error: "usage: tax scope start --profile contexts/<name>.json [--goal-ref <ref>]" }); process.exitCode = 2; return; }
    await scopeStart(profilePath, argVal(args, "--goal-ref"));
  } else if (cmd === "scope" && args[1] === "dispatch") {
    const id = argVal(args, "--id");
    if (!id) { out({ error: "usage: tax scope dispatch --id <uuid>" }); process.exitCode = 2; return; }
    await scopeDispatch(id);
  } else if (cmd === "scope" && args[1] === "status") {
    const id = argVal(args, "--id");
    if (!id) { out({ error: "usage: tax scope status --id <uuid>" }); process.exitCode = 2; return; }
    await scopeStatus(id);
  } else if (cmd === "work" && args[1] === "enqueue") {
    await workEnqueue(args);
  } else if (cmd === "work" && args[1] === "next") {
    await workNext(args);
  } else if (cmd === "work" && args[1] === "claim") {
    const id = argVal(args, "--id");
    if (!id) { out({ error: "usage: tax work claim --id <uuid>" }); process.exitCode = 2; return; }
    await workClaim(id);
  } else if (cmd === "work" && args[1] === "submit") {
    await workSubmit(args);
  } else if (cmd === "work" && args[1] === "retry") {
    const id = argVal(args, "--id");
    if (!id) { out({ error: "usage: tax work retry --id <uuid>" }); process.exitCode = 2; return; }
    await workRetry(id);
  } else if (cmd === "context-pack" && args[1] === "list") {
    const slug = argVal(args, "--jurisdiction");
    if (!slug) { out({ error: "usage: tax context-pack list --jurisdiction <slug>" }); process.exitCode = 2; return; }
    await contextPackList(slug);
  } else if (cmd === "context-pack" && args[1] === "add") {
    await contextPackAdd(args);
  } else if (cmd === "context-pack" && args[1] === "approve") {
    await contextPackApprove(args);
  } else if (cmd === "coverage" && args[1] === "packs") {
    await coveragePacks();
  } else if (cmd === "coverage" && args[1] === "open") {
    await coverageOpen(args);
  } else if (cmd === "coverage" && args[1] === "show") {
    const slug = argVal(args, "--jurisdiction");
    if (!slug) { out({ error: "usage: tax coverage show --jurisdiction <slug>" }); process.exitCode = 2; return; }
    await coverageShow(slug);
  } else if (cmd === "coverage" && args[1] === "answer") {
    await coverageAnswer(args);
  } else if (cmd === "source" && args[1] === "classify") {
    await sourceClassify(args);
  } else if (cmd === "fetch" && args[1] === "source") {
    await fetchSource(args);
  } else if (cmd === "proposal" && args[1] === "list") {
    await proposalList(argVal(args, "--status") ?? "verified");
  } else if (cmd === "proposal" && args[1] === "create") {
    await proposalCreate(args);
  } else if (cmd === "proposal" && args[1] === "add-item") {
    await proposalAddItem(args);
  } else if (cmd === "proposal" && args[1] === "verify") {
    await proposalVerify(args);
  } else if (cmd === "proposal" && args[1] === "approve") {
    await proposalApprove(args);
  } else if (cmd === "proposal" && args[1] === "publish") {
    const id = argVal(args, "--id");
    if (!id) { out({ error: "usage: tax proposal publish --id <uuid>" }); process.exitCode = 2; return; }
    await proposalPublish(id);
  } else if (cmd === "ledger" && args[1] === "record") {
    await ledgerRecord(args);
  } else if (cmd === "geo" && args[1] === "resolve") {
    const result = await runGeoResolve(args.slice(2));
    if ("error" in result) process.exitCode = 2;
    out(result);
  } else if (cmd === "rate" && args[1] === "at-point") {
    const result = await runRateAtPoint(args.slice(2));
    if ("error" in result) process.exitCode = 2;
    out(result);
  } else if (cmd === "geo" && args[1] === "ingest") {
    const result = await runGeoIngest(args.slice(2));
    if ("error" in result) process.exitCode = 2;
    out(result);
  } else if (cmd === "monitor" && args[1] === "refresh") {
    await monitorRefresh(args);
  } else if (cmd === "config" && args[1] === "show") {
    await configShow();
  } else if (cmd === "review" && args[1] === "list") {
    await reviewList();
  } else {
    out({
      error: "unknown command",
      usage: [
        "tax status",
        "tax analytics",
        "tax ledger check --jurisdiction <slug>",
        "tax context compile --profile contexts/<name>.json [--save]",
        "tax scope start --profile contexts/<name>.json [--goal-ref <ref>]",
        "tax scope status --id <uuid>",
        "tax work enqueue --scope <uuid> --role <role> --jurisdiction <slug> [--tax-type <slug>] [--unit <unit>]",
        "tax work next --role <role> [--scope <uuid>]",
        "tax work claim --id <uuid>",
        "tax work submit --id <uuid> --status completed|failed [--notes <text>] [--tokens-in N] [--tokens-out N] [--cost-usd X]",
        "tax work retry --id <uuid>",
        "tax review list",
        "tax geo ingest --jurisdiction <us-tx slug> | --level state|county|place",
        "tax geo resolve --lat <n> --lng <n> [--date <yyyy-mm-dd>]",
        "tax rate at-point --lat <n> --lng <n> --tax-type <slug> [--date <yyyy-mm-dd>]",
        "tax config show",
      ],
    });
    process.exitCode = 2;
  }
}

main()
  .then(async () => {
    await client.end();
  })
  .catch(async (err: unknown) => {
    console.error(err);
    await client.end().catch(() => undefined);
    process.exit(1);
  });
