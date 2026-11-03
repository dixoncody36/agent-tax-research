import { client } from "@agent-tax-research/database";

export const dynamic = "force-dynamic";

// Globe points (#40): published geo wins. Coordinates come from
// reporting.current_geo when a boundary/centroid is published
// (geoStatus published_boundary | published_centroid); world structure
// pins keep their capital coordinates labeled structure_only so the
// globe never silently drops a jurisdiction; anything else is `none`
// with null coords. Boundary overlay reads /api/geo/boundaries —
// published rows only, no fallback.
export async function GET() {
  const rows = await client`
    SELECT j.slug, j.level, j.name,
      cg.centroid_lat AS geo_lat, cg.centroid_lng AS geo_lng, cg.geo_kind,
      j.datavalues->>'lat' AS cap_lat, j.datavalues->>'lng' AS cap_lng,
      (j.datavalues->>'demoHeld') = 'true' AS held,
      (SELECT count(*) FROM tax_types t WHERE t.jurisdiction_id = j.id) AS type_count,
      (SELECT count(*) FROM proposals p WHERE p.jurisdiction_id = j.id AND p.status = 'verified') AS verified_queue,
      (SELECT count(*) FROM proposals p WHERE p.jurisdiction_id = j.id AND p.status = 'published') AS published_count,
      (SELECT count(*) FROM exceptions e WHERE e.jurisdiction_id = j.id) AS exception_count
    FROM jurisdictions j
    LEFT JOIN reporting.current_geo cg ON cg.jurisdiction_id = j.id
    WHERE j.level IN ('country', 'state', 'region', 'county', 'city')`;
  const points = rows
    .filter((r) => r.level !== "country" || r.geo_lat || r.cap_lat)
    .map((r) => {
      const geoStatus = r.geo_lat
        ? (r.geo_kind === "boundary" ? "published_boundary" : "published_centroid")
        : (r.cap_lat ? "structure_only" : "none");
      return {
        slug: r.slug, level: r.level, name: r.name,
        lat: r.geo_lat ? Number(r.geo_lat) : (r.cap_lat ? Number(r.cap_lat) : null),
        lng: r.geo_lng ? Number(r.geo_lng) : (r.cap_lng ? Number(r.cap_lng) : null),
        geoStatus,
        status: r.held ? "held" : Number(r.published_count) > 0 ? "verified" : Number(r.type_count) > 0 ? "populated" : Number(r.exception_count) > 0 ? "blocked" : "skeleton",
        typeCount: Number(r.type_count), verifiedQueue: Number(r.verified_queue),
        publishedCount: Number(r.published_count), exceptionCount: Number(r.exception_count),
      };
    });
  const [totals] = await client`
    SELECT (SELECT count(*) FROM jurisdictions) AS jurisdictions,
      (SELECT count(*) FROM tax_types) AS tax_types,
      (SELECT count(*) FROM tax_rates WHERE verification_status='verified') AS verified_rates,
      (SELECT count(*) FROM proposals WHERE status='verified') AS awaiting_human,
      (SELECT count(*) FROM source_snapshots) AS snapshots,
      (SELECT count(*) FROM exceptions WHERE status='open') AS exceptions,
      (SELECT count(*) FROM reporting.current_geo) AS published_geo`;
  return Response.json({ points, totals });
}
