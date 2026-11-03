import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { client } from "@agent-tax-research/database";

// Audit pack generator v1 (issue #25, anvil decision 027): for one
// jurisdiction, emit a re-performable bundle — verified rates with
// citations + evidence hashes, a recomputed tie-out (rate components
// summed per place where a published total exists), the calculation
// register, and a SHA-256 manifest so an auditor can verify the pack
// itself. CSV opens in Excel for re-performance; the live-formula
// .xlsx workpaper is the follow-up once the shared generator lands.
// Usage: pnpm --filter @agent-tax-research/cli exec tsx src/audit-pack.ts us-tx [outDir]
const slug = process.argv[2];
if (!slug) throw new Error("usage: audit-pack.ts <jurisdiction-slug> [outDir]");
const outDir = process.argv[3] ?? `audit-packs/${slug}-${new Date().toISOString().slice(0, 10)}`;
mkdirSync(outDir, { recursive: true });
const esc = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const toCsv = (rows: Record<string, unknown>[]) =>
  rows.length === 0 ? "" : [Object.keys(rows[0]!).join(","), ...rows.map((r) => Object.values(r).map(esc).join(","))].join("\n") + "\n";
const files = new Map<string, string>();
const save = (name: string, content: string) => { writeFileSync(`${outDir}/${name}`, content, "utf8"); files.set(name, content); };

const [jur] = await client`SELECT * FROM jurisdictions WHERE slug = ${slug}`;
if (!jur) throw new Error(`jurisdiction ${slug} not found`);
// Subtree (jurisdiction + descendants) via recursive CTE
const rates = await client`
  WITH RECURSIVE tree AS (
    SELECT id, slug, name, level FROM jurisdictions WHERE slug = ${slug}
    UNION ALL SELECT j.id, j.slug, j.name, j.level FROM jurisdictions j JOIN tree t ON j.parent_id = t.id
  )
  SELECT t.slug AS jurisdiction, tt.name AS tax_type, r.rate_value, r.rate_unit, r.applies_to,
    r.effective_from, r.effective_to, r.verification_status, r.citation,
    s.url AS source_url, sn.content_hash AS snapshot_sha256, sn.created_at AS snapshot_at
  FROM tax_rates r
  JOIN tree t ON t.id = r.jurisdiction_id
  JOIN tax_types tt ON tt.id = r.tax_type_id
  LEFT JOIN sources s ON s.id = r.source_id
  LEFT JOIN LATERAL (SELECT * FROM source_snapshots WHERE source_id = s.id ORDER BY created_at DESC LIMIT 1) sn ON true
  ORDER BY tt.name, t.slug, r.effective_from`;
save("verified-rates.csv", toCsv(rates.filter((r) => r.verification_status === "verified") as unknown as Record<string, unknown>[]));
save("all-rates-incl-unverified.csv", toCsv(rates as unknown as Record<string, unknown>[]));

// Tie-out (027 #10, tolerance 0): recompute state+city components against
// the published combined total recorded on each bulk extraction item
// (payload.appliesTo cites the official table row + snapshot). Arithmetic
// is integer micro-units (percent-points * 1e6) — never float (027 #7).
// Positive residual = county/SPD/transit components on the same row;
// NEGATIVE residual (components exceed published total) is impossible if
// extraction is right, so it writes an append-only exception (027 #11).
// Known v1 gap: the combined total is read from the extraction record,
// not a first-class published total row; datavalues copies are display
// hints only and are NOT used here (015: datavalues never sources an
// audited value).
const micro = (v: unknown) => Math.round(Number(v) * 1e6);
const fromMicro = (m: number) => (m / 1e6).toFixed(6);
const [stateRate] = await client`
  SELECT rate_value FROM tax_rates r JOIN jurisdictions j ON j.id = r.jurisdiction_id
  JOIN tax_types tt ON tt.id = r.tax_type_id
  WHERE j.slug = ${slug} AND tt.slug LIKE '%sales%' AND r.verification_status = 'verified'
  ORDER BY r.created_at DESC LIMIT 1`;
const cityItems = await client`
  SELECT (i.payload->>'jurisdictionSlug') AS city_slug, j.name AS city_name,
    (i.payload->>'rateValue')::numeric AS city_rate, i.payload->>'appliesTo' AS applies_to, p.status AS proposal_status
  FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id
  JOIN jurisdictions j ON j.slug = (i.payload->>'jurisdictionSlug')
  WHERE p.jurisdiction_id = ${jur.id} AND i.target_table = 'tax_rates'
    AND i.payload->>'appliesTo' LIKE 'City sales/use tax component%'
    AND p.status IN ('verified', 'approved', 'published')`;
