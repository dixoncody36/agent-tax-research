import { client } from "@agent-tax-research/database";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One run's recorded analysis trail (C1): handoff notes, the proposal(s) it
// extracted or verified, the ledger determinations and coverage answers it
// touched, and the evidence sources those reference. Only what was recorded
// is returned — prompt hash/path (and small inline text) ride in
// datavalues when recorded at submit time (#58).
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!UUID.test(id)) return Response.json({ error: "id must be a uuid" }, { status: 400 });

  const [run] = await client`
    SELECT r.id, r.role::text AS role, r.model, r.unit, r.status, r.attempt, r.handoff_notes,
      r.tokens_in, r.tokens_out, r.cost_usd::text AS cost_usd, r.datavalues,
      r.started_at::text AS started_at, r.finished_at::text AS finished_at, r.created_at::text AS created_at,
      j.slug AS jurisdiction_slug, j.name AS jurisdiction_name, tt.slug AS tax_type, sr.profile_name AS scope_profile
    FROM agent_runs r
    LEFT JOIN jurisdictions j ON j.id = r.jurisdiction_id
    LEFT JOIN tax_types tt ON tt.id = r.tax_type_id
    LEFT JOIN scope_runs sr ON sr.id = r.scope_run_id
    WHERE r.id = ${id}`;
  if (!run) return Response.json({ error: "unknown run" }, { status: 404 });

  const [proposals, ledger, coverage, sources, events] = await Promise.all([
    client`
      SELECT p.id, p.status, CASE WHEN p.extractor_run_id = ${id} THEN 'extractor' ELSE 'verifier' END AS linked_as,
        j.slug AS jurisdiction_slug, tt.slug AS tax_type, p.approved_by, p.created_at::text AS created_at,
        (SELECT count(*)::int FROM proposal_items i WHERE i.proposal_id = p.id) AS item_count,
        (SELECT coalesce(json_object_agg(verdict, n), '{}'::json) FROM (SELECT verdict, count(*)::int AS n FROM proposal_items i WHERE i.proposal_id = p.id GROUP BY verdict) v) AS verdicts,
        (SELECT coalesce(json_agg(json_build_object('table', i.target_table, 'verdict', i.verdict, 'citation', i.citation, 'summary', left(i.payload::text, 240))), '[]'::json)
           FROM (SELECT * FROM proposal_items WHERE proposal_id = p.id ORDER BY created_at LIMIT 8) i) AS items
      FROM proposals p JOIN jurisdictions j ON j.id = p.jurisdiction_id LEFT JOIN tax_types tt ON tt.id = p.tax_type_id
      WHERE p.extractor_run_id = ${id} OR p.verifier_run_id = ${id} ORDER BY p.created_at DESC`,
    client`
      SELECT l.question_key, tt.slug AS tax_type, l.determination, l.status, l.snapshot_hash, l.invalidated_reason, l.validated_at::text AS validated_at
      FROM research_ledger l LEFT JOIN tax_types tt ON tt.id = l.tax_type_id
      WHERE l.validated_by_run_id = ${id} ORDER BY l.question_key LIMIT 200`,
    client`
      SELECT a.question_key, a.status, left(a.answer, 200) AS answer FROM coverage_answers a
      WHERE a.answered_by_run_id = ${id} ORDER BY a.question_key LIMIT 50`,
    client`
      SELECT DISTINCT ON (s.id) s.name, s.url, s.eligibility,
        (SELECT n.content_hash FROM source_snapshots n WHERE n.source_id = s.id ORDER BY n.created_at DESC LIMIT 1) AS snapshot_hash,
        (SELECT max(n.created_at)::text FROM source_snapshots n WHERE n.source_id = s.id) AS snapshot_at
      FROM sources s
      WHERE s.id IN (
        SELECT i.source_id FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id WHERE (p.extractor_run_id = ${id} OR p.verifier_run_id = ${id}) AND i.source_id IS NOT NULL
        UNION SELECT n.source_id FROM source_snapshots n WHERE n.fetched_by_run_id = ${id})
      ORDER BY s.id LIMIT 50`,
    client`
      SELECT event_type, detail, created_at::text AS created_at FROM run_events WHERE agent_run_id = ${id} ORDER BY created_at LIMIT 100`,
  ]);

  return Response.json({ run, proposals, ledger, coverage, sources, events });
}
