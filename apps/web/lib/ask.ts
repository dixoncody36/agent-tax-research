import { client } from "@agent-tax-research/database";
import { levelRank } from "./levels";

// Deterministic Q&A over PUBLISHED data (B3). No model, no network beyond
// the app's own /api/geo/resolve: intent + entity resolution by rule, then
// SQL. It never invents a number — when something is not understood or not
// published, the answer says exactly that. Published = verification_status
// 'verified'. ponytail: an optional MODEL_API_KEY parsing assist was left
// out (untestable without a key); this path is the deliverable and fallback.

import type { AskResult, Evidence, Flag, Intent } from "./askTypes";
import { EXAMPLES } from "./askTypes";
export type { AskResult, Evidence } from "./askTypes";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.\-\s]/g, " ").replace(/\./g, " ").replace(/\s+/g, " ").trim();

// Phrase -> tax category (+ optional name filter so "sales tax" does not
// sweep in boat or housing levies that merely sit in the same category).
const SYNONYMS: { re: RegExp; category: string; name?: RegExp }[] = [
  { re: /\bsales (and use )?tax(es)?\b|\bsales\/use\b|\buse tax\b|\bsales & use\b/, category: "sales_tax", name: /sales/i },
  { re: /\bhotel\b|\boccupancy\b|\blodging\b/, category: "occupancy" },
  { re: /\bfranchise\b|\bmargins? tax\b/, category: "franchise_margin" },
  { re: /\bexcise\b/, category: "excise" },
  { re: /\bseverance\b/, category: "severance" },
  { re: /\bproperty tax(es)?\b/, category: "property" },
  { re: /\bincome tax(es)?\b/, category: "income" },
  { re: /\bpayroll\b/, category: "payroll" },
  { re: /\bgross receipts\b/, category: "gross_receipts" },
  { re: /\bvat\b|\bgst\b|\bvalue added\b|\bgoods and services tax\b/, category: "vat_gst" },
  { re: /\bfees?\b/, category: "fee" },
];
const STOP = new Set(["tax", "taxes", "and", "the", "of", "for", "a", "an", "to", "in", "on"]);

type J = { id: string; slug: string; name: string; level: string; parent_id: string | null };
type TT = { id: string; slug: string; name: string; category: string; jurisdiction_id: string };

function parseDate(q: string, notes: string[]): string {
  const iso = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && !Number.isNaN(new Date(`${iso[1]}T00:00:00Z`).getTime())) return iso[1]!;
  const yr = q.match(/\b(?:in|for|during|as of)\s+((?:19|20)\d{2})\b/);
  if (yr) { notes.push(`Only a year was given; evaluated as of ${yr[1]}-01-01.`); return `${yr[1]}-01-01`; }
  return new Date().toISOString().slice(0, 10);
}

function resolvePlace(qn: string, js: J[]): { best: J | null; also: J[]; matched: string } {
  const padded = ` ${qn} `;
  let bestLen = 0;
  let hits: { j: J; alias: string }[] = [];
  for (const j of js) {
    const full = norm(j.name);
    // Exact full-name matches outrank the suffix-stripped alias, so
    // "Austin" is the city, not Austin County (which is still reported
    // as an alternative only when no exact match exists).
    const aliases: [string, number][] = [[full, 1], [full.replace(/ (county|city|parish)$/, ""), 0]];
    for (const [a, exact] of aliases) {
      if (a.length < 3 || !padded.includes(` ${a} `)) continue;
      const key = a.length * 2 + exact;
      if (key > bestLen) { bestLen = key; hits = []; }
      if (key === bestLen) hits.push({ j, alias: a });
    }
  }
  if (!hits.length) return { best: null, also: [], matched: "" };
  hits.sort((x, y) => levelRank(x.j.level) - levelRank(y.j.level) || x.j.name.localeCompare(y.j.name));
  const seen = new Set<string>();
  const uniq = hits.filter((h) => (seen.has(h.j.id) ? false : (seen.add(h.j.id), true)));
  return { best: uniq[0]!.j, also: uniq.slice(1, 6).map((h) => h.j), matched: uniq[0]!.alias };
}

