import { eq, sql } from "drizzle-orm";
import { client, db } from "./index.js";
import { jurisdictions, taxTypes } from "./schema.js";

/**
 * Canada structure seed (issue #46). Idempotent. Registers the 10 provinces
 * and 3 territories under `ca` and the ca tax-type register. STRUCTURE ONLY:
 * no sources (fetch issue owns discovery/snapshots) and no tax facts —
 * rates/rules arrive exclusively through the four-role proposal pipeline.
 * Capital coordinates are structure_only globe pins, never evidence.
 * Run after db:seed (needs the `ca` country row).
 */

const PROVINCES = [
  { slug: "ca-on", code: "CA-ON", name: "Ontario", capital: "Toronto", lat: 43.65107, lng: -79.347015 },
  { slug: "ca-qc", code: "CA-QC", name: "Quebec", capital: "Quebec City", lat: 46.8139, lng: -71.2082 },
  { slug: "ca-bc", code: "CA-BC", name: "British Columbia", capital: "Victoria", lat: 48.4284, lng: -123.3656 },
  { slug: "ca-ab", code: "CA-AB", name: "Alberta", capital: "Edmonton", lat: 53.5461, lng: -113.4938 },
  { slug: "ca-mb", code: "CA-MB", name: "Manitoba", capital: "Winnipeg", lat: 49.8951, lng: -97.1384 },
  { slug: "ca-sk", code: "CA-SK", name: "Saskatchewan", capital: "Regina", lat: 50.4452, lng: -104.6189 },
  { slug: "ca-ns", code: "CA-NS", name: "Nova Scotia", capital: "Halifax", lat: 44.6488, lng: -63.5752 },
  { slug: "ca-nb", code: "CA-NB", name: "New Brunswick", capital: "Fredericton", lat: 45.9636, lng: -66.6431 },
  { slug: "ca-nl", code: "CA-NL", name: "Newfoundland and Labrador", capital: "St. John's", lat: 47.5615, lng: -52.7126 },
  { slug: "ca-pe", code: "CA-PE", name: "Prince Edward Island", capital: "Charlottetown", lat: 46.2382, lng: -63.1311 },
  { slug: "ca-yt", code: "CA-YT", name: "Yukon", capital: "Whitehorse", lat: 60.7212, lng: -135.0568 },
  { slug: "ca-nt", code: "CA-NT", name: "Northwest Territories", capital: "Yellowknife", lat: 62.454, lng: -114.3718 },
  { slug: "ca-nu", code: "CA-NU", name: "Nunavut", capital: "Iqaluit", lat: 63.7467, lng: -68.517 },
] as const;

const CRA = "Canada Revenue Agency";

const TAX_TYPES = [
  {
    jurisdictionSlug: "ca", slug: "ca-gst-hst", name: "Goods and Services Tax / Harmonized Sales Tax",
    category: "vat_gst", agency: CRA,
    url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses.html",
    description: "Federal GST (5%) and harmonized HST in participating provinces; provincial rate components attach per province under this type, as Texas locals attach under us-tx-sales-use.",
  },
  {
    jurisdictionSlug: "ca", slug: "ca-federal-income-corporate", name: "Federal Corporate Income Tax",
    category: "income", agency: CRA,
    url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/corporations/corporation-income-tax.html",
    description: "Federal corporation income tax administered by the CRA.",
  },
  {
    jurisdictionSlug: "ca", slug: "ca-federal-income-individual", name: "Federal Personal Income Tax",
    category: "income", agency: CRA,
    url: "https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/personal-income-tax-rates.html",
    description: "Federal personal income tax administered by the CRA.",
  },
  {
    jurisdictionSlug: "ca", slug: "ca-payroll-cpp-ei", name: "Payroll — CPP / QPP and Employment Insurance",
    category: "payroll", agency: CRA,
    url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll.html",
    description: "Canada Pension Plan contributions and Employment Insurance premiums withheld/remitted by employers (QPP is Revenu Quebec administered).",
  },
  {
    jurisdictionSlug: "ca-qc", slug: "ca-qst", name: "Quebec Sales Tax (QST)",
    category: "vat_gst", agency: "Revenu Quebec",
    url: "https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/",
    description: "Quebec's own value-added sales tax, administered by Revenu Quebec alongside the GST.",
  },
  {
    jurisdictionSlug: "ca-bc", slug: "ca-bc-pst", name: "Provincial Sales Tax (British Columbia)",
    category: "sales_tax", agency: "British Columbia Ministry of Finance",
    url: "https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst",
    description: "BC retail sales tax on goods and specified services, separate from GST.",
  },
  {
    jurisdictionSlug: "ca-sk", slug: "ca-sk-pst", name: "Provincial Sales Tax (Saskatchewan)",
    category: "sales_tax", agency: "Saskatchewan Ministry of Finance",
    url: "https://www.saskatchewan.ca/business/taxes-licensing-and-reporting/provincial-taxes-policies-and-bulletins/provincial-sales-tax",
    description: "Saskatchewan retail sales tax, separate from GST.",
  },
  {
    jurisdictionSlug: "ca-mb", slug: "ca-mb-rst", name: "Retail Sales Tax (Manitoba)",
    category: "sales_tax", agency: "Manitoba Finance — Taxation Division",
    url: "https://www.gov.mb.ca/finance/taxation/",
    description: "Manitoba retail sales tax, separate from GST.",
  },
] as const;

async function main() {
  const [ca] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "ca")).limit(1);
  if (!ca) throw new Error("ca jurisdiction missing; run db:seed/register-world first");

  // Lift the demo hold: Canada is now an active research scope (M9).
  await db.update(jurisdictions)
    .set({ datavalues: sql`${jurisdictions.datavalues} || '{"demoHeld": false}'::jsonb`, updatedAt: new Date() })
    .where(eq(jurisdictions.id, ca.id));

  const idBySlug = new Map<string, string>([["ca", ca.id]]);
  for (const p of PROVINCES) {
    const [row] = await db.insert(jurisdictions).values({
      parentId: ca.id, level: "state", slug: p.slug, code: p.code, name: p.name,
      countryCode: "CA", currencyCode: "CAD",
      datavalues: { lat: p.lat, lng: p.lng, capital: p.capital, skeletonOnly: true, structureOnly: true },
    }).onConflictDoUpdate({
      target: jurisdictions.slug,
      set: { parentId: ca.id, code: p.code, name: p.name, updatedAt: new Date() },
    }).returning();
    if (!row) throw new Error(`jurisdiction upsert failed ${p.slug}`);
    idBySlug.set(p.slug, row.id);
  }

  for (const t of TAX_TYPES) {
    const jurisdictionId = idBySlug.get(t.jurisdictionSlug)!;
    await db.insert(taxTypes).values({
      jurisdictionId, slug: t.slug, name: t.name, category: t.category,
      description: t.description, administeringAgency: t.agency, officialUrl: t.url,
    }).onConflictDoUpdate({
      target: taxTypes.slug,
      set: { name: t.name, category: t.category, administeringAgency: t.agency, officialUrl: t.url, updatedAt: new Date() },
    });
  }

  console.log(JSON.stringify({
    seeded: { jurisdictions: PROVINCES.length, taxTypes: TAX_TYPES.length, parent: "ca", demoHeld: false },
    note: "Structure only — facts arrive via the proposal pipeline (fetch/decision/reviewer).",
  }, null, 2));
  await client.end();
}

await main();
