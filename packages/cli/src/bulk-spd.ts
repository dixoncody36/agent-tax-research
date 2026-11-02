import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  client, db, jurisdictions, proposalItems, proposals, sources, sourceSnapshots, taxTypes,
} from "@agent-tax-research/database";

// Bulk special-purpose-district (SPD) + transit (MTA) registration from
// Comptroller rate-table snapshots (issue #17). Rows: name, 7-digit
// local code, local rate (decimal fraction), effective date, boundary
// type. Slugs are code-based (us-tx-spd-<code>) because district names
// collide and repeat; the cleaned display name rides along, raw text
// kept in datavalues. ponytail: parent is Texas; boundary type recorded
// but county/city parenting is a later refinement (same as cities v1).
// Usage: tsx src/bulk-spd.ts <snapshotTextFile> <sourceUrl> <spd|mta>
const [, , file, sourceUrl, kind] = process.argv;
if (!file || !sourceUrl || (kind !== "spd" && kind !== "mta")) throw new Error("usage: bulk-spd.ts <file> <sourceUrl> <spd|mta>");
const rawBuf = readFileSync(file);
const text = rawBuf.includes(0) ? rawBuf.toString("utf16le") : rawBuf.toString("utf8");
type Row = { name: string; code: string; ratePct: number; effective: string };
const byCode = new Map<string, Row>();
if (kind === "spd") {
  const re = /([A-Z][A-Za-z0-9'.&\- ]+?)\s+([56]\d{6})\s+(0\.\d{6})\s+(\d{2})\/(\d{2})\/(\d{2})/g;
  for (const m of text.matchAll(re)) {
    let name = m[1]!.trim().replace(/\s+/g, " ");
    // County prefix is separated by a diamond marker in most rows.
    const parts = name.split("&diams;");
    if (parts.length > 1) name = parts[parts.length - 1]!.trim();
    // Without the marker the county word is duplicated ("Baylor Baylor County...").
    name = name.replace(/^([A-Za-z'-]+) \1 /, "$1 ");
    if (name.length < 3 || /Local Code|Boundary/.test(name)) continue;
    const yy = Number(m[6]);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    const code = m[2]!;
    if (!byCode.has(code)) byCode.set(code, { name, code, ratePct: Number(m[3]) * 100, effective: `${year}-${m[4]}-${m[5]}` });
  }
} else {
  // Transit page is prose: "<Name> MTA|CTA|CTD Local code - 3178998 Rate - 1/2% (.005000) Effective - Jan. 1, 1986 Participating cities... <Next> MTA Local code - ..."
  // The name group over-captures the previous entry's participating-cities
  // list, so keep only the tail: text after the last sentence break, then
  // at most the last two words (all TX authority names are 1-2 words).
  const re = /([A-Za-z&.\- ]+?)\s+(MTA|CTA|CTD)\s+Local code\s*-\s*(\d{7})\s+Rate\s*-\s*[\d/% ]*\(\.(\d{6})\)\s+Effective\s*-\s*([A-Za-z]+\.?)\s+(\d{1,2}),\s*(\d{4})/g;
  const months: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  for (const m of text.matchAll(re)) {
    let seg = m[1]!.trim().replace(/\s+/g, " ");
    seg = seg.split(/\. |: /).pop()!.trim();
    const words = seg.split(" ").filter(Boolean);
    const tail = words.length > 2 ? words.slice(-2).join(" ") : seg;
    const name = `${tail} ${m[2]}`;
    const code = m[3]!;
    const mon = months[m[5]!.replace(".", "").slice(0, 3)] ?? "01";
    if (!byCode.has(code)) byCode.set(code, { name, code, ratePct: Number(`0.${m[4]}`) * 100, effective: `${m[7]}-${mon}-${m[6]!.padStart(2, "0")}` });
  }
}
const rows = [...byCode.values()];
console.log(`parsed unique ${kind} rows: ${rows.length}`);
const [tx] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-tx")).limit(1);
const [salesType] = await db.select().from(taxTypes).where(eq(taxTypes.slug, "us-tx-sales-use")).limit(1);
const [src] = await db.select().from(sources).where(eq(sources.url, sourceUrl)).limit(1);
const [snap] = src ? await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.sourceId, src.id)).limit(1) : [];
if (!tx || !salesType || !src || !snap) throw new Error("missing tx/type/source/snapshot");
let registered = 0;
for (const r of rows) {
  const slug = `us-tx-${kind}-${r.code}`;
  const [existing] = await db.select({ id: jurisdictions.id }).from(jurisdictions).where(eq(jurisdictions.slug, slug)).limit(1);
  if (!existing) {
    await db.insert(jurisdictions).values({
      slug, parentId: tx.id, level: "special_district", name: r.name, countryCode: "US",
      datavalues: { comptrollerLocalCode: r.code, districtKind: kind },
    });
    registered += 1;
  }
}
const [prop] = await db.insert(proposals).values({ jurisdictionId: tx.id, taxTypeId: salesType.id, status: "proposed" }).returning({ id: proposals.id });
for (const r of rows) {
  await db.insert(proposalItems).values({
    proposalId: prop!.id, targetTable: "tax_rates",
    payload: { rateValue: r.ratePct, rateUnit: "percent", jurisdictionSlug: `us-tx-${kind}-${r.code}`, effectiveFrom: r.effective, appliesTo: `${kind.toUpperCase()} sales/use tax component (${r.name}, Comptroller local code ${r.code})` },
    citation: `Texas Comptroller ${kind === "spd" ? "Special Purpose District" : "Transit (MTA)"} sales/use rate table snapshot`,
    sourceId: src.id, snapshotId: snap.id, verdict: "pending",
  });
}
console.log(`registered=${registered} proposal=${prop!.id} items=${rows.length}`);
await client.end();
