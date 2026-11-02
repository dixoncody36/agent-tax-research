import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  agentRuns,
  client,
  db,
  jurisdictions,
  researchLedger,
  scopeRuns,
  sources,
  taxRates,
  taxRules,
  taxTypes,
} from "@agent-tax-research/database";

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
    taxTypeId = tt.id;
  }
  const [row] = await db.insert(agentRuns).values({ scopeRunId: scopeId, role, model: model ?? null, jurisdictionId: jur.id, taxTypeId, unit, status: "queued", attempt: 1 }).returning({ id: agentRuns.id });
  out({ assignmentId: row?.id ?? null, scopeRunId: scopeId, role, unit, jurisdiction: jurSlug, taxType: taxTypeSlug ?? null, status: "queued", attempt: 1 });
}

async function envelopeFor(run: typeof agentRuns.$inferSelect) {
  const jur = run.jurisdictionId ? (await db.select().from(jurisdictions).where(eq(jurisdictions.id, run.jurisdictionId)).limit(1))[0] : undefined;
  const tt = run.taxTypeId ? (await db.select().from(taxTypes).where(eq(taxTypes.id, run.taxTypeId)).limit(1))[0] : undefined;
  return {
    assignment: {
      v: 1, assignmentId: run.id, scopeRunId: run.scopeRunId, role: run.role, unit: run.unit,
      jurisdiction: jur?.slug ?? null, taxType: tt?.slug ?? null, attempt: run.attempt, maxAttempts: MAX_ATTEMPTS,
      model: run.model ?? loadRoleModels()[run.role]?.model ?? loadRoleModels()[run.role]?.deployment ?? null,
      contextPacks: [] as unknown[], // populated by jurisdiction context hooks (issue #6)
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
