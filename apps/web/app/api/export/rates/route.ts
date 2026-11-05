import { client } from "@agent-tax-research/database";
import { attachment, jsonExport, safeSlug, toCsv, today } from "../../../../lib/exportUtil";

export const dynamic = "force-dynamic";

// Published, effective-dated rates (B2): verification_status = 'verified'
// only, full history (not just today), newest effective_from first, with
// citation + source columns. jurisdiction omitted = every published rate.
const COLUMNS = [
  "jurisdiction_slug", "jurisdiction_name", "tax_type_slug", "tax_type_name", "rate_value", "rate_unit", "applies_to",
  "conditions", "effective_from", "effective_to", "citation", "source_title", "source_url",
];

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const jur = q.get("jurisdiction") ? safeSlug(q.get("jurisdiction")) : null;
  const tax = q.get("taxType") ? safeSlug(q.get("taxType")) : null;
  if (q.get("jurisdiction") && !jur) return Response.json({ error: "invalid jurisdiction slug" }, { status: 400 });
  if (q.get("taxType") && !tax) return Response.json({ error: "invalid taxType slug" }, { status: 400 });
  const format = q.get("format") ?? "csv";
  if (format !== "csv" && format !== "json") return Response.json({ error: "format must be csv or json" }, { status: 400 });

  const rows = await client`
    SELECT j.slug AS jurisdiction_slug, j.name AS jurisdiction_name, tt.slug AS tax_type_slug, tt.name AS tax_type_name,
      r.rate_value::text AS rate_value, r.rate_unit, r.applies_to, r.conditions,
      r.effective_from::text AS effective_from, r.effective_to::text AS effective_to,
      r.citation, s.name AS source_title, s.url AS source_url
    FROM tax_rates r
    JOIN jurisdictions j ON j.id = r.jurisdiction_id
    JOIN tax_types tt ON tt.id = r.tax_type_id
    LEFT JOIN sources s ON s.id = r.source_id
    WHERE r.verification_status = 'verified'
      AND (${jur}::text IS NULL OR j.slug = ${jur})
      AND (${tax}::text IS NULL OR tt.slug = ${tax})
    ORDER BY j.slug, tt.slug, r.effective_from DESC`;

  const name = `${jur ?? "all"}${tax ? `-${tax}` : ""}-rates-${today()}.${format}`;
  return format === "json"
    ? jsonExport("rates", { jurisdiction: jur, taxType: tax }, rows, name)
    : attachment(toCsv(COLUMNS, rows), "text/csv", name);
}
