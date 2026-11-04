import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { client } from "@agent-tax-research/database";

export const dynamic = "force-dynamic";

// Competition view (C2). Block 1: live leaderboard computed from agent_runs,
// grouped by role + model (+ datavalues provider/harness when present);
// unknown model groups under "not recorded". Block 2: benchmark suite
// description (benchmarks/v1/tasks.json) and any REAL result files
// (benchmarks/results*.json, excluding the zeroed template). Read-only.
//
// "Verified-proposal rate" = of proposals whose extractor was a run in the
// group, the share that reached verified, approved or published.

type Json = Record<string, unknown>;

function benchmarksDir(): string {
  // next runs with cwd = apps/web; repo root is two levels up.
  return path.resolve(process.cwd(), "..", "..", "benchmarks");
}

function readJson(file: string): Json | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as Json; } catch { return null; }
}

function benchmarkSuite() {
  const dir = benchmarksDir();
  const suite = readJson(path.join(dir, "v1", "tasks.json"));
  const tasks = ((suite?.tasks ?? []) as Json[]).map((t) => ({ id: t.id, jurisdiction: t.jurisdiction, category: t.category, prompt: t.prompt }));
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^results.*\.json$/.test(f) && !/example/.test(f));
  } catch { /* directory missing: treated as no results */ }
  const results = files
    .map((f) => ({ file: f, mtime: statSync(path.join(dir, f)).mtimeMs, body: readJson(path.join(dir, f)) }))
    .filter((r) => r.body && Array.isArray(r.body.results))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 6)
    .map((r) => {
      const body = r.body as Json;
      const rows = (body.results as Json[]).map((x) => {
        const d = (x.details ?? {}) as Json;
        const scores = (x.scores ?? {}) as Json;
        const pass = !x.reason && d.goldFields !== undefined && d.correctFields === d.goldFields && d.citationValid === true;
        return { taskId: x.taskId, pass, total: scores.total ?? null, attempts: x.attempts ?? null, reason: x.reason ?? null };
      });
      return {
        file: r.file, generatedAt: new Date(r.mtime).toISOString(), harness: body.harness ?? null,
        roleModels: body.roleModels ?? {}, suiteAverage: body.suiteAverage ?? null, results: rows,
      };
    });
  return {
    suite: suite ? { name: suite.suite, version: suite.version, maxAttempts: suite.maxAttempts, taskCount: tasks.length, tasks } : null,
    results,
  };
}

export async function GET() {
  const rows = await client`
    WITH g AS (
      SELECT r.id, r.role::text AS role, COALESCE(NULLIF(r.model, ''), 'not recorded') AS model,
        NULLIF(COALESCE(r.datavalues->>'harness', r.datavalues->>'provider'), '') AS harness,
        r.status, r.attempt, r.tokens_in, r.tokens_out, r.cost_usd,
        CASE WHEN r.started_at IS NOT NULL AND r.finished_at IS NOT NULL THEN extract(epoch FROM r.finished_at - r.started_at) END AS wall_s
      FROM agent_runs r
    )
    SELECT g.role, g.model, g.harness,
      count(*)::int AS runs,
      count(*) FILTER (WHERE g.status = 'completed')::int AS completed,
      round(avg(g.attempt)::numeric, 2)::text AS avg_attempts,
      count(g.tokens_in)::int AS runs_with_tokens,
      coalesce(sum(g.tokens_in), 0)::bigint::text AS tokens_in,
      coalesce(sum(g.tokens_out), 0)::bigint::text AS tokens_out,
      count(g.cost_usd)::int AS runs_with_cost,
      sum(g.cost_usd)::text AS cost_usd,
      count(g.wall_s)::int AS runs_with_wall,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY g.wall_s) AS median_wall_s,
      (SELECT count(*)::int FROM proposals p WHERE p.extractor_run_id IN (SELECT g2.id FROM g g2 WHERE g2.role = g.role AND g2.model = g.model AND g2.harness IS NOT DISTINCT FROM g.harness)) AS proposals_extracted,
      (SELECT count(*)::int FROM proposals p WHERE p.status IN ('verified', 'approved', 'published')
         AND p.extractor_run_id IN (SELECT g2.id FROM g g2 WHERE g2.role = g.role AND g2.model = g.model AND g2.harness IS NOT DISTINCT FROM g.harness)) AS proposals_verified
    FROM g
    GROUP BY g.role, g.model, g.harness
    ORDER BY CASE g.role WHEN 'orchestrator' THEN 0 WHEN 'fetch' THEN 1 WHEN 'decision' THEN 2 ELSE 3 END, runs DESC, g.model`;
  return Response.json({ leaderboard: rows, benchmarks: benchmarkSuite() });
}
