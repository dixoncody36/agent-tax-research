import { client } from "@agent-tax-research/database";

export const dynamic = "force-dynamic";

// Point lookup for the demo panel (#40): bbox prefilter in SQL, then
// point-in-polygon + RATE-STACK here. ponytail: minimal PIP duplicated
// from packages/cli/src/geo-math.ts (canonical, fixture-tested there) —
// promote to a shared package when a third consumer appears. Partial
// sums are named partial; a boundary point counts as inside (flagged).

type Pos = [number, number];
type Geom = { type: "Polygon" | "MultiPolygon"; coordinates: Pos[][] | Pos[][][] };

function ringContains(ring: Pos[], lat: number, lng: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function contains(g: Geom, lat: number, lng: number): boolean {
  const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as Pos[][][];
  return polys.some((poly) =>
    ringContains(poly[0]!, lat, lng) && !poly.slice(1).some((hole) => ringContains(hole, lat, lng)));
}

const RANK: Record<string, number> = {
  country: 0, region: 1, state: 2, province: 2, county: 3, city: 4, special_district: 5, other: 6,
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const taxType = url.searchParams.get("taxType") ?? "us-tx-sales-use";
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return Response.json({ error: "lat must be in [-90, 90]" }, { status: 400 });
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return Response.json({ error: "lng must be in [-180, 180]" }, { status: 400 });
  }

  const candidates = await client`
    SELECT j.slug, j.name, j.level, g.boundary_geojson AS geometry, g.geometry_hash
    FROM jurisdiction_geo g
    JOIN jurisdictions j ON j.id = g.jurisdiction_id
    WHERE g.boundary_geojson IS NOT NULL
      AND g.verification_status = 'verified'
      AND g.effective_from <= CURRENT_DATE
      AND (g.effective_to IS NULL OR g.effective_to >= CURRENT_DATE)
      AND ${lat} BETWEEN g.min_lat AND g.max_lat
      AND ${lng} BETWEEN g.min_lng AND g.max_lng`;
  const applicable = candidates
    .filter((c) => contains(c.geometry as Geom, lat, lng))
    .map((c) => ({ slug: c.slug as string, name: c.name as string, level: c.level as string, geometryHash: c.geometry_hash as string }))
    .sort((a, b) => ((RANK[a.level] ?? 9) - (RANK[b.level] ?? 9)) || a.name.localeCompare(b.name));

  const slugs = applicable.map((a) => a.slug);
  const rates = slugs.length
    ? await client`
        SELECT j.slug, j.name, r.rate_value, r.rate_unit, r.applies_to
        FROM tax_rates r
        JOIN jurisdictions j ON j.id = r.jurisdiction_id
        JOIN tax_types t ON t.id = r.tax_type_id
        WHERE t.slug = ${taxType} AND j.slug = ANY(${slugs})
          AND r.effective_from <= CURRENT_DATE
          AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE)`
    : [];
  const components = rates.map((r) => ({
    slug: r.slug as string, name: r.name as string,
    rateValue: Number(r.rate_value), rateUnit: r.rate_unit as string, appliesTo: r.applies_to as string | null,
  }));
  const combinedPercent = Number(
    components.filter((c) => c.rateUnit === "percent").reduce((s, c) => s + c.rateValue, 0).toFixed(6),
  );

  // Imposing jurisdictions with no published boundary stay undecided.
  const imposing = await client`
    SELECT DISTINCT j.slug FROM tax_rates r
    JOIN jurisdictions j ON j.id = r.jurisdiction_id
    JOIN tax_types t ON t.id = r.tax_type_id
    WHERE t.slug = ${taxType}
      AND r.effective_from <= CURRENT_DATE
      AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE)
      AND NOT EXISTS (
        SELECT 1 FROM jurisdiction_geo g WHERE g.jurisdiction_id = j.id
          AND g.boundary_geojson IS NOT NULL AND g.verification_status = 'verified')`;
  const stateTested = applicable.some((a) => a.level === "state");
  const unresolved = stateTested ? imposing.map((r) => r.slug as string).filter((s) => !slugs.includes(s)) : [];

  return Response.json({
    point: { lat, lng }, taxType,
    applicable, components, combinedPercent,
    complete: applicable.length > 0 && unresolved.length === 0,
    unresolvedCount: unresolved.length,
    reason: applicable.length ? null : (candidates.length ? "outside_coverage" : "no_published_geo"),
  });
}
