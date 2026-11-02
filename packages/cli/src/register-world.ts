import { eq } from "drizzle-orm";
import { client, db, jurisdictions } from "@agent-tax-research/database";

// World skeleton registration (issue #18): structure only — country
// jurisdictions with ISO codes + centroids (for the globe), EU as a
// region, and the 50 US states. NO tax facts are asserted here; tax
// data still requires eligible government primaries per AGENTS.md.
// Demo-reserved countries (mx, ca, ie per operator decision #31) are
// flagged demoHeld: structure rows exist, population is forbidden
// until the demo. Country list: REST Countries dataset (structure
// reference only, never tax evidence).
type WB = { iso2Code: string; name: string; region: { value: string }; capitalCity: string; latitude: string; longitude: string };
const held = new Set(["mx", "ca", "ie"]);
const euMembers = new Set(["at","be","bg","hr","cy","cz","dk","ee","fi","fr","de","gr","hu","ie","it","lv","lt","lu","mt","nl","pl","pt","ro","sk","si","es","se"]);
const res = await fetch("https://api.worldbank.org/v2/country/all?format=json&per_page=400");
if (!res.ok) throw new Error(`worldbank ${res.status}`);
const wb = (await res.json()) as [unknown, WB[]];
const countries = (wb[1] ?? []).filter((c) => c.region.value !== "Aggregates" && c.iso2Code && c.iso2Code.length === 2);

// EU region jurisdiction
let [eu] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "eu")).limit(1);
if (!eu) {
  [eu] = await db.insert(jurisdictions).values({ slug: "eu", level: "region", code: "EU", name: "European Union", datavalues: { kind: "supranational_region" } }).returning();
}
let registered = 0;
for (const c of countries) {
  const slug = c.iso2Code.toLowerCase();
  const [existing] = await db.select({ id: jurisdictions.id }).from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  if (existing) continue;
  await db.insert(jurisdictions).values({
    slug, level: "country", code: c.iso2Code, name: c.name, countryCode: c.iso2Code,
    datavalues: {
      region: c.region.value, capital: c.capitalCity || null,
      lat: c.latitude ? Number(c.latitude) : null, lng: c.longitude ? Number(c.longitude) : null,
      euMember: euMembers.has(slug), demoHeld: held.has(slug), skeletonOnly: true,
      structureSource: "World Bank Countries API (structure reference only)",
    },
  });
  registered += 1;
}
// US states (structure)
const states: [string, string][] = [["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["FL","Florida"],["GA","Georgia"],["HI","Hawaii"],["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],["ME","Maine"],["MD","Maryland"],["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],["MS","Mississippi"],["MO","Missouri"],["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],["NH","New Hampshire"],["NJ","New Jersey"],["NM","New Mexico"],["NY","New York"],["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],["OK","Oklahoma"],["OR","Oregon"],["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],["SD","South Dakota"],["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],["VA","Virginia"],["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"],["DC","District of Columbia"]];
const [us] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us")).limit(1);
let statesAdded = 0;
for (const [code, name] of states) {
  const slug = `us-${code.toLowerCase()}`;
  const [existing] = await db.select({ id: jurisdictions.id }).from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  if (existing) continue;
  await db.insert(jurisdictions).values({ slug, parentId: us!.id, level: "state", code: `US-${code}`, name, countryCode: "US", currencyCode: "USD", datavalues: { skeletonOnly: true } });
  statesAdded += 1;
}
console.log(`countries registered=${registered} (of ${countries.length} listed), us states added=${statesAdded}, eu region ready, demoHeld=mx,ca,ie`);
await client.end();
