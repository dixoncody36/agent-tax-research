import { client } from "@agent-tax-research/database";

export const dynamic = "force-dynamic";

// Country points for the globe: coordinates live in datavalues (capital
// lat/lng from the structure registration). Status derives from real
// data: verified published facts > registered tax types > held > skeleton.
export async function GET() {
  const rows = await client`
    SELECT j.slug, j.level, j.name,
      j.datavalues->>'lat' AS lat, j.datavalues->>'lng' AS lng,
      (j.datavalues->>'demoHeld') = 'true' AS held,
      (SELECT count(*) FROM tax_types t WHERE t.jurisdiction_id = j.id) AS type_count,
      (SELECT count(*) FROM proposals p WHERE p.jurisdiction_id = j.id AND p.status = 'verified') AS verified_queue,
      (SELECT count(*) FROM proposals p WHERE p.jurisdiction_id = j.id AND p.status = 'published') AS published_count,
      (SELECT count(*) FROM exceptions e WHERE e.jurisdiction_id = j.id) AS exception_count
    FROM jurisdictions j
    WHERE j.level IN ('country', 'state', 'region')`;
  const points = rows
    .filter((r) => r.level !== "country" || (r.lat && r.lng))
    .map((r) => ({
      slug: r.slug, level: r.level, name: r.name,
      lat: r.lat ? Number(r.lat) : null, lng: r.lng ? Number(r.lng) : null,
      status: r.held ? "held" : Number(r.published_count) > 0 ? "verified" : Number(r.type_count) > 0 ? "populated" : Number(r.exception_count) > 0 ? "blocked" : "skeleton",
      typeCount: Number(r.type_count), verifiedQueue: Number(r.verified_queue),
      publishedCount: Number(r.published_count), exceptionCount: Number(r.exception_count),
    }));
  // Texas/US rollup for the stats strip
  const [totals] = await client`
    SELECT (SELECT count(*) FROM jurisdictions) AS jurisdictions,
      (SELECT count(*) FROM tax_types) AS tax_types,
      (SELECT count(*) FROM tax_rates WHERE verification_status='verified') AS verified_rates,
      (SELECT count(*) FROM proposals WHERE status='verified') AS awaiting_human,
      (SELECT count(*) FROM source_snapshots) AS snapshots,
      (SELECT count(*) FROM exceptions) AS exceptions`;
  return Response.json({ points, totals });
}
