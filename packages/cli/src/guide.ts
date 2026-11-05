import { mkdirSync, writeFileSync } from "node:fs";
import { client } from "@agent-tax-research/database";

// Jurisdiction tax guide generator (issue #25): renders a DRAFT markdown
// guide strictly from published data. Verified facts stand alone;
// anything still needs_review is quarantined in an appendix so a reader
// can never mistake unverified agent work for published fact. Coverage
// state (found / confirmed_absent / unknown) closes the guide so gaps
// are explicit, never silently absent.
// Usage: pnpm --filter @agent-tax-research/cli exec tsx src/guide.ts us-tx [outFile]
const slug = process.argv[2];
if (!slug) throw new Error("usage: guide.ts <jurisdiction-slug> [outFile]");
const outFile = process.argv[3] ?? `guides/${slug}-tax-guide.md`;

const [jur] = await client`SELECT * FROM jurisdictions WHERE slug = ${slug}`;
if (!jur) throw new Error(`jurisdiction ${slug} not found`);
const types = await client`
  SELECT * FROM tax_types WHERE jurisdiction_id = ${jur.id} ORDER BY category, name`;
const rates = await client`
  SELECT r.*, tt.slug AS type_slug, s.url AS source_url FROM tax_rates r
  JOIN tax_types tt ON tt.id = r.tax_type_id LEFT JOIN sources s ON s.id = r.source_id
  WHERE r.jurisdiction_id = ${jur.id} ORDER BY tt.name, r.effective_from`;
const rules = await client`
  SELECT r.*, tt.slug AS type_slug FROM tax_rules r JOIN tax_types tt ON tt.id = r.tax_type_id
  WHERE r.jurisdiction_id = ${jur.id} ORDER BY tt.name, r.title`;
const licenses = await client`
  SELECT l.*, tt.slug AS type_slug FROM tax_licenses l JOIN tax_types tt ON tt.id = l.tax_type_id
  WHERE l.jurisdiction_id = ${jur.id} ORDER BY tt.name, l.name`;
const compliance = await client`
  SELECT c.*, tt.slug AS type_slug FROM tax_compliance c JOIN tax_types tt ON tt.id = c.tax_type_id
  WHERE c.jurisdiction_id = ${jur.id} ORDER BY tt.name, c.form_number`;
const coverage = await client`
  SELECT status, count(*)::int AS n FROM coverage_answers WHERE jurisdiction_id = ${jur.id} GROUP BY status ORDER BY status`;
const pending = await client`
  SELECT status, count(*)::int AS n FROM proposals WHERE jurisdiction_id = ${jur.id} GROUP BY status ORDER BY status`;

const fmtRate = (r: { rate_value: unknown; rate_unit: string }) =>
  r.rate_unit === "percent" ? `${r.rate_value}%` : `${r.rate_value} ${r.rate_unit}`;
const byType = <T extends { type_slug: string }>(rows: T[]) => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.type_slug, [...(m.get(r.type_slug) ?? []), r]);
  return m;
};
const ratesBy = byType(rates as unknown as { type_slug: string }[]);
const rulesBy = byType(rules as unknown as { type_slug: string }[]);
const licBy = byType(licenses as unknown as { type_slug: string }[]);
const compBy = byType(compliance as unknown as { type_slug: string }[]);
const verified = <T extends { verification_status?: string }>(rows: T[] | undefined, want: boolean) =>
  (rows ?? []).filter((r) => (r.verification_status === "verified") === want);

const lines: string[] = [
  `<!-- DRAFT — generated from agent-tax-research published data on ${new Date().toISOString().slice(0, 10)}. Not tax advice. -->`,
  "",
  `# ${jur.name} — Tax Guide (DRAFT)`,
  "",
  `Jurisdiction: \`${slug}\` (${jur.level}) · Generated from published, human-approved facts only.`,
  `Unverified agent work is quarantined in the appendix and must not be relied on.`,
  "",
  "## Coverage state",
  "",
  coverage.length
    ? coverage.map((c) => `- ${c.status}: ${c.n}`).join("\n")
    : "- coverage not yet opened for this jurisdiction (all questions unknown)",
  "",
  `Proposals by status: ${pending.map((p) => `${p.status}=${p.n}`).join(" · ") || "none"}`,
  "",
];

let appendixCount = 0;
const appendix: string[] = [];
for (const t of types) {
  const vRates = verified(ratesBy.get(t.slug) as never, true) as typeof rates;
  const vRules = verified(rulesBy.get(t.slug) as never, true) as typeof rules;
  const vLic = verified(licBy.get(t.slug) as never, true) as typeof licenses;
  const vComp = verified(compBy.get(t.slug) as never, true) as typeof compliance;
  const uCount = [verified(ratesBy.get(t.slug) as never, false), verified(rulesBy.get(t.slug) as never, false), verified(licBy.get(t.slug) as never, false), verified(compBy.get(t.slug) as never, false)].reduce((a, b) => a + b.length, 0);
  appendixCount += uCount;
  lines.push(`## ${t.name}`, "");
  if (t.description) lines.push(String(t.description), "");
  if (t.administering_agency) lines.push(`Administered by: ${t.administering_agency}${t.official_url ? ` · ${t.official_url}` : ""}`, "");
  if (vRates.length) {
    lines.push("### Rates (verified)", "", "| Rate | Applies to | Effective | Citation |", "|---|---|---|---|");
    for (const r of vRates) lines.push(`| ${fmtRate(r as never)} | ${r.applies_to ?? ""} | ${r.effective_from ?? ""} | ${r.citation ?? ""} |`);
    lines.push("");
  }
  if (vRules.length) {
    lines.push("### Rules (verified)", "");
    for (const r of vRules) lines.push(`- **${r.title}** (${r.rule_type}): ${r.summary ?? ""} — ${r.citation ?? ""}`);
    lines.push("");
  }
  if (vLic.length) {
    lines.push("### Licenses & permits (verified)", "");
    for (const l of vLic) lines.push(`- **${l.name}**: required for ${l.required_for ?? ""}; issued by ${l.issuing_agency ?? ""}${l.application_url ? `; apply: ${l.application_url}` : ""}`);
    lines.push("");
  }
  if (vComp.length) {
    lines.push("### Filing & remittance (verified)", "");
    for (const c of vComp) lines.push(`- Form ${c.form_number ?? ""} ${c.form_name ?? ""}: ${c.filing_frequency ?? ""}, due ${c.due_date_rule ?? ""}. ${c.collect_remit_summary ?? ""}`);
    lines.push("");
  }
  if (!vRates.length && !vRules.length && !vLic.length && !vComp.length) {
    lines.push("_No verified facts published yet for this tax type._", "");
  }
  if (uCount) appendix.push(`- ${t.name}: ${uCount} unverified item(s) (needs_review) withheld from this guide body`);
}
lines.push("## Appendix — withheld unverified work", "",
  appendix.length ? appendix.join("\n") : "None — everything extracted for this jurisdiction has completed review.",
  "", `Total withheld items: ${appendixCount}. These complete only after independent agent review + final human approval.`,
  "", "---", "DRAFT — A&M Tax. Generated in-process from the agent-tax-research database; verify against primary sources before relying on any figure.");

mkdirSync(outFile.split("/").slice(0, -1).join("/") || ".", { recursive: true });
writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
console.log(JSON.stringify({ outFile, taxTypes: types.length, verifiedRates: rates.filter((r) => r.verification_status === "verified").length, withheldUnverified: appendixCount }));
await client.end();
