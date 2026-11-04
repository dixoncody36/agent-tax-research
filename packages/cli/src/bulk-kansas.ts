import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  client, db, exceptions, jurisdictions, proposalItems, proposals,
  researchLedger, sources, sourceSnapshots, taxTypes,
} from "@agent-tax-research/database";
import { cleanCityName } from "./city-slug.js";
import {
  extractComponents, parsePub1700Rows, parseSharedStrings,
  percentFromMicro, unzipEntries,
} from "./pub1700.js";

// Kansas local sales tax cascade (issue #55) from KDOR Publication 1700
// (quarterly Excel: all city/county/special jurisdiction rates). Mirrors
// the Texas bulk pattern: Fetch snapshots the file (canonical parsed-rows
// JSON + file sha256), Decision registers structure + component-rate
// proposals (counties, cities, special districts, state-food 0%).
// City item appliesTo keeps "City sales/use tax component ... combined
// total shown X%" so the audit-pack tie-out machinery works unchanged.
// Usage: tsx src/bulk-kansas.ts --fetch-run <uuid> --decision-run <uuid>
//        [--file <pub1700-1026.xlsx URL|path>] [--dry-run]

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dryRun = process.argv.includes("--dry-run");
const fetchRunId = arg("--fetch-run");
const decisionRunId = arg("--decision-run");
if (!dryRun && (!fetchRunId || !decisionRunId)) {
  throw new Error("usage: bulk-kansas.ts --fetch-run <uuid> --decision-run <uuid> [--file url] [--dry-run]");
}
const FILE_URL = arg("--file") ?? "https://www.ksrevenue.gov/pdf/pub17001026.xlsx";
const QUARTER = "effective 2026-10-01";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const kebab = (s: string) =>
  cleanCityName(s).toLowerCase().replace(/['.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const res = await fetch(FILE_URL, { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(180_000) });
if (!res.ok) throw new Error(`Pub 1700 download HTTP ${res.status}`);
const xlsxBuf = Buffer.from(await res.arrayBuffer());
const fileSha256 = createHash("sha256").update(xlsxBuf).digest("hex");
const entries = unzipEntries(xlsxBuf);
const ssBuf = entries.get("xl/sharedStrings.xml");
const sheetBuf = entries.get("xl/worksheets/sheet2.xml");
if (!ssBuf || !sheetBuf) throw new Error("Pub 1700 workbook missing sharedStrings/sheet2");
const strings = parseSharedStrings(ssBuf.toString("utf8"));
const rows = parsePub1700Rows(sheetBuf.toString("utf8"), strings);
const comp = extractComponents(rows);

const levying = (m: Map<string, { micro: number | null }>) => [...m.values()].filter((v) => (v.micro ?? 0) > 0).length;
console.log(JSON.stringify({
  file: FILE_URL, fileSha256: fileSha256.slice(0, 16), rows: rows.length,
  counties: comp.counties.size, countiesLevying: levying(comp.counties),
  cities: comp.cities.size, citiesLevying: levying(comp.cities),
  specials: comp.specials.size, specialsLevying: levying(comp.specials),
  conflicts: comp.conflicts.slice(0, 10), conflictCount: comp.conflicts.length,
  stateFoodMicroSeen: [...new Set(rows.map((r) => r.stateFoodMicro))],
  stateMicroSeen: [...new Set(rows.map((r) => r.stateMicro))],
}, null, 2));

if (dryRun) { await client.end(); process.exit(0); }

const [ks] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-ks")).limit(1);
const [salesType] = await db.select().from(taxTypes).where(eq(taxTypes.slug, "us-ks-sales-use")).limit(1);
if (!ks || !salesType) throw new Error("us-ks or us-ks-sales-use missing");

// Source + snapshot (canonical parsed rows; raw file pinned by sha256).
let [src] = await db.select().from(sources).where(eq(sources.url, FILE_URL)).limit(1);
if (!src) {
  [src] = await db.insert(sources).values({
    jurisdictionId: ks.id, taxTypeId: salesType.id,
    name: `KDOR Publication 1700 — all city/county/special jurisdiction tax rates (${QUARTER})`,
    url: FILE_URL, sourceType: "dataset", publisher: "Kansas Department of Revenue",
    isAuthoritative: true, monitorCadence: "quarterly", checkMethod: "content_hash",
    status: "active", publisherType: "government", eligibility: "eligible",
    notes: "Quarterly local-rate authority for the #55 cascade. Indexed from salesratechanges.html (#53).",
  }).returning();
}
const snapshotText = JSON.stringify(rows);
const contentHash = createHash("sha256").update(snapshotText).digest("hex");
const [latestSnap] = await db.select().from(sourceSnapshots)
  .where(eq(sourceSnapshots.sourceId, src!.id)).orderBy(desc(sourceSnapshots.createdAt)).limit(1);
let snap = latestSnap;
if (latestSnap?.contentHash !== contentHash) {
  [snap] = await db.insert(sourceSnapshots).values({
    sourceId: src!.id, contentHash, retrievedText: snapshotText, fetchedByRunId: fetchRunId,
    datavalues: { fileUrl: FILE_URL, fileSha256, quarter: QUARTER, parsedRows: rows.length },
  }).returning();
}
if (!snap || !src) throw new Error("snapshot/source missing");

// Structure registration (idempotent by slug).
const countySlug = new Map<string, string>(); // code -> slug
for (const c of comp.counties.values()) {
  const slug = `us-ks-${kebab(c.name.replace(/\s+County$/, ""))}-county`;
  countySlug.set(c.code, slug);
  const [hit] = await db.select({ id: jurisdictions.id }).from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  if (!hit) {
    await db.insert(jurisdictions).values({
      slug, parentId: ks.id, level: "county", code: c.code, name: c.name, countryCode: "US",
      datavalues: { structureOnly: true, kdorJurisdictionCode: c.code, structureSource: "KDOR Publication 1700 (M10 #55)" },
    });
  }
}
const citySlug = new Map<string, string>(); // code -> slug
{
  const used = new Set<string>();
  for (const c of comp.cities.values()) {
    let slug = `us-ks-city-${kebab(c.name)}`;
    if (used.has(slug)) slug = `${slug}-${c.code.toLowerCase()}`;
    used.add(slug);
    citySlug.set(c.code, slug);
    const [hit] = await db.select({ id: jurisdictions.id }).from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
    if (!hit) {
      await db.insert(jurisdictions).values({
        slug, parentId: ks.id, level: "city", code: c.code, name: cleanCityName(c.name), countryCode: "US",
        datavalues: { structureOnly: true, kdorJurisdictionCode: c.code, structureSource: "KDOR Publication 1700 (M10 #55)" },
      });
    }
  }
}
const specialSlug = new Map<string, string>();
for (const spItem of comp.specials.values()) {
  const slug = `us-ks-spd-${spItem.code.toLowerCase()}`;
  specialSlug.set(spItem.code, slug);
  const [hit] = await db.select({ id: jurisdictions.id }).from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  if (!hit) {
    await db.insert(jurisdictions).values({
      slug, parentId: ks.id, level: "special_district", code: spItem.code,
      name: cleanCityName(spItem.name), countryCode: "US",
      datavalues: { structureOnly: true, kdorJurisdictionCode: spItem.code, addressRanges: spItem.addressRanges.slice(0, 20), structureSource: "KDOR Publication 1700 (M10 #55)" },
    });
  }
}

const CITATION = `KDOR Publication 1700 (${QUARTER}) snapshot ${contentHash.slice(0, 8)} — Sales Tax Rates sheet, component columns (county/city/combined special) with jurisdiction codes`;

async function makeProposal(
  plan: string,
  items: { jurisdictionSlug: string; rateValue: string; appliesTo: string; effectiveFrom: string }[],
  determination: string,
) {
  if (!items.length) { console.log(`EMPTY ${plan} — no proposal`); return null; }
  const existing = await db.select().from(proposals).where(eq(proposals.jurisdictionId, ks!.id));
  const dup = existing.find((p) => (p.datavalues as Record<string, unknown>)?.m10issue === 55
    && (p.datavalues as Record<string, unknown>)?.plan === plan && p.status !== "rejected");
  if (dup) { console.log(`EXISTS ${plan} proposal=${dup.id} status=${dup.status}`); return dup.id; }
  const [prop] = await db.insert(proposals).values({
    jurisdictionId: ks!.id, taxTypeId: salesType!.id, status: "proposed",
    extractorRunId: decisionRunId, datavalues: { m10issue: 55, plan, snapshotHash: contentHash },
  }).returning({ id: proposals.id });
  for (const it of items) {
    await db.insert(proposalItems).values({
      proposalId: prop!.id, targetTable: "tax_rates",
      payload: { rateValue: it.rateValue, rateUnit: "percent", jurisdictionSlug: it.jurisdictionSlug, appliesTo: it.appliesTo, effectiveFrom: it.effectiveFrom, effectiveTo: null },
      citation: CITATION, sourceId: src!.id, snapshotId: snap!.id, verdict: "pending",
    });
  }
  await db.insert(researchLedger).values({
    jurisdictionId: ks!.id, taxTypeId: salesType!.id, questionKey: "consumption_tax.rates",
    determination: `Rate(s) proposed ${prop!.id}: ${determination}`,
    status: "pending_review", snapshotHash: contentHash,
  });
  console.log(`PROPOSED ${plan} proposal=${prop!.id} items=${items.length}`);
  return prop!.id;
}

const pct = (micro: number) => percentFromMicro(micro);
await makeProposal("counties",
  [...comp.counties.values()].filter((c) => (c.micro ?? 0) > 0).map((c) => ({
    jurisdictionSlug: countySlug.get(c.code)!,
    rateValue: pct(c.micro ?? 0),
    appliesTo: `County sales/use tax component (${c.name}, KDOR jurisdiction code ${c.code}); combined total shown ${pct(c.totalMicro ?? 0)}%`,
    effectiveFrom: c.effectiveFrom || "2026-10-01",
  })),
  `County components for ${levying(comp.counties)} of ${comp.counties.size} counties from Pub 1700 (${QUARTER}).`);
await makeProposal("cities",
  [...comp.cities.values()].filter((c) => (c.micro ?? 0) > 0).map((c) => ({
    jurisdictionSlug: citySlug.get(c.code)!,
    rateValue: pct(c.micro ?? 0),
    appliesTo: `City sales/use tax component (${cleanCityName(c.name)}, KDOR jurisdiction code ${c.code}); table combined total shown ${pct(c.totalMicro ?? 0)}%`,
    effectiveFrom: c.effectiveFrom || "2026-10-01",
  })),
  `City components for ${levying(comp.cities)} levying cities (${comp.cities.size} coded places registered as structure) from Pub 1700 (${QUARTER}).`);
await makeProposal("specials",
  [...comp.specials.values()].filter((c) => (c.micro ?? 0) > 0).map((c) => ({
    jurisdictionSlug: specialSlug.get(c.code)!,
    rateValue: pct(c.micro ?? 0),
    appliesTo: `Special district (CID/TDD/other) sales/use tax component (${cleanCityName(c.name)}, KDOR jurisdiction code ${c.code}); table combined total shown ${pct(c.totalMicro ?? 0)}%`,
    effectiveFrom: c.effectiveFrom || "2026-10-01",
  })),
  `Special-district components for ${levying(comp.specials)} districts from Pub 1700 (${QUARTER}); KDOR combined-special column used as published.`);
await makeProposal("state-food",
  [{
    jurisdictionSlug: "us-ks", rateValue: "0",
    appliesTo: "State sales tax on qualified food items — state component is 0% (Pub 1700 State Rate Food column); local (county/city/special) components still apply to food sales",
    effectiveFrom: "2026-10-01",
  }],
  "State food rate 0% per Pub 1700 State Rate Food column (all rows). EffectiveFrom = file quarter bound; the statutory phase-out dates (2023-2025) are not evidenced in the file — named gap.");

for (const c of comp.conflicts) {
  await db.insert(exceptions).values({
    jurisdictionId: ks.id, sourceId: src.id,
    exceptionType: "source_conflict", severity: "medium", status: "open",
    detail: `Pub 1700 component conflict: ${c} — first-seen value proposed; reviewer to adjudicate`,
  });
}
console.log(`conflicts recorded: ${comp.conflicts.length}`);
await client.end();
