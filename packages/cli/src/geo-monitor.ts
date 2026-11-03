import { eq } from "drizzle-orm";
import {
  client, db, exceptions, jurisdictionGeo, jurisdictions, proposalItems,
} from "@agent-tax-research/database";
import { cleanCityName } from "./city-slug.js";
import { fetchFeatures } from "./geo-ingest.js";
import { geometryHash, isGeometry } from "./geo-math.js";

// Geo boundary monitor (#41, M8 unit 8): re-fetch Census county geometry,
// compare per-jurisdiction geometry hashes against published/proposed
// rows, and flag ONLY the changed jurisdictions (targeted reopen per
// AGENTS rule 4 — never a blanket redo). Default is dry-run reporting;
// --write records one typed exception per changed jurisdiction.
// --simulate <slug> proves targeting: fakes one upstream change and
// shows exactly one invalidation candidate. Usage:
//   tsx src/geo-monitor.ts [--simulate us-tx-travis] [--write]
const simulateIdx = process.argv.indexOf("--simulate");
const simulateSlug = simulateIdx >= 0 ? process.argv[simulateIdx + 1] : undefined;
const write = process.argv.includes("--write");

const norm = (s: string) => cleanCityName(s).toLowerCase().replace(/\s+county$/, "").trim();
const counties = await db.select().from(jurisdictions).where(eq(jurisdictions.level, "county"));
const byName = new Map(counties.map((c) => [norm(c.name), c]));

const known = new Map<string, string>();
for (const r of await db.select({ slug: jurisdictions.slug, h: jurisdictionGeo.geometryHash })
  .from(jurisdictionGeo).innerJoin(jurisdictions, eq(jurisdictions.id, jurisdictionGeo.jurisdictionId))) {
  if (r.h) known.set(r.slug, r.h);
}
for (const pi of await db.select({ payload: proposalItems.payload }).from(proposalItems)
  .where(eq(proposalItems.targetTable, "jurisdiction_geo"))) {
  const p = pi.payload as Record<string, unknown>;
  if (typeof p.jurisdictionSlug === "string" && typeof p.geometryHash === "string") {
    known.set(p.jurisdictionSlug, p.geometryHash);
  }
}

const { features } = await fetchFeatures("county", "STATE='48'");
const changed: { slug: string; from: string; to: string }[] = [];
let compared = 0;
for (const f of features) {
  const base = String(f.properties?.BASENAME ?? "");
  const jur = byName.get(norm(base));
  if (!jur || !isGeometry(f.geometry)) continue;
  compared += 1;
  let live = geometryHash(f.geometry);
  if (simulateSlug && jur.slug === simulateSlug) live = "simulated-upstream-change";
  const prev = known.get(jur.slug);
  if (prev && prev !== live) changed.push({ slug: jur.slug, from: prev.slice(0, 12), to: live.slice(0, 12) });
}

console.log(JSON.stringify({
  compared, changedCount: changed.length, changed,
  mode: simulateSlug ? `simulate:${simulateSlug}` : (write ? "write" : "dry-run"),
  instruction: changed.length
    ? "Targeted re-ingest for listed jurisdictions only: pnpm tax geo ingest --jurisdiction <slug> (supersede path)."
    : "No upstream boundary changes; nothing reopened.",
}, null, 2));

if (write && !simulateSlug) {
  const [tx] = await db.select().from(jurisdictions).where(eq(jurisdictions.slug, "us-tx")).limit(1);
  for (const ch of changed) {
    const jur = counties.find((c) => c.slug === ch.slug);
    await db.insert(exceptions).values({
      jurisdictionId: jur?.id ?? tx!.id,
      exceptionType: "transient", severity: "medium", status: "open",
      detail: `geo monitor: boundary changed upstream for ${ch.slug} (hash ${ch.from} -> ${ch.to}); targeted re-ingest queued (source_changed)`,
    });
  }
  console.log(`exceptions written: ${changed.length}`);
}
await client.end();
