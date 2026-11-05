import { and, eq, isNotNull, lte, or, gte, isNull } from "drizzle-orm";
import {
  db, jurisdictionGeo, jurisdictions, taxRates, taxTypes,
} from "@agent-tax-research/database";
import { inBBox, isGeometry, pointInGeometry, type BBox } from "./geo-math.js";

// Point resolution + rate-at-point (#38, M8 unit 7). Pure core
// (resolveFromCandidates/stackComponents) is fixture-tested; the DB
// wrappers only load published rows. GEO-PIP register: boundary points
// count as inside (flagged), test point never rounded, every envelope
// stamps calc versions + deciding geometry hashes. RATE-STACK: a sum
// with undecided potential components is reported partial, never complete.

export const GEO_PIP_VERSION = "GEO-PIP@1.0.0";
export const RATE_STACK_VERSION = "RATE-STACK@1.1.0"; // 1.1: by-descent ancestors (#60)

export const LEVEL_RANK: Record<string, number> = {
  country: 0, region: 1, state: 2, province: 2, county: 3, city: 4, special_district: 5, other: 6,
};

export type GeoCandidate = {
  slug: string;
  name: string;
  level: string;
  geoKind: string;
  bbox: BBox | null;
  boundary: unknown;
  geometryHash: string | null;
};

export type Resolved = {
  slug: string; name: string; level: string;
  onBoundary: boolean; geometryHash: string | null;
  // #60: present when this jurisdiction has no boundary of its own and is
  // applicable only because the point resolved inside a descendant.
  viaDescent?: { fromSlug: string; geometryHash: string | null };
};

export type ParentInfo = { slug: string; name: string; level: string; parentSlug: string | null };

// By-descent ancestors (#60): ancestors of boundary-tested jurisdictions
// that impose the tax (wantedSlugs) but have no boundary to test. Being
// inside a descendant proves being inside the ancestor, so their
// components stack (citing the deciding descendant's geometry) instead of
// staying unresolved. Ancestors WITH a boundary are never added here —
// they were tested on their own geometry and the point was outside.
export function applicableByDescent(
  applicable: Resolved[],
  parents: Map<string, ParentInfo>,
  wantedSlugs: Set<string>,
  boundarySlugs: Set<string>,
): Resolved[] {
  const have = new Set(applicable.map((a) => a.slug));
  const out: Resolved[] = [];
  for (const desc of applicable) {
    let cur = parents.get(desc.slug);
    const seen = new Set<string>();
    while (cur?.parentSlug && !seen.has(cur.parentSlug)) {
      seen.add(cur.parentSlug);
      const anc = parents.get(cur.parentSlug);
      if (!anc) break;
      if (wantedSlugs.has(anc.slug) && !boundarySlugs.has(anc.slug) && !have.has(anc.slug)) {
        have.add(anc.slug);
        out.push({
          slug: anc.slug, name: anc.name, level: anc.level,
          onBoundary: false, geometryHash: null,
          viaDescent: { fromSlug: desc.slug, geometryHash: desc.geometryHash },
        });
      }
      cur = anc;
    }
  }
  return [...applicable, ...out].sort(byLevelRank);
}

export function byLevelRank(a: Resolved, b: Resolved): number {
  const d = (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9);
  return d !== 0 ? d : a.name.localeCompare(b.name);
}

export function resolveFromCandidates(
  candidates: GeoCandidate[], lat: number, lng: number,
): { applicable: Resolved[]; centroidOnly: string[] } {
  const applicable: Resolved[] = [];
  const centroidOnly: string[] = [];
  for (const c of candidates) {
    if (!isGeometry(c.boundary)) {
      if (c.geoKind === "centroid") centroidOnly.push(c.slug);
      continue;
    }
    if (c.bbox && !inBBox(c.bbox, lat, lng)) continue;
    const hit = pointInGeometry(c.boundary, lat, lng);
    if (hit !== "outside") {
      applicable.push({
        slug: c.slug, name: c.name, level: c.level,
        onBoundary: hit === "boundary", geometryHash: c.geometryHash,
      });
    }
  }
  applicable.sort(byLevelRank);
  return { applicable, centroidOnly };
}

export type RateComponent = {
  slug: string; rateValue: number; rateUnit: string; appliesTo: string | null;
};

export function stackComponents(components: RateComponent[]): { combinedPercent: number; nonPercent: RateComponent[] } {
  let combined = 0;
  const nonPercent: RateComponent[] = [];
  for (const c of components) {
    if (c.rateUnit === "percent") combined += c.rateValue;
    else nonPercent.push(c);
  }
  // Percent points at 6dp storage; trim float dust from the addition only.
  return { combinedPercent: Number(combined.toFixed(6)), nonPercent };
}

function parseLatLng(args: string[]): { lat: number; lng: number; date: string } | { error: string } {
  const argVal = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const lat = Number(argVal("--lat"));
  const lng = Number(argVal("--lng"));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: "lat_out_of_range: --lat must be in [-90, 90]" };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { error: "lng_out_of_range: --lng must be in [-180, 180]" };
  return { lat, lng, date: argVal("--date") ?? new Date().toISOString().slice(0, 10) };
}

