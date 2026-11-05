import { client } from "@agent-tax-research/database";

export const dynamic = "force-dynamic";

// Live-ish activity feed: latest run events + exceptions (poll from client).
export async function GET() {
  const rows = await client`
    SELECT e.created_at, e.event_type, e.detail, r.role, r.model, j.name AS jurisdiction
    FROM run_events e
    LEFT JOIN agent_runs r ON r.id = e.agent_run_id
    LEFT JOIN jurisdictions j ON j.id = r.jurisdiction_id
    ORDER BY e.created_at DESC LIMIT 40`;
  const events = rows.map((r) => {
    const detail = (r.detail ?? {}) as Record<string, unknown>;
    return {
      created_at: r.created_at,
      level: typeof detail.level === "string" ? detail.level : "info",
      message: typeof detail.message === "string" ? detail.message : `${r.event_type}${detail.url ? ` ${String(detail.url)}` : ""}`,
      role: r.role, jurisdiction: r.jurisdiction,
    };
  });
  const exceptions = await client`
    SELECT created_at, exception_type AS type, detail AS title FROM exceptions ORDER BY created_at DESC LIMIT 10`;
  return Response.json({ events, exceptions });
}