const tieOut: Record<string, unknown>[] = [];
let variances = 0;
if (stateRate) {
  for (const c of cityItems) {
    const m = /combined total shown ([\d.]+)%/.exec(String(c.applies_to));
    if (!m) continue;
    const recomputed = micro(stateRate.rate_value) + micro(c.city_rate);
    const total = micro(m[1]);
    const residual = total - recomputed;
    const flag = residual < 0 ? "EXCEPTION components exceed published total" : residual === 0 ? "T ties exactly" : "residual = county/SPD/transit components on official row";
    if (residual < 0) {
      variances += 1;
      await client`INSERT INTO exceptions (jurisdiction_id, exception_type, severity, status, detail)
        SELECT id, ${"audit_tie_out"}, ${"high"}, ${"open"}, ${`RATE-STACK tie-out negative residual ${fromMicro(residual)} for ${c.city_slug}: state ${String(stateRate.rate_value)} + city ${String(c.city_rate)} exceeds published total ${m[1]} (audit-pack)`}
        FROM jurisdictions WHERE slug = ${c.city_slug}`;
    }
    tieOut.push({ city: c.city_slug, name: c.city_name, state_component: fromMicro(micro(stateRate.rate_value)), city_component: fromMicro(micro(c.city_rate)), recomputed_state_plus_city: fromMicro(recomputed), published_combined_total: fromMicro(total), residual: fromMicro(residual), proposal_status: c.proposal_status, assessment: flag });
  }
}
save("tie-out-sales-stack.csv", tieOut.length ? toCsv(tieOut) : "no bulk city extraction items to tie out yet\n");

// Geo tab (M8 #41, GEO-PIP): published boundaries with re-performance
// identity (geometry hash + simplification + vintage citation), plus
// verified-but-unpublished proposals in their own file, clearly labeled.
// Fixture sheet: downtown Austin must resolve state+county+city from
// published rows (falling back to verified proposals pre-publish, marked).
const geoPublished = await client`
  SELECT j.slug AS jurisdiction, j.level, g.geo_kind, g.centroid_lat, g.centroid_lng,
    g.min_lat, g.max_lat, g.min_lng, g.max_lng, g.geometry_hash, g.simplification,
    g.precision, g.effective_from, g.effective_to, g.citation, s.url AS source_url
  FROM jurisdiction_geo g JOIN jurisdictions j ON j.id = g.jurisdiction_id
  LEFT JOIN sources s ON s.id = g.source_id
  WHERE j.slug = ${slug} OR j.slug LIKE ${slug + "-%"}
  ORDER BY j.level, j.slug`;
save("geo-boundaries-published.csv", geoPublished.length ? toCsv(geoPublished as unknown as Record<string, unknown>[]) : "no published geo yet (human publish gate pending)\n");
const geoProposed = await client`
  SELECT (i.payload->>'jurisdictionSlug') AS jurisdiction, p.status AS proposal_status,
    i.payload->>'centroidLat' AS centroid_lat, i.payload->>'centroidLng' AS centroid_lng,
    i.payload->>'geometryHash' AS geometry_hash, i.payload->>'simplification' AS simplification,
    i.citation
  FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id
  WHERE i.target_table = 'jurisdiction_geo' AND p.status IN ('verified', 'approved')
  ORDER BY 1`;
save("geo-boundaries-verified-unpublished.csv", geoProposed.length ? toCsv(geoProposed as unknown as Record<string, unknown>[]) : "none\n");
const geoTieOut = await client`SELECT * FROM reporting.geo_tie_out ORDER BY level`;
save("geo-tie-out.csv", toCsv(geoTieOut as unknown as Record<string, unknown>[]));
const geoFixtures = [
  { fixture: "downtown-austin", lat: 30.2672, lng: -97.7431, expected_cascade: "us-tx > us-tx-travis > us-tx-austin", check: "re-perform with: pnpm tax geo resolve --lat 30.2672 --lng -97.7431 (needs published geo; proposals in geo-boundaries-verified-unpublished.csv until then)", expected_combined: "8.25 when transit boundary published or confirmed_absent accepted; else PARTIAL 7.25 + transit unresolved" },
  { fixture: "buda-centroid", lat: "payload centroid", lng: "payload centroid", expected_cascade: "us-tx > us-tx-hays-county > us-tx-city-buda", check: "geo-populate fixture run (packages/cli/src/geo-populate.ts)", expected_combined: "per Comptroller combined total on the Buda extraction row" },
  { fixture: "outside-texas", lat: 35.0, lng: -106.0, expected_cascade: "(empty)", check: "pnpm tax geo resolve --lat 35 --lng -106", expected_combined: "n/a" },
];
save("geo-fixtures.csv", toCsv(geoFixtures as unknown as Record<string, unknown>[]));

