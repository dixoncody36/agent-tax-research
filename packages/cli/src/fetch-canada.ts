import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import {
  client, db, jurisdictions, sources, sourceSnapshots, taxTypes,
} from "@agent-tax-research/database";
import { DESCRIPTORS } from "./fetch-canada-sources.js";

// Canada fetch (issue #47): classify + snapshot the primary government
// sources every Canada determination will cite (descriptors:
// fetch-canada-sources.ts). Fetch role only — this script makes NO
// determinations. Sources upsert on url (Texas precedent); snapshots store
// the raw retrieved body + sha256, idempotent on content hash.
// Usage: tsx src/fetch-canada.ts --run-id <agent_run uuid> [--slugs ca-ab,ca-ns]
// (flag is --slugs, not --only: pnpm exec consumes --only.)

const execFileAsync = promisify(execFile);
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// Some .gc.ca/provincial hosts 403 Node's TLS fingerprint while serving
// the same public page to curl/browsers. Fallback is the same unauthenticated
// GET via curl.exe (Windows built-in; no new dependency), recorded on the
// snapshot as retrieval=curl-fallback-403.
async function curlFetch(url: string): Promise<string> {
  const { stdout } = await execFileAsync("curl.exe", [
    "-sL", "--fail-with-body", "--max-time", "45",
    "-A", BROWSER_UA, "-H", "accept-language: en-CA,en;q=0.9", url,
  ], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

const runIdx = process.argv.indexOf("--run-id");
const runId = runIdx >= 0 ? process.argv[runIdx + 1] : undefined;
if (!runId) throw new Error("usage: fetch-canada.ts --run-id <uuid> [--slugs a,b]");
const slugsIdx = process.argv.indexOf("--slugs");
// pnpm exec mangles "a,b,c" (observed: re-joined into one space-separated
// token) — collect non-flag tokens after --slugs, split on commas/spaces.
const only = slugsIdx >= 0
  ? new Set(process.argv.slice(slugsIdx + 1).filter((a) => !a.startsWith("--")).join(" ").split(/[,\s]+/).filter(Boolean))
  : null;
const descriptors = only ? DESCRIPTORS.filter((d) => only.has(d.jurisdictionSlug)) : DESCRIPTORS;
if (descriptors.length === 0) throw new Error(`--slugs matched no descriptors (argv: ${process.argv.slice(2).join(" ")})`);

async function idForSlug<T extends { id: string }>(
  rows: T[] | Promise<T[]>, label: string,
): Promise<string> {
  const [row] = await rows;
  if (!row) throw new Error(`missing ${label}`);
  return row.id;
}

let ok = 0;
let skipped = 0;
const failures: string[] = [];
for (const d of descriptors) {
  const jurisdictionId = await idForSlug(
    db.select().from(jurisdictions).where(eq(jurisdictions.slug, d.jurisdictionSlug)).limit(1),
    `jurisdiction ${d.jurisdictionSlug}`,
  );
  const taxTypeId = await idForSlug(
    db.select().from(taxTypes).where(eq(taxTypes.slug, d.taxTypeSlug)).limit(1),
    `tax type ${d.taxTypeSlug}`,
  );
  const [src] = await db.insert(sources).values({
    jurisdictionId, taxTypeId, name: d.name, url: d.url,
    sourceType: "agency_guidance", publisher: d.publisher, language: "en",
    isAuthoritative: true, monitorCadence: "weekly", checkMethod: "content_hash",
    status: "active", publisherType: "government", eligibility: "eligible",
    notes: d.notes,
  }).onConflictDoUpdate({
    target: sources.url,
    set: { taxTypeId, jurisdictionId, publisherType: "government", eligibility: "eligible", updatedAt: new Date() },
  }).returning();
  if (!src) throw new Error(`source upsert failed ${d.url}`);

  try {
    const res = await fetch(d.url, {
      headers: { "user-agent": BROWSER_UA, "accept-language": "en-CA,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(45_000),
    });
    let body = await res.text();
    let retrieval = "node-fetch";
    if (res.status === 403) {
      body = await curlFetch(d.url);
      retrieval = "curl-fallback-403";
    } else if (!res.ok) {
      failures.push(`${d.url} -> HTTP ${res.status}`);
      console.log(`FAIL ${d.jurisdictionSlug} ${d.url} -> HTTP ${res.status}`);
      continue;
    }
    // Legacy .aspx hosts answer 200 with a meta-refresh stub (observed:
    // novascotia.ca). Follow one refresh hop so the snapshot is the page.
    const refresh = body.length < 4000
      ? /<meta[^>]+http-equiv=["']?refresh["']?[^>]+url=([^"'>\s]+)/i.exec(body)
      : null;
    if (refresh) {
      const target = new URL(refresh[1]!, d.url).toString();
      console.log(`REFRESH ${d.jurisdictionSlug} ${d.url} -> ${target}`);
      body = retrieval === "node-fetch"
        ? await (await fetch(target, { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(45_000) })).text()
        : await curlFetch(target);
      retrieval += "+meta-refresh";
    }
    const hash = createHash("sha256").update(body, "utf8").digest("hex");
    const existingHashes = await db.select({ contentHash: sourceSnapshots.contentHash })
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.sourceId, src.id));
    if (existingHashes.some((r) => r.contentHash === hash)) {
      skipped += 1;
      console.log(`SKIP ${d.jurisdictionSlug} unchanged hash ${hash.slice(0, 12)}`);
    } else {
      await db.insert(sourceSnapshots).values({
        sourceId: src.id, contentHash: hash, retrievedText: body, fetchedByRunId: runId,
        datavalues: { retrieval },
      });
      console.log(`SNAP ${d.jurisdictionSlug} ${hash.slice(0, 12)} bytes=${body.length} via=${retrieval}`);
    }
    await db.update(sources)
      .set({ contentHash: hash, lastCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(sources.id, src.id));
    ok += 1;
  } catch (err) {
    failures.push(`${d.url} -> ${err instanceof Error ? err.message : String(err)}`);
    console.log(`FAIL ${d.jurisdictionSlug} ${d.url} -> ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(JSON.stringify({ descriptors: descriptors.length, ok, skipped, failures }, null, 2));
await client.end();
if (failures.length > 0) process.exit(1);
