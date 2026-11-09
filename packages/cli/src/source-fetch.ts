import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, sourceChecks, sourceSnapshots, sources } from "@agent-tax-research/database";

// Fetch one registered source: snapshot its text (content hash + stripped
// text), log a source_check, and update the source's hash. Shared by
// `tax source fetch`, `tax monitor refresh`, and the headless Fetch handler.
// Callers enforce eligibility before calling — this never classifies.

export type Source = typeof sources.$inferSelect;
export type FetchBundle = Awaited<ReturnType<typeof doFetch>>;

export async function doFetch(source: Source, runId?: string, opts: { skipUnchanged?: boolean } = {}) {
  const started = Date.now();
  let httpStatus: number | null = null; let body = ""; let fetchError: string | null = null;
  try {
    const res = await fetch(source.url, {
      headers: { "user-agent": "agent-tax-research/0.1 (primary-source research; respectful rate)" },
      redirect: "follow", signal: AbortSignal.timeout(30_000),
    });
    httpStatus = res.status; body = await res.text();
  } catch (e: unknown) { fetchError = e instanceof Error ? e.message : String(e); }
  const hash = createHash("sha256").update(body).digest("hex");
  // Only a successful response says anything about the content: an outage
  // or error page must never read as a change.
  const ok = !fetchError && httpStatus !== null && httpStatus < 400;
  const changed = ok && source.contentHash !== null && source.contentHash !== hash;
  const firstSeen = ok && source.contentHash === null;
  let snapshotId: string | null = null;
  let reused = false;
  if (ok) {
    if (opts.skipUnchanged && !changed && !firstSeen) {
      const [last] = await db.select({ id: sourceSnapshots.id, contentHash: sourceSnapshots.contentHash }).from(sourceSnapshots)
        .where(eq(sourceSnapshots.sourceId, source.id)).orderBy(desc(sourceSnapshots.createdAt)).limit(1);
      if (last?.contentHash === hash) { snapshotId = last.id; reused = true; }
    }
    if (!reused) {
      const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200000);
      const [snap] = await db.insert(sourceSnapshots).values({ sourceId: source.id, contentHash: hash, retrievedText: text, fetchedByRunId: runId ?? null }).returning({ id: sourceSnapshots.id });
      snapshotId = snap?.id ?? null;
    }
    await db.update(sources).set({ contentHash: hash, lastCheckedAt: new Date(), ...(changed ? { lastChangedAt: new Date() } : {}), updatedAt: new Date() }).where(eq(sources.id, source.id));
  }
  await db.insert(sourceChecks).values({ sourceId: source.id, checkedBy: runId ?? "fetch-cli", httpStatus, contentHash: ok ? hash : null, changed, notes: fetchError ?? (!ok ? `HTTP ${httpStatus}` : firstSeen ? "first snapshot" : changed ? "content changed" : "unchanged") });
  return {
    sourceId: source.id, url: source.url, snapshotId, reusedSnapshot: reused, contentHash: ok ? hash : null,
    previousHash: source.contentHash, httpStatus, changed, firstSeen, bytes: body.length, wallMs: Date.now() - started,
    error: fetchError ?? (ok ? null : `HTTP ${httpStatus}`),
  };
}
