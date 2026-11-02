import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { client } from "@agent-tax-research/database";

// pnpm filter exec runs with cwd=packages/cli; resolve user paths
// against the caller's cwd first (same approach as tax.ts).
function readUserFile(path: string): string {
  const candidates = [path];
  if (process.env.INIT_CWD) candidates.unshift(resolve(process.env.INIT_CWD, path));
  for (const c of candidates) if (existsSync(c)) return readFileSync(c, "utf8");
  return readFileSync(path, "utf8");
}

// Product classification + downstream lookup (issues #28/#29).
// classify: deterministic fact-match against each category's recorded
// match rules (most specific match wins). The result is stored on
// operator_products as needs_review â€” a verifier/human still approves;
// re-running classify-check from the SAME recorded facts must reproduce
// the same category (027 re-performance), or it reports drift.
// lookup: published data only. Unknown category or no verified
// treatment fails closed and writes a typed exception â€” never a guess.
// Usage:
//   pnpm products classify --profile <slug> --name "<name>" --facts-file facts.json
//   pnpm products classify-check --id <operator_product_uuid>
//   pnpm products lookup --category software-saas --place us-tx-austin [--date 2026-01-01] [--tax-type us-tx-sales-use]
const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));

type Facts = Record<string, unknown>;
async function classifyFacts(facts: Facts): Promise<{ slug: string; code: string; matchedFacts: number } | null> {
  const cats = await client`SELECT slug, code, classification_facts FROM product_categories`;
  let best: { slug: string; code: string; matchedFacts: number } | null = null;
  for (const c of cats) {
    const cf = (c.classification_facts ?? {}) as { match?: Record<string, string> };
    const match = cf.match ?? {};
    const keys = Object.keys(match);
    if (keys.length === 0) continue;
    if (keys.every((k) => String(facts[k] ?? "") === match[k])) {
      if (!best || keys.length > best.matchedFacts) best = { slug: c.slug as string, code: c.code as string, matchedFacts: keys.length };
    }
  }
  return best;
}

