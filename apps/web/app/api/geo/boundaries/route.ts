import { client } from "@agent-tax-research/database";

export const dynamic = "force-dynamic";

// Published boundary polygons for the globe overlay (#40). Published
// rows only — no structure/datavalues fallback; an empty collection
// before the human publish gate is the honest answer. Default: Texas
// state + county boundaries (city polygons on request via ?level=city).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const level = url.searchParams.get("level") ?? "county";
  if (!["state", "county", "city"].includes(level)) {
    return Response.json({ error: "level must be state|county|city" }, { status: 400 });
  }
  const rows = await client`
    SELECT j.slug, j.name, g.boundary_geojson AS geometry, g.geometry_hash
    FROM jurisdiction_geo g
    JOIN jurisdictions j ON j.id = g.jurisdiction_id
    WHERE j.level = ${level}
      AND g.boundary_geojson IS NOT NULL
      AND g.verification_status = 'verified'
      AND g.effective_from <= CURRENT_DATE
      AND (g.effective_to IS NULL OR g.effective_to >= CURRENT_DATE)`;
  return Response.json({
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      properties: { slug: r.slug, name: r.name, geometryHash: r.geometry_hash },
      geometry: r.geometry,
    })),
  });
}
