import { client } from "@agent-tax-research/database";
import { levelRank } from "../../../../lib/levels";

export const dynamic = "force-dynamic";

// Explorer index (B1): every jurisdiction (slug/name/level/parent) for
// search + level-grouped browsing, plus a row count per data-model table.
// Table names come from this fixed list only (never from the request).
// "published" = verification_status 'verified' (facts), proposal status
// 'published', ledger 'validated'. `tab` is the explorer section the table
// is browsed through (null = no per-jurisdiction view).
const FACT = "verification_status = 'verified'";
const TABLES: { table: string; purpose: string; tab: string | null; published: string | null }[] = [
  { table: "jurisdictions", purpose: "The whole-world hierarchy: country → state → county → city → special district.", tab: null, published: null },
  { table: "jurisdiction_geo", purpose: "Effective-dated centroids and boundaries so a lat/long resolves to its jurisdictions.", tab: "geo", published: FACT },
  { table: "tax_types", purpose: "The hub: one row per levy as administered by a jurisdiction.", tab: "rates", published: null },
  { table: "tax_rates", purpose: "One row per imposing-jurisdiction rate component; a combined rate is their sum.", tab: "rates", published: FACT },
  { table: "tax_rules", purpose: "Everything that is not a rate: applicability, exemptions, thresholds, penalties.", tab: "rules", published: FACT },
  { table: "tax_licenses", purpose: "Permits, licenses and registrations a taxpayer needs to operate under a tax.", tab: "licenses", published: FACT },
  { table: "tax_compliance", purpose: "Collect and remit: forms, filing frequency, due dates, channels.", tab: "compliance", published: FACT },
  { table: "sources", purpose: "Every information source agents must check and monitor.", tab: "sources", published: null },
  { table: "source_snapshots", purpose: "Retrieved source content pinned by hash; append-only evidence.", tab: "sources", published: null },
  { table: "source_checks", purpose: "Append-only monitoring log of every agent visit to a source.", tab: "sources", published: null },
  { table: "research_ledger", purpose: "Validated determinations reused before any re-research.", tab: "ledger", published: "status = 'validated'" },
  { table: "coverage_questions", purpose: "The checklist an open jurisdiction is interrogated against.", tab: "geo", published: null },
  { table: "coverage_answers", purpose: "found / confirmed_absent / unknown per question, with evidence.", tab: "geo", published: null },
  { table: "proposals", purpose: "Agent-proposed fact bundles that pass reviewer and human gates.", tab: null, published: "status = 'published'" },
  { table: "proposal_items", purpose: "Individual cited facts inside a proposal, with reviewer verdicts.", tab: null, published: null },
  { table: "agent_runs", purpose: "Every agent run: role, model, unit, status, tokens, cost, handoff notes.", tab: "agents", published: null },
  { table: "run_events", purpose: "Event stream behind the live agent activity feed.", tab: "agents", published: null },
  { table: "scope_runs", purpose: "Compiled scope each research run was launched under.", tab: null, published: null },
  { table: "exceptions", purpose: "Typed failures and escalations raised instead of guessing.", tab: null, published: null },
  { table: "jurisdiction_context", purpose: "Versioned local-expert guidance injected into assignments.", tab: null, published: "status = 'active'" },
  { table: "tax_type_relationships", purpose: "How levies relate: conforms to, piggybacks on, deductible against.", tab: null, published: FACT },
  { table: "product_categories", purpose: "Coded taxonomy of goods and services the law distinguishes.", tab: null, published: null },
  { table: "product_tax_treatments", purpose: "Category × jurisdiction × tax type treatments (taxable, exempt, …).", tab: null, published: FACT },
  { table: "operator_products", purpose: "Operator products classified from recorded facts.", tab: null, published: "classification_status = 'approved'" },
];

export async function GET() {
  const jurisdictions = await client`
    SELECT j.slug, j.name, j.level::text AS level, p.slug AS parent_slug
    FROM jurisdictions j LEFT JOIN jurisdictions p ON p.id = j.parent_id`;
  jurisdictions.sort((a, b) => (levelRank(a.level) - levelRank(b.level)) || String(a.name).localeCompare(String(b.name)));

  const tables = await Promise.all(TABLES.map(async (t) => {
    const total = await client.unsafe(`SELECT count(*)::int AS n FROM ${t.table}`);
    const pub = t.published ? await client.unsafe(`SELECT count(*)::int AS n FROM ${t.table} WHERE ${t.published}`) : null;
    return { table: t.table, purpose: t.purpose, tab: t.tab, total: total[0]!.n as number, published: pub ? (pub[0]!.n as number) : null };
  }));
  return Response.json({ jurisdictions, tables });
}
