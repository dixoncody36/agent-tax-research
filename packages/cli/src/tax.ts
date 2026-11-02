import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { count, desc, eq, sql } from "drizzle-orm";
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
  } else {
    out({
      error: "unknown command",
      usage: [
        "tax status",
        "tax analytics",
        "tax ledger check --jurisdiction <slug>",
        "tax context compile --profile contexts/<name>.json [--save]",
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
