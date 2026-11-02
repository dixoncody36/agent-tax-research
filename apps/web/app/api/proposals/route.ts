import { client } from "@agent-tax-research/database";

export const dynamic = "force-dynamic";

// Human review queue data: proposals with items + citations, only ones a
// human can act on (verified -> approve, approved -> publish).
export async function GET() {
  const proposals = await client`
    SELECT p.id, p.status, p.created_at, p.extractor_run_id, p.verifier_run_id,
      p.approved_by, j.name AS jurisdiction, t.name AS tax_type,
      (SELECT count(*) FROM proposal_items i WHERE i.proposal_id = p.id) AS item_count
    FROM proposals p
    LEFT JOIN jurisdictions j ON j.id = p.jurisdiction_id
    LEFT JOIN tax_types t ON t.id = p.tax_type_id
    WHERE p.status IN ('verified', 'approved')
    ORDER BY p.created_at ASC`;
  const out = [] as unknown[];
  for (const p of proposals) {
    const items = await client`
      SELECT target_table, payload, citation, verdict, s.url AS source_url
      FROM proposal_items i LEFT JOIN sources s ON s.id = i.source_id
      WHERE i.proposal_id = ${p.id} LIMIT 50`;
    out.push({ ...p, items });
  }
  return Response.json({ proposals: out });
}
