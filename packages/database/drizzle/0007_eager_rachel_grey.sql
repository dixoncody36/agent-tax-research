CREATE VIEW "reporting"."geo_tie_out" AS (
  WITH reg AS (
    SELECT level::text AS level, count(*)::int AS n FROM jurisdictions
    WHERE (slug = 'us-tx' OR slug LIKE 'us-tx-%') AND level IN ('state','county','city','special_district')
    GROUP BY level
  ),
  geo AS (
    SELECT j.level::text AS level,
      count(DISTINCT j.id) FILTER (WHERE g.boundary_geojson IS NOT NULL)::int AS with_boundary,
      count(DISTINCT j.id) FILTER (WHERE g.boundary_geojson IS NULL AND g.geo_kind = 'centroid')::int AS centroid_only
    FROM jurisdiction_geo g JOIN jurisdictions j ON j.id = g.jurisdiction_id
    WHERE g.effective_from <= current_date AND (g.effective_to IS NULL OR g.effective_to >= current_date)
    GROUP BY j.level
  ),
  absent AS (
    SELECT j.level::text AS level, count(DISTINCT j.id)::int AS n
    FROM coverage_answers a JOIN jurisdictions j ON j.id = a.jurisdiction_id
    WHERE a.question_key = 'has_published_boundary' AND a.status = 'confirmed_absent'
    GROUP BY j.level
  )
  SELECT r.level, r.n AS registered,
    coalesce(g.with_boundary, 0) AS with_boundary,
    coalesce(g.centroid_only, 0) AS centroid_only,
    coalesce(a.n, 0) AS confirmed_absent,
    (r.n - coalesce(g.with_boundary, 0) - coalesce(g.centroid_only, 0) - coalesce(a.n, 0))::int AS unaccounted
  FROM reg r LEFT JOIN geo g ON g.level = r.level LEFT JOIN absent a ON a.level = r.level
);