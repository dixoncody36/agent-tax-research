import { client } from "@agent-tax-research/database";

export const dynamic = "force-dynamic";

// Jurisdiction explorer detail (B1): one read-only payload per jurisdiction —
// every data-model table that hangs off it. Rows keep their verification
// status so the UI can label anything unpublished; dates are cast to ISO
// text in SQL (no timezone drift) and ordered on values, newest first.
export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug");
  if (!slug) return Response.json({ error: "slug is required" }, { status: 400 });

  const [j] = await client`
    SELECT id, slug, code, name, official_name, level::text AS level, country_code, currency_code, timezone
    FROM jurisdictions WHERE slug = ${slug}`;
  if (!j) return Response.json({ error: `unknown jurisdiction: ${slug}` }, { status: 404 });
  const jid = j.id as string;

  const [ancestors, children, taxTypes, rates, rules, licenses, compliance, geo, coverage, sources, ledger, runs] = await Promise.all([
    client`
      WITH RECURSIVE a AS (
        SELECT id, parent_id, slug, name, level::text AS level, 0 AS d FROM jurisdictions WHERE id = ${jid}
        UNION ALL
        SELECT p.id, p.parent_id, p.slug, p.name, p.level::text, a.d + 1 FROM jurisdictions p JOIN a ON a.parent_id = p.id
      ) SELECT slug, name, level FROM a WHERE d > 0 ORDER BY d DESC`,
    client`SELECT slug, name, level::text AS level FROM jurisdictions WHERE parent_id = ${jid} ORDER BY name`,
    client`SELECT slug, name, category, administering_agency, official_url FROM tax_types WHERE jurisdiction_id = ${jid} ORDER BY name`,
    client`
      SELECT tt.slug AS tax_type, tt.name AS tax_type_name, r.rate_value::text AS rate_value, r.rate_unit, r.applies_to, r.conditions,
        r.effective_from::text AS effective_from, r.effective_to::text AS effective_to,
        r.verification_status::text AS status, r.citation, s.name AS source_name, s.url AS source_url
      FROM tax_rates r JOIN tax_types tt ON tt.id = r.tax_type_id LEFT JOIN sources s ON s.id = r.source_id
      WHERE r.jurisdiction_id = ${jid} ORDER BY r.effective_from DESC, tt.name`,
    client`
      SELECT tt.slug AS tax_type, r.rule_type, r.authority_level, r.title, r.summary,
        r.effective_from::text AS effective_from, r.effective_to::text AS effective_to,
        r.verification_status::text AS status, r.citation, s.name AS source_name, s.url AS source_url
      FROM tax_rules r JOIN tax_types tt ON tt.id = r.tax_type_id LEFT JOIN sources s ON s.id = r.source_id
      WHERE COALESCE(r.jurisdiction_id, tt.jurisdiction_id) = ${jid} ORDER BY r.effective_from DESC, r.title`,
    client`
      SELECT tt.slug AS tax_type, l.name, l.license_type, l.required_for, l.issuing_agency, l.application_url, l.form_number,
        l.fee_amount::text AS fee_amount, l.fee_currency, l.renewal_period,
        l.effective_from::text AS effective_from, l.effective_to::text AS effective_to,
        l.verification_status::text AS status, l.citation
      FROM tax_licenses l JOIN tax_types tt ON tt.id = l.tax_type_id
      WHERE COALESCE(l.jurisdiction_id, tt.jurisdiction_id) = ${jid} ORDER BY l.effective_from DESC, l.name`,
    client`
      SELECT tt.slug AS tax_type, c.obligation_type, c.form_number, c.form_name, c.form_url, c.filing_frequency, c.due_date_rule,
        c.filing_methods, c.payment_methods, c.collect_remit_summary,
        c.effective_from::text AS effective_from, c.effective_to::text AS effective_to,
        c.verification_status::text AS status, c.citation
      FROM tax_compliance c JOIN tax_types tt ON tt.id = c.tax_type_id
      WHERE COALESCE(c.jurisdiction_id, tt.jurisdiction_id) = ${jid} ORDER BY c.effective_from DESC, c.form_name`,
    client`
      SELECT g.geo_kind, g.boundary_geojson IS NOT NULL AS has_boundary, g.geometry_hash, g.simplification, g.precision,
        g.centroid_lat::text AS centroid_lat, g.centroid_lng::text AS centroid_lng,
        g.effective_from::text AS effective_from, g.effective_to::text AS effective_to,
        g.verification_status::text AS status, g.citation, s.name AS source_name, s.url AS source_url
      FROM jurisdiction_geo g LEFT JOIN sources s ON s.id = g.source_id
      WHERE g.jurisdiction_id = ${jid} ORDER BY g.effective_from DESC`,
    client`
      SELECT a.question_key, a.status, a.answer, t.name AS tax_type,
        a.evidence->>'excerpt' AS excerpt, a.evidence->>'snapshotHash' AS snapshot_hash
      FROM coverage_answers a LEFT JOIN tax_types t ON t.id = a.tax_type_id
      WHERE a.jurisdiction_id = ${jid}
      ORDER BY t.name NULLS FIRST,
        (SELECT min(q.sort_order) FROM coverage_questions q WHERE q.question_key = a.question_key) NULLS LAST,
        a.question_key`,
    client`
      SELECT s.name, s.url, s.source_type, s.publisher, s.is_authoritative, s.eligibility, s.status,
        (SELECT max(created_at)::text FROM source_snapshots n WHERE n.source_id = s.id) AS snapshot_at,
        (SELECT content_hash FROM source_snapshots n WHERE n.source_id = s.id ORDER BY created_at DESC LIMIT 1) AS snapshot_hash,
        s.last_checked_at::text AS last_checked_at
      FROM sources s WHERE s.jurisdiction_id = ${jid} ORDER BY s.name`,
    client`
      SELECT l.question_key, tt.slug AS tax_type, l.determination, l.status, l.snapshot_hash, l.invalidated_reason, l.validated_at::text AS validated_at
      FROM research_ledger l LEFT JOIN tax_types tt ON tt.id = l.tax_type_id
      WHERE l.jurisdiction_id = ${jid} ORDER BY l.question_key`,
    client`
      SELECT r.id, r.role::text AS role, r.model, r.unit, r.status, r.attempt, r.started_at::text AS started_at,
        r.finished_at::text AS finished_at, r.created_at::text AS created_at
      FROM agent_runs r WHERE r.jurisdiction_id = ${jid} ORDER BY COALESCE(r.started_at, r.created_at) ASC`,
  ]);

  return Response.json({
    jurisdiction: {
      slug: j.slug, code: j.code, name: j.name, officialName: j.official_name, level: j.level,
      countryCode: j.country_code, currencyCode: j.currency_code, timezone: j.timezone,
    },
    ancestors, children, taxTypes, rates, rules, licenses, compliance, geo, coverage, sources, ledger, agentRuns: runs,
  });
}