function resolveTax(qn: string, tts: TT[]): { types: TT[]; scope: "specific" | "category" | "none" } {
  const words = new Set(qn.split(" ").map((w) => w.replace(/s$/, "")));
  let top = 0;
  let specific: TT[] = [];
  for (const t of tts) {
    const toks = [...new Set(norm(t.name).split(" ").filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/s$/, "")))];
    if (!toks.length) continue;
    const hit = toks.filter((w) => words.has(w)).length;
    if (hit < Math.min(2, toks.length) || hit / toks.length < 0.4) continue;
    const score = hit / toks.length + hit;
    if (score > top) { top = score; specific = []; }
    if (score === top) specific.push(t);
  }
  if (specific.length) return { types: specific, scope: "specific" };
  const cats = SYNONYMS.filter((s) => s.re.test(qn));
  const types = cats.flatMap((s) => tts.filter((t) => t.category === s.category && (!s.name || s.name.test(t.name))));
  return types.length ? { types: [...new Map(types.map((t) => [t.id, t])).values()], scope: "category" } : { types: [], scope: "none" };
}

function detectIntent(q: string, hasPlace: boolean, hasTax: boolean, coords: boolean): Intent {
  if (coords) return "coords";
  if (/^(which|what|list|who)\b/.test(q) && /\b(jurisdictions?|states?|provinces?|countries|places|cities|counties|localities)\b/.test(q) && /\b(levy|levies|charge|charges|impose|imposes|have|has|with|tax)\b/.test(q) && hasTax && !hasPlace) return "which";
  if (/^(does|do|is there|are there|has|have)\b/.test(q) && hasPlace && hasTax) return "exists";
  if (hasPlace && hasTax) return "rate";
  return "unknown";
}

async function latestEvidence(rows: { source_name: string | null; source_url: string | null; citation: string | null; snapshot_at: string | null }[]): Promise<Evidence[]> {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const r of rows) {
    const key = `${r.source_url ?? r.source_name ?? ""}|${r.citation ?? ""}`;
    if (seen.has(key) || (!r.source_url && !r.citation)) continue;
    seen.add(key);
    out.push({ title: r.source_name ?? "source", url: r.source_url, citation: r.citation, snapshotAt: r.snapshot_at });
  }
  return out;
}

