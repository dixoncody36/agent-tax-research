import { client } from "@agent-tax-research/database";
import { attachment, jsonExport, safeSlug, toCsv, today } from "../../../../lib/exportUtil";

export const dynamic = "force-dynamic";

// Published rules (B2): verified only. A rule with no jurisdiction belongs
// to its tax type's administering jurisdiction (data-model convention).
const COLUMNS = [
  "jurisdiction_slug", "jurisdiction_name", "tax_type_slug", "rule_type", "authority_level", "title", "summary",
  "effective_from", "effective_to", "citation", "source_title", "source_url",
];

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const jur = q.get("jurisdiction") ? safeSlug(q.get("jurisdiction")) : null;
  if (q.get("jurisdiction") && !jur) return Response.json({ error: "invalid jurisdiction slug" }, { status: 400 });
  const format = q.get("format") ?? "csv";
  if (format !== "csv" && format !== "json") return Response.json({ error: "format must be csv or json" }, { status: 400 });

  const rows = await client`
    SELECT j.slug AS jurisdiction_slug, j.name AS jurisdiction_name, tt.slug AS tax_type_slug, r.rule_type, r.authority_level,
      r.title, r.summary, r.effective_from::text AS effective_from, r.effective_to::text AS effective_to,
      r.citation, s.name AS source_title, s.url AS source_url
    FROM tax_rules r
    JOIN tax_types tt ON tt.id = r.tax_type_id
    JOIN jurisdictions j ON j.id = COALESCE(r.jurisdiction_id, tt.jurisdiction_id)
    LEFT JOIN sources s ON s.id = r.source_id
    WHERE r.verification_status = 'verified' AND (${jur}::text IS NULL OR j.slug = ${jur})
    ORDER BY j.slug, tt.slug, r.effective_from DESC, r.title`;

  const name = `${jur ?? "all"}-rules-${today()}.${format}`;
  return format === "json"
    ? jsonExport("rules", { jurisdiction: jur }, rows, name)
    : attachment(toCsv(COLUMNS, rows), "text/csv", name);
}