const register = [
  { calc_id: "RATE-STACK", purpose: "Combined rate for a place = stack of jurisdictional components", method: "Sum effective-dated verified components (state+county+city+SPD+transit)", formula: "combined = Σ component.rate_value (percent-points), integer micro-units in tie-out", inputs: "tax_rates verified rows + official combined totals on extraction items", outputs: "tie-out-sales-stack.csv rows with residual vs published total", authority: "Texas Tax Code ch. 151 (state) + local ch. 321-327; TX Comptroller combined-rate tables", rounding: "storage numeric exact; no rounding in stack; display 6dp (table precision); tolerance 0 micro-units", owner: "agent-tax-research operators", elections: "percent stored as percent-points (6.25 = 6.25%)" },
  { calc_id: "EXTRACT-FACT", purpose: "Every published fact traces to pinned evidence + three distinct actors", method: "Snapshot SHA-256 pins source bytes; DB triggers reject pass verdicts without eligible citation and reject self-approval", formula: "publish allowed iff eligible(source) AND extractor ≠ verifier ≠ approver", inputs: "source_snapshots, proposal_items, proposals", outputs: "verified tax_rates/tax_rules rows with citation + snapshot hash", authority: "anvil decision 027; AGENTS.md source policy", rounding: "n/a", owner: "agent-tax-research operators", elections: "vendor/secondary content noted-only, never evidence" },
  { calc_id: "COVERAGE-ABSENCE", purpose: "Distinguish 'searched, not there' from 'not yet searched'", method: "Peer-profile question packs answered found/confirmed_absent/unknown with recorded negative search", formula: "n/a (classification)", inputs: "question packs, coverage answers", outputs: "coverage rows", authority: "docs/coverage.md", rounding: "n/a", owner: "agent-tax-research operators", elections: "unknown is honest default; absence requires recorded search" },
];
register.push({ calc_id: "GEO-PIP", purpose: "Point (lat/long) -> applicable jurisdictions whose published boundary contains it", method: "Ray-casting point-in-polygon over WGS84 GeoJSON, bbox prefilter; boundary point counts inside (flagged); test point never rounded", formula: "applicable = { j : PIP(boundary_j, point) } ordered by level rank; feeds RATE-STACK", inputs: "jurisdiction_geo verified rows (geometry_hash per row) + point", outputs: "geo resolve envelope with calc versions + deciding geometry hashes", authority: "Boundary as published by US Census Bureau TIGER/Line (TIGERweb) / Texas GIS, cited per row", rounding: "coordinates numeric(9,6) storage; simplification tolerance recorded per geometry; no rounding in containment", owner: "agent-tax-research operators", elections: "centroid-only jurisdictions never claim containment; unpublished SPD/transit boundaries are confirmed_absent, never drawn" });
save("calculation-register.csv", toCsv(register));

const inputSha = createHash("sha256").update(files.get("verified-rates.csv") ?? "").digest("hex");
let gitSha = "unknown";
try { gitSha = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* recorded as unknown */ }
const manifest = {
  pack: "audit-pack-v1", jurisdiction: slug, generatedAt: new Date().toISOString(),
  calcVersion: "audit-pack 1.0.0", gitSha,
  generator: "packages/cli/src/audit-pack.ts",
  inputsHash: inputSha, inputsNote: "SHA-256 of verified-rates.csv (canonical input rows for this pack)",
  counts: { ratesTotal: rates.length, ratesVerified: rates.filter((r) => r.verification_status === "verified").length, tieOutRows: tieOut.length, tieOutNegativeVariances: variances, geoPublished: geoPublished.length, geoVerifiedUnpublished: geoProposed.length, geoUnaccounted: geoTieOut.reduce((s, r) => s + Number(r.unaccounted), 0) },
  files: [...files.entries()].map(([name, content]) => ({ name, sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) })),
  retention: "default 7 years per anvil 027 — CONFIRM with engagement; local filesystem for now, Azure Blob WORM is the ship target (gap)",
  knownGaps: ["combined totals sourced from extraction records, not first-class published total rows", "no Entra signer identity locally — approver names are CLI-recorded strings", "CSV pack; live-formula .xlsx workpaper + PDF summary pending shared generator (027 s6)"],
  note: "DRAFT — generated for review. Re-perform: open CSVs in Excel; verify snapshot_sha256 against source_snapshots.content_hash; recompute stacks in tie-out file (integer micro-units, tolerance 0).",
};
save("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ outDir, ...manifest.counts }, null, 2));
await client.end();