if (cmd === "classify") {
  const profile = flag("profile"); const name = flag("name"); const factsFile = flag("facts-file");
  if (!profile || !name || !factsFile) { out({ error: "usage: products classify --profile <slug> --name <name> --facts-file <json>" }); process.exit(2); }
  const facts = JSON.parse(readUserFile(factsFile)) as Facts;
  const best = await classifyFacts(facts);
  const [cat] = best ? await client`SELECT id FROM product_categories WHERE slug = ${best.slug}` : [];
  const [row] = await client`
    INSERT INTO operator_products (profile_slug, name, facts, category_id, classification_status)
    VALUES (${profile}, ${name}, ${JSON.stringify(facts)}::jsonb, ${cat?.id ?? null}, ${best ? "needs_review" : "unclassified"})
    RETURNING id`;
  if (!best) {
    await client`INSERT INTO exceptions (exception_type, severity, status, detail)
      VALUES (${"unclassified_product"}, ${"medium"}, ${"open"}, ${`Operator product "${name}" (profile ${profile}) matched no category from facts ${JSON.stringify(facts)} â€” taxonomy gap or missing facts; not guessed.`})`;
  }
  out({ operatorProductId: row?.id, profile, name, classification: best, status: best ? "needs_review" : "unclassified", note: best ? "Verifier + human approval still required before treatments are relied on." : "Fail-closed: exception recorded, no bucket guessed." });
} else if (cmd === "sync-profile") {
  // Context profile products[] (#29): the operator declares what they
  // sell, with facts; each item is classified into the taxonomy and
  // queued needs_review. Treatments then populate only inside the
  // operator footprint. Re-running skips already-declared names.
  const profileFile = flag("profile-file");
  if (!profileFile) { out({ error: "usage: products sync-profile --profile-file contexts/<name>.json" }); process.exit(2); }
  const prof = JSON.parse(readUserFile(profileFile)) as { profile?: string; products?: { name: string; facts: Facts }[] };
  const profileSlug = prof.profile ?? "unknown-profile";
  const results: Record<string, unknown>[] = [];
  for (const item of prof.products ?? []) {
    const [existing] = await client`SELECT id FROM operator_products WHERE profile_slug = ${profileSlug} AND name = ${item.name} LIMIT 1`;
    if (existing) { results.push({ name: item.name, skipped: "already declared" }); continue; }
    const best = await classifyFacts(item.facts ?? {});
    const [cat] = best ? await client`SELECT id FROM product_categories WHERE slug = ${best.slug}` : [];
    const [row] = await client`
      INSERT INTO operator_products (profile_slug, name, facts, category_id, classification_status)
      VALUES (${profileSlug}, ${item.name}, ${JSON.stringify(item.facts ?? {})}::jsonb, ${cat?.id ?? null}, ${best ? "needs_review" : "unclassified"})
      RETURNING id`;
    if (!best) {
      await client`INSERT INTO exceptions (exception_type, severity, status, detail)
        VALUES (${"unclassified_product"}, ${"medium"}, ${"open"}, ${`Profile ${profileSlug} product "${item.name}" matched no category from its facts â€” not guessed.`})`;
    }
    results.push({ name: item.name, operatorProductId: row?.id, classification: best, status: best ? "needs_review" : "unclassified" });
  }
  out({ profile: profileSlug, declared: (prof.products ?? []).length, results });
} else if (cmd === "classify-check") {
  const id = flag("id");
  if (!id) { out({ error: "usage: products classify-check --id <uuid>" }); process.exit(2); }
  const [p] = await client`SELECT o.*, c.slug AS category_slug FROM operator_products o LEFT JOIN product_categories c ON c.id = o.category_id WHERE o.id = ${id}`;
  if (!p) { out({ error: "operator_product_not_found", id }); process.exit(2); }
  const again = await classifyFacts((p.facts ?? {}) as Facts);
  out({ operatorProductId: id, recordedCategory: p.category_slug, reclassifiedCategory: again?.slug ?? null, reproduces: (again?.slug ?? null) === (p.category_slug ?? null) });
} else if (cmd === "lookup") {
  const category = flag("category"); const place = flag("place");
  const date = flag("date") ?? new Date().toISOString().slice(0, 10);
  const taxTypeSlug = flag("tax-type") ?? "us-tx-sales-use";
  if (!category || !place) { out({ error: "usage: products lookup --category <slug> --place <jurisdiction-slug> [--date YYYY-MM-DD] [--tax-type <slug>]" }); process.exit(2); }
  const [cat] = await client`SELECT * FROM product_categories WHERE slug = ${category}`;
  const [jur] = await client`SELECT * FROM jurisdictions WHERE slug = ${place}`;
  if (!cat || !jur) {
    await client`INSERT INTO exceptions (exception_type, severity, status, detail)
      VALUES (${"product_lookup_unknown"}, ${"medium"}, ${"open"}, ${`Lookup failed closed: category=${category} place=${place} (cat found: ${Boolean(cat)}, place found: ${Boolean(jur)})`})`;
    out({ error: "unknown_category_or_place", category, place, failClosed: true }); process.exit(3);
  }
  // Treatment jurisdiction: walk ancestors of place (city -> county -> state -> country); nearest verified treatment wins.
  const chain = await client`
    WITH RECURSIVE up AS (
      SELECT id, slug, parent_id, 0 AS depth FROM jurisdictions WHERE id = ${jur.id}
      UNION ALL SELECT j.id, j.slug, j.parent_id, u.depth + 1 FROM jurisdictions j JOIN up u ON j.id = u.parent_id
    ) SELECT * FROM up ORDER BY depth`;
  const [tt] = await client`SELECT id FROM tax_types WHERE slug = ${taxTypeSlug}`;
  let treatment: Record<string, unknown> | null = null;
  for (const node of chain) {
    const [t] = await client`
      SELECT t.*, s.url AS source_url FROM product_tax_treatments t LEFT JOIN sources s ON s.id = t.source_id
      WHERE t.category_id = ${cat.id} AND t.jurisdiction_id = ${node.id}
        AND (${tt?.id ?? null}::uuid IS NULL OR t.tax_type_id = ${tt?.id ?? null})
        AND t.verification_status = 'verified'
        AND t.effective_from <= ${date} AND (t.effective_to IS NULL OR t.effective_to >= ${date})
      ORDER BY t.effective_from DESC LIMIT 1`;
    if (t) { treatment = { ...(t as unknown as Record<string, unknown>), decidedAtJurisdiction: node.slug }; break; }
  }
  if (!treatment) {
    await client`INSERT INTO exceptions (jurisdiction_id, exception_type, severity, status, detail)
      VALUES (${jur.id}, ${"product_treatment_unknown"}, ${"medium"}, ${"open"}, ${`No verified treatment for category ${category} in ${place} ancestry on ${date} â€” lookup failed closed, research required.`})`;
    out({ category, place, date, treatment: null, failClosed: true, note: "No verified treatment in the place ancestry. Exception recorded; agents must research before any rate is quoted." });
    process.exit(3);
  }
  // Stacked verified rate components along the ancestry (RATE-STACK).
  // ponytail: overlapping special districts are not in the parent chain;
  // they resolve by address in a later refinement and are flagged here.
  const components = tt ? await client`
    SELECT j.slug AS jurisdiction, r.rate_value, r.rate_unit, r.citation FROM tax_rates r
    JOIN jurisdictions j ON j.id = r.jurisdiction_id
    WHERE r.tax_type_id = ${tt.id} AND r.verification_status = 'verified'
      AND r.jurisdiction_id = ANY(${chain.map((c) => c.id as string)}::uuid[])
      AND r.effective_from <= ${date} AND (r.effective_to IS NULL OR r.effective_to >= ${date})
    ORDER BY j.slug` : [];
  const stacked = components.filter((c) => c.rate_unit === "percent").reduce((a, c) => a + Math.round(Number(c.rate_value) * 1e6), 0) / 1e6;
  out({
    category, place, date,
    treatment: { treatment: treatment.treatment, taxableFraction: treatment.taxable_fraction, summary: treatment.summary, sourcingRule: treatment.sourcing_rule, citation: treatment.citation, sourceUrl: treatment.source_url, decidedAtJurisdiction: treatment.decidedAtJurisdiction },
    stackedRatePercent: components.length ? stacked : null,
    rateComponents: components,
    effectiveTaxablePercent: components.length && treatment.taxable_fraction ? Math.round(stacked * Number(treatment.taxable_fraction) * 1e6) / 1e6 : undefined,
    note: "Published (verified) data only. Special-district components outside the parent chain are not yet resolved by address.",
  });
} else {
  out({ error: "usage: products classify|sync-profile|classify-check|lookup" });
  process.exit(2);
}
await client.end();
