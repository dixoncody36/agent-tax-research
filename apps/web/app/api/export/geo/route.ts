import { client } from "@agent-tax-research/database";
import { attachment, safeSlug, today } from "../../../../lib/exportUtil";

export const dynamic = "force-dynamic";

// Published boundary as GeoJSON (B2): verified, currently-effective rows
// that carry a boundary. jurisdiction omitted = every published boundary
// (large). Feature properties carry the re-performance identity (hash) and
// source citation; the collection-level meta carries draft / publishedOnly.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const jur = q.get("jurisdiction") ? safeSlug(q.get("jurisdiction")) : null;
  if (q.get("jurisdiction") && !jur) return Response.json({ error: "invalid jurisdiction slug" }, { status: 400 });

  const rows = await client`
    SELECT j.slug, j.name, j.level::text AS level, g.boundary_geojson AS geometry, g.geometry_hash, g.simplification, g.precision,
      g.effective_from::text AS effective_from, g.citation, s.name AS source_title, s.url AS source_url
    FROM jurisdiction_geo g
    JOIN jurisdictions j ON j.id = g.jurisdiction_id
    LEFT JOIN sources s ON s.id = g.source_id
    WHERE g.boundary_geojson IS NOT NULL AND g.verification_status = 'verified'
      AND g.effective_from <= CURRENT_DATE AND (g.effective_to IS NULL OR g.effective_to >= CURRENT_DATE)
      AND (${jur}::text IS NULL OR j.slug = ${jur})
    ORDER BY j.slug`;
  if (jur && rows.length === 0) {
    return Response.json({ error: `no published boundary for ${jur}` }, { status: 404 });
  }

  const fc = {
    type: "FeatureCollection",
    meta: { kind: "geo", generatedAt: new Date().toISOString(), publishedOnly: true, draft: true, jurisdiction: jur, count: rows.length },
    features: rows.map((r) => ({
      type: "Feature",
      geometry: r.geometry,
      properties: {
        slug: r.slug, name: r.name, level: r.level, geometryHash: r.geometry_hash, simplification: r.simplification,
        precision: r.precision, effectiveFrom: r.effective_from, citation: r.citation, sourceTitle: r.source_title, sourceUrl: r.source_url,
      },
    })),
  };
  return attachment(JSON.stringify(fc), "application/geo+json", `${jur ?? "all"}-geo-${today()}.geojson`);
}
