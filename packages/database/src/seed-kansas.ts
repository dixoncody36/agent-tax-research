import { eq, sql } from "drizzle-orm";
import { client, db } from "./index.js";
import { jurisdictions, taxTypes } from "./schema.js";

/**
 * Kansas structure seed (issue #52). Idempotent. Seeds the us-ks tax-type
 * register and the state capital pin. STRUCTURE ONLY: no sources (fetch
 * issue owns discovery/snapshots) and no tax facts — rates/rules arrive
 * exclusively through the four-role proposal pipeline. County/city
 * structure registers later from Census lists (#55/#56, Texas pattern).
 * Run after db:seed (needs the `us` + `us-ks` rows).
 */

const KDOR = "Kansas Department of Revenue";

const TAX_TYPES = [
  {
    slug: "us-ks-sales-use", name: "Sales and Use Tax", category: "sales_tax",
    url: "https://www.ksrevenue.gov/sales.html",
    description: "State sales/use tax plus local (county/city/special district) components, which attach per jurisdiction under this type like Texas locals under us-tx-sales-use.",
  },
  {
    slug: "us-ks-income-corporate", name: "Corporate Income Tax", category: "income",
    url: "https://www.ksrevenue.gov/buscorporate.html",
    description: "Kansas corporate income tax administered by KDOR.",
  },
  {
    slug: "us-ks-income-individual", name: "Individual Income Tax", category: "income",
    url: "https://www.ksrevenue.gov/perstax.html",
    description: "Kansas individual income tax administered by KDOR.",
  },
  {
    slug: "us-ks-motor-fuels", name: "Motor Fuel Tax", category: "excise",
    url: "https://www.ksrevenue.gov/motorfuel.html",
    description: "Kansas motor fuel excise administered by KDOR (Motor Fuel Tax Section).",
  },
  {
    slug: "us-ks-tobacco", name: "Cigarette and Tobacco Products Tax", category: "excise",
    url: "https://www.ksrevenue.gov/cigtob.html",
    description: "Kansas cigarette and tobacco products excise administered by KDOR.",
  },
  {
    slug: "us-ks-property", name: "Property Tax (Statewide Levies)", category: "property",
    url: "https://www.ksrevenue.gov/pvd.html",
    description: "Kansas statewide mill levies (educational/institution building funds) within the county-administered property tax system; Property Valuation Division oversight. Local mill-levy depth is out of M10 scope.",
  },
] as const;

async function main() {
  const [ks] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-ks")).limit(1);
  if (!ks) throw new Error("us-ks jurisdiction missing; run db:seed/register-world first");

  // Capital pin for the globe (structure_only, never evidence).
  await db.update(jurisdictions)
    .set({
      datavalues: sql`${jurisdictions.datavalues} || '{"lat": 39.0473, "lng": -95.6752, "capital": "Topeka"}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(jurisdictions.id, ks.id));

  for (const t of TAX_TYPES) {
    await db.insert(taxTypes).values({
      jurisdictionId: ks.id, slug: t.slug, name: t.name, category: t.category,
      description: t.description, administeringAgency: KDOR, officialUrl: t.url,
    }).onConflictDoUpdate({
      target: taxTypes.slug,
      set: { name: t.name, category: t.category, administeringAgency: KDOR, officialUrl: t.url, updatedAt: new Date() },
    });
  }

  console.log(JSON.stringify({
    seeded: { taxTypes: TAX_TYPES.length, jurisdiction: "us-ks" },
    note: "Structure only — facts arrive via the proposal pipeline (fetch/decision/reviewer).",
  }, null, 2));
  await client.end();
}

await main();