export async function ask(question: string, origin: string): Promise<AskResult> {
  const notes: string[] = [];
  const q = question.trim().slice(0, 300);
  const qn = norm(q);
  const asOf = parseDate(qn, notes);

  const [js, tts] = await Promise.all([
    client`SELECT id, slug, name, level::text AS level, parent_id FROM jurisdictions` as unknown as Promise<J[]>,
    client`SELECT id, slug, name, category, jurisdiction_id FROM tax_types` as unknown as Promise<TT[]>,
  ]);

  const cm = q.match(/(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
  const coords = cm ? { lat: Number(cm[1]), lng: Number(cm[2]) } : null;
  const place = coords ? { best: null as J | null, also: [] as J[], matched: "" } : resolvePlace(qn, js);
  const rest = place.matched ? ` ${qn} `.replace(` ${place.matched} `, " ").trim() : qn;
  const tax = resolveTax(rest, tts);
  const intent = detectIntent(qn, !!place.best, tax.types.length > 0, !!coords);
  if (place.also.length) notes.push(`“${place.best!.name}” is ambiguous — also matches ${place.also.map((a) => `${a.name} (${a.level.replace(/_/g, " ")})`).join(", ")}. Using the highest-level match; name the state to disambiguate.`);
  if (tax.scope === "category" && tax.types.length > 1) notes.push(`“${tax.types.map((t) => t.name).slice(0, 3).join("”, “")}${tax.types.length > 3 ? "…" : ""}” all fit; answering across ${tax.types.length} tax types.`);

  const interpretation: AskResult["interpretation"] = {
    question: q, intent, parsedBy: "deterministic",
    jurisdiction: place.best ? { slug: place.best.slug, name: place.best.name, level: place.best.level } : null,
    alsoMatches: place.also.map((a) => ({ slug: a.slug, name: a.name, level: a.level })),
    taxTypes: tax.types.map((t) => ({ slug: t.slug, name: t.name })), taxScope: tax.scope, asOf, coordinates: coords, notes,
  };
  const done = (answer: AskResult["answer"], evidence: Evidence[] = []): AskResult => ({ interpretation, answer, evidence });

  if (intent === "unknown") {
    const missing = [!place.best && "a place I recognize", tax.types.length === 0 && "a tax type I recognize"].filter(Boolean).join(" and ");
    return done({
      kind: "not_understood",
      headline: "I could not turn that into a question I can answer from published data.",
      rows: [{ label: "Not understood", value: `I did not find ${missing || "a supported question shape"} in “${q}”.` }, { label: "Try", value: EXAMPLES.join("  ·  ") }],
      flags: [{ level: "info", text: "No answer was generated and no number was guessed." }],
    });
  }

  const ids = tax.types.map((t) => t.id);

  if (intent === "coords") {
    const lat = coords!.lat, lng = coords!.lng;
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) {
      return done({ kind: "not_understood", headline: "Coordinates out of range.", rows: [{ label: "Range", value: "Latitude must be in [-90, 90] and longitude in [-180, 180]." }], flags: [] });
    }
    const taxSlug = tax.types.length === 1 ? tax.types[0]!.slug : "us-tx-sales-use";
    if (tax.types.length !== 1) notes.push("No single tax type named; using Texas Sales and Use Tax (the published point-lookup stack).");
    const r = await fetch(`${origin}/api/geo/resolve?lat=${lat}&lng=${lng}&taxType=${encodeURIComponent(taxSlug)}`);
    const d = (await r.json()) as { error?: string; applicable: { slug: string; name: string; level: string; geometryHash: string }[]; components: { slug: string; rateValue: number; rateUnit: string }[]; combinedPercent: number; complete: boolean; unresolvedCount: number; reason: string | null };
    if (!r.ok) return done({ kind: "not_understood", headline: d.error ?? "Lookup failed.", rows: [], flags: [] });
    if (!d.applicable.length) {
      return done({
        kind: "unknown", headline: "No published boundary covers that point.",
        rows: [{ label: "Reason", value: d.reason === "no_published_geo" ? "No boundaries are published yet." : "The point is outside published boundary coverage." }],
        flags: [{ level: "unknown", text: "Unknown is not zero: the point may be taxed by jurisdictions whose boundaries are not published." }],
      });
    }
    const flags: Flag[] = d.complete ? [] : [{ level: "partial", text: `PARTIAL: ${d.unresolvedCount} imposing jurisdiction(s) have no published boundary, so this sum is a floor, not the final rate.` }];
    return done({
      kind: "answer", headline: `Combined ${taxSlug} rate at ${lat}, ${lng}: ${d.combinedPercent.toLocaleString(undefined, { maximumFractionDigits: 6 })}%${d.complete ? "" : " (partial)"}`,
      combinedPercent: d.combinedPercent,
      rows: d.applicable.map((a) => {
        const c = d.components.find((x) => x.slug === a.slug);
        return { label: `${a.name} (${a.level.replace(/_/g, " ")})`, value: c ? `${c.rateValue.toLocaleString(undefined, { maximumFractionDigits: 6 })}%` : "boundary only — no rate for this tax type", detail: `geometry ${a.geometryHash.slice(0, 12)}…` };
      }),
      flags,
    }, d.applicable.map((a) => ({ title: `Boundary: ${a.name}`, url: `/explore?slug=${a.slug}&tab=geo`, citation: `geometry_hash ${a.geometryHash}`, snapshotAt: null })));
  }

  if (intent === "which") {
    const rows = await client`
      SELECT tt.slug, tt.name, j.name AS j_name, j.slug AS j_slug,
        (SELECT json_agg(json_build_object('v', r.rate_value::text, 'u', r.rate_unit, 'a', r.applies_to) ORDER BY r.rate_value DESC)
           FROM tax_rates r WHERE r.tax_type_id = tt.id AND r.jurisdiction_id = tt.jurisdiction_id AND r.verification_status = 'verified'
             AND r.effective_from <= ${asOf}::date AND (r.effective_to IS NULL OR r.effective_to >= ${asOf}::date)) AS rates,
        (SELECT count(*)::int FROM tax_rates r WHERE r.tax_type_id = tt.id AND r.verification_status = 'verified'
             AND r.effective_from <= ${asOf}::date AND (r.effective_to IS NULL OR r.effective_to >= ${asOf}::date)) AS published_components
      FROM tax_types tt JOIN jurisdictions j ON j.id = tt.jurisdiction_id
      WHERE tt.id = ANY(${ids}) ORDER BY j.name, tt.name`;
    const ev = await client`
      SELECT DISTINCT ON (s.id, r.citation) s.name AS source_name, s.url AS source_url, r.citation,
        (SELECT max(created_at)::text FROM source_snapshots n WHERE n.source_id = s.id) AS snapshot_at
      FROM tax_rates r LEFT JOIN sources s ON s.id = r.source_id
      WHERE r.tax_type_id = ANY(${ids}) AND r.verification_status = 'verified' LIMIT 20`;
    const flags: Flag[] = [];
    const unpub = rows.filter((r) => !r.rates);
    if (unpub.length) flags.push({ level: "unknown", text: `${unpub.length} of ${rows.length} levy(ies) have no published rate yet — listed without a number, not assumed zero.` });
    flags.push({ level: "info", text: "Only levies recorded in this database are listed; absence from this list is not proof that another jurisdiction has no such tax." });
    return done({
      kind: "answer", headline: `${rows.length} recorded levy(ies) match ${tax.scope === "specific" ? "that tax" : "that tax category"}`,
      rows: rows.map((r) => ({
        label: `${r.j_name} — ${r.name}`,
        value: r.rates ? (r.rates as { v: string; u: string }[]).slice(0, 3).map((x) => `${Number(x.v).toLocaleString(undefined, { maximumFractionDigits: 6 })}${x.u === "percent" ? "%" : ` ${String(x.u).replace(/_/g, " ")}`}`).join(", ") : "no published rate",
        detail: r.published_components > 0 ? `${r.published_components} published component(s) · /explore?slug=${r.j_slug}` : `/explore?slug=${r.j_slug}`,
      })),
      flags,
    }, await latestEvidence(ev as never));
  }

  const place_ = place.best!;
  if (intent === "exists") {
    const administered = tax.types.filter((t) => t.jurisdiction_id === place_.id);
    const imposed = await client`
      SELECT DISTINCT tt.name, tt.slug FROM tax_rates r JOIN tax_types tt ON tt.id = r.tax_type_id
      WHERE r.jurisdiction_id = ${place_.id} AND r.tax_type_id = ANY(${ids})`;
    const cov = await client`
      SELECT a.status, a.answer, tt.name AS tax_name FROM coverage_answers a LEFT JOIN tax_types tt ON tt.id = a.tax_type_id
      WHERE a.jurisdiction_id = ${place_.id} AND a.question_key = 'levy_exists' AND (a.tax_type_id = ANY(${ids}))`;
    const led = await client`
      SELECT l.question_key, l.determination, l.status, l.snapshot_hash FROM research_ledger l
      WHERE l.jurisdiction_id = ${place_.id} AND l.tax_type_id = ANY(${ids})`;
    const evRows = await client`
      SELECT s.name AS source_name, s.url AS source_url, NULL::text AS citation, (SELECT max(created_at)::text FROM source_snapshots n WHERE n.source_id = s.id) AS snapshot_at
      FROM sources s WHERE s.jurisdiction_id = ${place_.id} AND s.tax_type_id = ANY(${ids})`;
    const rows: { label: string; value: string; detail?: string }[] = [];
    const flags: Flag[] = [];
    let headline: string;
    let kind: "answer" | "unknown" = "answer";
    if (administered.length || imposed.length) {
      headline = `Present — ${place_.name} ${administered.length ? "administers" : "imposes a component of"} ${(administered.length ? administered.map((t) => t.name) : imposed.map((t) => t.name as string)).join("; ")}.`;
      for (const c of cov) rows.push({ label: "Ledger / coverage", value: `${c.tax_name}: ${String(c.status).replace(/_/g, " ")}`, detail: c.answer ?? undefined });
    } else if (cov.some((c) => c.status === "found")) {
      headline = `Present per coverage record for ${place_.name}.`;
      for (const c of cov) rows.push({ label: "Coverage", value: `${c.tax_name}: ${c.status}`, detail: c.answer ?? undefined });
    } else if (cov.some((c) => c.status === "confirmed_absent")) {
      headline = `Confirmed absent — searched and not found for ${place_.name}.`;
      for (const c of cov) rows.push({ label: "Coverage", value: `${c.tax_name}: ${c.status}`, detail: c.answer ?? undefined });
    } else {
      kind = "unknown";
      headline = `Unknown — ${place_.name} has no recorded levy of that kind and no recorded search for its absence.`;
      flags.push({ level: "unknown", text: "Unknown means not yet researched. It is not a finding that the tax does not exist." });
      for (const c of cov) rows.push({ label: "Coverage", value: `${c.tax_name}: ${c.status}` });
    }
    for (const l of led) rows.push({ label: `Ledger · ${l.question_key}`, value: String(l.status).replace(/_/g, " "), detail: [l.determination, l.snapshot_hash ? `snapshot ${String(l.snapshot_hash).slice(0, 12)}…` : null].filter(Boolean).join(" · ") });
    return done({ kind, headline, rows, flags }, await latestEvidence(evRows as never));
  }

  // rate
  const chain = await client`
    WITH RECURSIVE a AS (
      SELECT id, parent_id FROM jurisdictions WHERE id = ${place_.id}
      UNION ALL SELECT p.id, p.parent_id FROM jurisdictions p JOIN a ON a.parent_id = p.id
    ) SELECT id FROM a`;
  const chainIds = chain.map((c) => c.id as string);
  const rates = await client`
    SELECT tt.slug AS tax_slug, tt.name AS tax_name, j.name AS j_name, j.level::text AS j_level, j.slug AS j_slug,
      r.rate_value::text AS rate_value, r.rate_unit, r.applies_to, r.effective_from::text AS effective_from, r.effective_to::text AS effective_to,
      r.citation, s.name AS source_name, s.url AS source_url,
      (SELECT max(created_at)::text FROM source_snapshots n WHERE n.source_id = s.id) AS snapshot_at
    FROM tax_rates r JOIN tax_types tt ON tt.id = r.tax_type_id JOIN jurisdictions j ON j.id = r.jurisdiction_id
    LEFT JOIN sources s ON s.id = r.source_id
    WHERE r.tax_type_id = ANY(${ids}) AND r.jurisdiction_id = ANY(${chainIds}) AND r.verification_status = 'verified'
      AND r.effective_from <= ${asOf}::date AND (r.effective_to IS NULL OR r.effective_to >= ${asOf}::date)
    ORDER BY tt.name, (CASE j.level::text WHEN 'country' THEN 0 WHEN 'state' THEN 1 WHEN 'province' THEN 1 WHEN 'county' THEN 2 WHEN 'city' THEN 3 ELSE 4 END), j.name`;
  const unpub = await client`
    SELECT count(*)::int AS n FROM tax_rates r WHERE r.tax_type_id = ANY(${ids}) AND r.jurisdiction_id = ANY(${chainIds}) AND r.verification_status <> 'verified'`;
  const overlap = await client`
    SELECT j.name FROM tax_rates r JOIN jurisdictions j ON j.id = r.jurisdiction_id
    WHERE r.tax_type_id = ANY(${ids}) AND j.level = 'special_district' AND r.verification_status = 'verified'
      AND r.effective_from <= ${asOf}::date AND (r.effective_to IS NULL OR r.effective_to >= ${asOf}::date)
      AND NOT (r.jurisdiction_id = ANY(${chainIds})) GROUP BY j.name ORDER BY j.name`;

  const flags: Flag[] = [];
  if (unpub[0]!.n > 0) flags.push({ level: "info", text: `${unpub[0]!.n} unpublished rate row(s) exist for this place and are excluded.` });
  if (!rates.length) {
    flags.push({ level: "unknown", text: "No published rate found. This is not a finding that the tax does not exist or is zero." });
    return done({ kind: "unknown", headline: `No published ${tax.types.map((t) => t.name).join(" / ")} rate for ${place_.name} as of ${asOf}.`, rows: [], flags });
  }
  const byTax = new Map<string, (typeof rates)[number][]>();
  for (const r of rates) byTax.set(r.tax_slug as string, [...(byTax.get(r.tax_slug as string) ?? []), r]);
  const rows: { label: string; value: string; detail?: string }[] = [];
  let combined: number | undefined;
  for (const [, comps] of byTax) {
    const fmt = (r: (typeof rates)[number]) => `${Number(r.rate_value).toLocaleString(undefined, { maximumFractionDigits: 6 })}${r.rate_unit === "percent" ? "%" : ` ${String(r.rate_unit).replace(/_/g, " ")}`}`;
    for (const r of comps) rows.push({ label: `${r.j_name} (${String(r.j_level).replace(/_/g, " ")}) — ${r.tax_name}`, value: fmt(r), detail: [r.applies_to, `effective ${r.effective_from}${r.effective_to ? ` to ${r.effective_to}` : " onward"}`].filter(Boolean).join(" · ") });
    if (comps.every((c) => c.rate_unit === "percent")) {
      const sum = Number(comps.reduce((s, c) => s + Number(c.rate_value), 0).toFixed(6));
      if (comps.length > 1) rows.push({ label: `Combined (${comps.length} components)`, value: `${sum.toLocaleString(undefined, { maximumFractionDigits: 6 })}%` });
      combined = combined === undefined ? sum : undefined;
    }
  }
  if (overlap.length) {
    flags.push({ level: "partial", text: `PARTIAL: ${overlap.length} overlapping special-district component(s) (${overlap.slice(0, 3).map((o) => o.name).join(", ")}${overlap.length > 3 ? "…" : ""}) also levy this tax but cannot be placed by name. Ask with coordinates (e.g. “Rate at 30.2672, -97.7431”) for the boundary-tested stack.` });
  }
  const headline = byTax.size === 1 && combined !== undefined
    ? `${[...byTax.values()][0]![0]!.tax_name} in ${place_.name}: ${combined.toLocaleString(undefined, { maximumFractionDigits: 6 })}%${overlap.length ? " (partial)" : ""} as of ${asOf}`
    : `Published rates for ${place_.name} as of ${asOf}`;
  return done({ kind: "answer", headline, rows, flags, combinedPercent: combined }, await latestEvidence(rates as never));
}