async function loadCandidates(date: string): Promise<GeoCandidate[]> {
  const rows = await db.select({
    slug: jurisdictions.slug, name: jurisdictions.name, level: jurisdictions.level,
    geoKind: jurisdictionGeo.geoKind,
    minLat: jurisdictionGeo.minLat, maxLat: jurisdictionGeo.maxLat,
    minLng: jurisdictionGeo.minLng, maxLng: jurisdictionGeo.maxLng,
    boundary: jurisdictionGeo.boundaryGeojson, geometryHash: jurisdictionGeo.geometryHash,
  }).from(jurisdictionGeo)
    .innerJoin(jurisdictions, eq(jurisdictions.id, jurisdictionGeo.jurisdictionId))
    .where(and(
      lte(jurisdictionGeo.effectiveFrom, date),
      or(isNull(jurisdictionGeo.effectiveTo), gte(jurisdictionGeo.effectiveTo, date)),
      eq(jurisdictionGeo.verificationStatus, "verified"),
    ));
  return rows.map((r) => ({
    slug: r.slug, name: r.name, level: r.level, geoKind: r.geoKind,
    bbox: r.minLat !== null && r.maxLat !== null && r.minLng !== null && r.maxLng !== null
      ? { minLat: Number(r.minLat), maxLat: Number(r.maxLat), minLng: Number(r.minLng), maxLng: Number(r.maxLng) }
      : null,
    boundary: r.boundary, geometryHash: r.geometryHash,
  }));
}

export async function runGeoResolve(args: string[]): Promise<Record<string, unknown>> {
  const p = parseLatLng(args);
  if ("error" in p) return { error: p.error };
  const candidates = await loadCandidates(p.date);
  const { applicable, centroidOnly } = resolveFromCandidates(candidates, p.lat, p.lng);
  return {
    point: { lat: p.lat, lng: p.lng }, asOf: p.date,
    calcVersion: GEO_PIP_VERSION,
    applicable,
    unresolvedNoBoundary: centroidOnly,
    reason: applicable.length ? null : (candidates.length ? "outside_coverage" : "no_published_geo"),
  };
}

export async function runRateAtPoint(args: string[]): Promise<Record<string, unknown>> {
  const p = parseLatLng(args);
  if ("error" in p) return { error: p.error };
  const argVal = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const typeSlug = argVal("--tax-type");
  if (!typeSlug) return { error: "usage: tax rate at-point --lat <n> --lng <n> --tax-type <slug> [--date <yyyy-mm-dd>]" };
  const [tt] = await db.select().from(taxTypes).where(eq(taxTypes.slug, typeSlug)).limit(1);
  if (!tt) return { error: "unknown_tax_type", taxType: typeSlug };

  const resolved = await runGeoResolve(args);
  const applicable = (resolved.applicable as Resolved[]) ?? [];
  const boundaryTested = applicable;

  const rows = await db.select({
    slug: jurisdictions.slug, rateValue: taxRates.rateValue,
    rateUnit: taxRates.rateUnit, appliesTo: taxRates.appliesTo,
  }).from(taxRates)
    .innerJoin(jurisdictions, eq(jurisdictions.id, taxRates.jurisdictionId))
    .where(and(
      eq(taxRates.taxTypeId, tt.id),
      lte(taxRates.effectiveFrom, p.date),
      or(isNull(taxRates.effectiveTo), gte(taxRates.effectiveTo, p.date)),
      isNotNull(taxRates.rateValue),
    ));

  // #60: ancestors of boundary-tested jurisdictions that impose this tax
  // but have no boundary (e.g. ca over a province, us over a state) count
  // as applicable-by-descent; everything else unresolved stays PARTIAL.
  const jurRows = await db.select({
    slug: jurisdictions.slug, name: jurisdictions.name, level: jurisdictions.level, parentId: jurisdictions.parentId, id: jurisdictions.id,
  }).from(jurisdictions);
  const slugById = new Map(jurRows.map((j) => [j.id, j.slug]));
  const parents = new Map(jurRows.map((j) => [j.slug, {
    slug: j.slug, name: j.name, level: j.level,
    parentSlug: j.parentId ? (slugById.get(j.parentId) ?? null) : null,
  }]));
  const boundarySlugSet = new Set((await loadCandidates(p.date)).filter((c) => isGeometry(c.boundary)).map((c) => c.slug));
  const fullApplicable = applicableByDescent(
    boundaryTested, parents, new Set(rows.map((r) => r.slug)), boundarySlugSet,
  );
  const applicableSlugs = new Set(fullApplicable.map((a) => a.slug));

  const components: RateComponent[] = [];
  const unresolvedComponents: string[] = [];
  const boundarySlugs = boundarySlugSet;
  for (const r of rows) {
    const comp = { slug: r.slug, rateValue: Number(r.rateValue), rateUnit: r.rateUnit, appliesTo: r.appliesTo };
    if (applicableSlugs.has(r.slug)) components.push(comp);
    else if (!boundarySlugs.has(r.slug)) unresolvedComponents.push(r.slug);
  }
  const { combinedPercent, nonPercent } = stackComponents(components);
  const unresolvedUnique = [...new Set(unresolvedComponents)].sort();
  return {
    point: { lat: p.lat, lng: p.lng }, asOf: p.date, taxType: typeSlug,
    calcVersions: [GEO_PIP_VERSION, RATE_STACK_VERSION],
    applicable: fullApplicable, components, combinedPercent, nonPercent,
    complete: unresolvedUnique.length === 0,
    unresolvedComponents: unresolvedUnique,
    instruction: unresolvedUnique.length
      ? "PARTIAL sum: listed jurisdictions impose this tax but have no published boundary to test — do not present combinedPercent as complete."
      : "Complete: every imposing jurisdiction was boundary-tested or proven by descent from a boundary-tested descendant.",
  };
}
