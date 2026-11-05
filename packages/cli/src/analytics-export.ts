import { writeFileSync } from "node:fs";
import { client } from "@agent-tax-research/database";

// Opt-in public analytics export (issue #26): aggregates ONLY — counts,
// durations, token/cost totals by role/model/harness. No jurisdiction
// research content, no operator identity, no prompts. Refuses to run
// unless ANALYTICS_PUBLIC_OPTIN=1 so private-by-default is structural,
// not a promise. Output is a single JSON an operator may choose to send
// to the public benchmark database.
// Usage: ANALYTICS_PUBLIC_OPTIN=1 pnpm --filter @agent-tax-research/cli exec tsx src/analytics-export.ts [outFile]
if (process.env.ANALYTICS_PUBLIC_OPTIN !== "1") {
  console.error(JSON.stringify({ error: "public analytics are opt-in: set ANALYTICS_PUBLIC_OPTIN=1 to export aggregates" }));
  process.exit(2);
}
const outFile = process.argv[2] ?? "analytics-public-export.json";
const byRoleModel = await client`
  SELECT role, model, count(*)::int AS runs,
    sum(tokens_in)::bigint AS tokens_in, sum(tokens_out)::bigint AS tokens_out,
    sum(cost_usd) AS cost_usd,
    avg(extract(epoch FROM (finished_at - started_at))) AS avg_seconds
  FROM agent_runs GROUP BY role, model ORDER BY role, model`;
const [totals] = await client`
  SELECT (SELECT count(*) FROM jurisdictions)::int AS jurisdictions,
    (SELECT count(*) FROM proposals WHERE status='published')::int AS published_proposals,
    (SELECT count(*) FROM proposals)::int AS proposals,
    (SELECT count(*) FROM source_snapshots)::int AS snapshots,
    (SELECT count(*) FROM agent_runs)::int AS agent_runs,
    (SELECT count(*) FROM agent_runs WHERE attempt >= 3)::int AS runs_at_attempt_cap`;
const payload = {
  schema: "atr-public-analytics-v1", exportedAt: new Date().toISOString(),
  note: "Aggregates only. No research content, prompts, or operator identity.",
  totals, byRoleModel,
};
writeFileSync(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ outFile, roles: byRoleModel.length, totals }));
await client.end();
