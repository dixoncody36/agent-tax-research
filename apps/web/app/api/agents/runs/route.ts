import { client } from "@agent-tax-research/database";

export const dynamic = "force-dynamic";

// Agent run list (C1). Read-only. Filters: role, jurisdiction (slug),
// status. Newest first, ordered on timestamp values in SQL. Fields that
// were never recorded stay null — the UI renders them as "not recorded".
// Prompts are not persisted anywhere today and are deliberately absent.
const ROLES = ["orchestrator", "fetch", "decision", "reviewer"];

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const role = q.get("role") || null;
  const jur = q.get("jurisdiction") || null;
  const status = q.get("status") || null;
  if (role && !ROLES.includes(role)) return Response.json({ error: `role must be one of ${ROLES.join(", ")}` }, { status: 400 });

  const runs = await client`
    SELECT r.id, r.role::text AS role, r.model, r.unit, r.status, r.attempt,
      r.tokens_in, r.tokens_out, r.cost_usd::text AS cost_usd,
      r.started_at::text AS started_at, r.finished_at::text AS finished_at, r.created_at::text AS created_at,
      j.slug AS jurisdiction_slug, j.name AS jurisdiction_name, tt.slug AS tax_type
    FROM agent_runs r
    LEFT JOIN jurisdictions j ON j.id = r.jurisdiction_id
    LEFT JOIN tax_types tt ON tt.id = r.tax_type_id
    WHERE (${role}::text IS NULL OR r.role::text = ${role})
      AND (${jur}::text IS NULL OR j.slug = ${jur})
      AND (${status}::text IS NULL OR r.status = ${status})
    ORDER BY COALESCE(r.started_at, r.created_at) DESC
    LIMIT 1000`;
  const [facets] = await client`
    SELECT
      (SELECT coalesce(json_agg(DISTINCT role::text), '[]'::json) FROM agent_runs) AS roles,
      (SELECT coalesce(json_agg(DISTINCT status), '[]'::json) FROM agent_runs) AS statuses,
      (SELECT coalesce(json_agg(json_build_object('slug', slug, 'name', name) ORDER BY name), '[]'::json)
         FROM jurisdictions WHERE id IN (SELECT jurisdiction_id FROM agent_runs WHERE jurisdiction_id IS NOT NULL)) AS jurisdictions,
      (SELECT count(*)::int FROM agent_runs) AS total`;
  return Response.json({ runs, facets });
}
