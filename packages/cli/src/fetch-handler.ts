import { and, eq, isNull, or } from "drizzle-orm";
import { db, exceptions, researchLedger, sourceSnapshots, sources } from "@agent-tax-research/database";
import { snapshotWindow, verbatimIn } from "./evidence.js";
import { extractJsonObject } from "./muse-loop-lib.js";
import { doFetch, type FetchBundle, type Source } from "./source-fetch.js";
import { HandlerError, registerHandler, type HandlerContext } from "./worker.js";

// Headless Fetch role (agents/fetch.md): snapshot the assignment's
// registered government sources and return an evidence bundle. Never judges
// truth. Eligibility is decided before any request: noted_only and
// prohibited sources are never fetched into context (AGENTS.md rule 1).

export type FetchPlan = { fetch: Source[]; skipped: { url: string; eligibility: string }[]; gated: Source[] };

export function planFetch(all: Source[]): FetchPlan {
  const plan: FetchPlan = { fetch: [], skipped: [], gated: [] };
  for (const s of all) {
    if (s.eligibility === "eligible") plan.fetch.push(s);
    else if (s.eligibility === "gov_login_gated") plan.gated.push(s);
    else plan.skipped.push({ url: s.url, eligibility: s.eligibility });
  }
  return plan;
}

export function failureType(b: Pick<FetchBundle, "httpStatus" | "error">): string {
  if (b.httpStatus === 401 || b.httpStatus === 403) return "blocked";
  if (b.httpStatus === 404 || b.httpStatus === 410) return "primary_not_found";
  return "transient";
}

const EXTRACT_WINDOW = 30_000;

export function buildExtractPrompt(taxType: string | null, jurisdiction: string | null, url: string, text: string): string {
  return [
    "You are the Fetch agent's extractor. You list raw candidate values; you never judge whether they are correct or complete.",
    `Assignment: jurisdiction ${jurisdiction ?? "?"}${taxType ? `, tax type ${taxType}` : ""}.`,
    "From the government source text below, list values relevant to the assignment: rates, thresholds, fees, effective dates, filing frequencies, statute citations.",
    "Every candidate must carry an excerpt copied VERBATIM from the text (at least a full clause) that contains the value. Candidates whose excerpt is not in the text are discarded.",
    'Reply with ONLY a JSON object: {"candidates": [{"label": "...", "value": "...", "excerpt": "..."}]}. Empty list if nothing relevant.',
    "",
    `Source: ${url}`,
    snapshotWindow(text, EXTRACT_WINDOW),
  ].join("\n");
}

export function keepVerbatimCandidates(raw: Record<string, unknown> | null, text: string) {
  const list = Array.isArray(raw?.candidates) ? (raw.candidates as unknown[]) : [];
  const kept: { label: string; value: string; excerpt: string }[] = [];
  let dropped = 0;
  for (const c of list) {
    const o = (c ?? {}) as Record<string, unknown>;
    if (typeof o.label === "string" && o.value !== undefined && verbatimIn(o.excerpt, text)) {
      kept.push({ label: o.label, value: String(o.value), excerpt: String(o.excerpt) });
    } else dropped += 1;
  }
  return { kept, dropped };
}

async function fetchRole(ctx: HandlerContext) {
  const { run, envelope } = ctx;
  if (!run.jurisdictionId) throw new HandlerError("structure_unknown", "fetch assignment has no jurisdiction");
  const all = await db.select().from(sources).where(and(
    eq(sources.jurisdictionId, run.jurisdictionId), eq(sources.status, "active"),
    run.taxTypeId ? or(eq(sources.taxTypeId, run.taxTypeId), isNull(sources.taxTypeId)) : undefined,
  ));
  const plan = planFetch(all);
  const exceptionBase = { scopeRunId: run.scopeRunId, agentRunId: run.id, jurisdictionId: run.jurisdictionId };
  for (const g of plan.gated) {
    await db.insert(exceptions).values({ ...exceptionBase, sourceId: g.id, exceptionType: "needs_human", severity: "high", detail: `government login-gated source not fetched: ${g.url}` });
  }
  if (plan.fetch.length === 0) {
    throw new HandlerError("primary_not_found", `no eligible registered sources for ${envelope.jurisdiction}${envelope.taxType ? `/${envelope.taxType}` : ""}; register government primaries (tax source classify) — discovery by search is out of scope`);
  }

  const snapshots: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];
  let invalidated = 0;
  for (const source of plan.fetch) {
    const b = await doFetch(source, run.id, { skipUnchanged: true });
    if (b.error || b.httpStatus === null || b.httpStatus >= 400) {
      const type = failureType(b);
      failures.push({ url: b.url, httpStatus: b.httpStatus, error: b.error, exceptionType: type });
      await db.insert(exceptions).values({ ...exceptionBase, sourceId: source.id, exceptionType: type, severity: "medium", detail: `fetch failed: ${b.url} -> ${b.error ?? `HTTP ${b.httpStatus}`}` });
      continue;
    }
    if (b.changed && b.previousHash) {
      // Flag, never reinterpret: validated work pinned to the old text reopens.
      const rows = await db.update(researchLedger)
        .set({ status: "invalidated", invalidatedReason: "source_changed", updatedAt: new Date() })
        .where(and(eq(researchLedger.jurisdictionId, run.jurisdictionId), eq(researchLedger.status, "validated"), eq(researchLedger.snapshotHash, b.previousHash)))
        .returning({ id: researchLedger.id });
      invalidated += rows.length;
    }
    await ctx.event("source_fetched", { url: b.url, snapshotId: b.snapshotId, changed: b.changed, reused: b.reusedSnapshot, httpStatus: b.httpStatus });
    snapshots.push({ sourceId: b.sourceId, url: b.url, snapshotId: b.snapshotId, contentHash: b.contentHash, changed: b.changed, firstSeen: b.firstSeen, reused: b.reusedSnapshot });
  }
  if (snapshots.length === 0) {
    throw new HandlerError(String(failures[0]?.exceptionType ?? "transient"), `all ${failures.length} eligible source fetches failed`);
  }

  const candidates: Record<string, unknown>[] = [];
  const extractionFailures: Record<string, unknown>[] = [];
  let droppedCandidates = 0;
  if (run.unit === "extract") {
    for (const s of snapshots) {
      const [snap] = await db.select().from(sourceSnapshots).where(eq(sourceSnapshots.id, String(s.snapshotId))).limit(1);
      if (!snap?.retrievedText) continue;
      // Snapshots are already stored; one failed extraction must not drop the bundle.
      try {
        const r = await ctx.call(buildExtractPrompt(envelope.taxType, envelope.jurisdiction, String(s.url), snap.retrievedText));
        const { kept, dropped } = keepVerbatimCandidates(extractJsonObject(r.content), snap.retrievedText);
        droppedCandidates += dropped;
        for (const k of kept) candidates.push({ ...k, snapshotId: snap.id, contentHash: snap.contentHash, url: s.url });
      } catch (e) {
        extractionFailures.push({ url: s.url, snapshotId: snap.id, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
      }
    }
  }

  const changed = snapshots.filter((s) => s.changed).length;
  const reused = snapshots.filter((s) => s.reused).length;
  const notes = [
    `Fetched ${snapshots.length}/${plan.fetch.length} eligible sources for ${envelope.jurisdiction}${envelope.taxType ? `/${envelope.taxType}` : ""}: ${changed} changed, ${reused} unchanged (snapshot reused).`,
    plan.skipped.length ? `Not fetched by rule (${plan.skipped.length}): ${plan.skipped.map((s) => `${s.url} [${s.eligibility}]`).join(", ")}.` : "",
    plan.gated.length ? `Login-gated, needs a human (${plan.gated.length}).` : "",
    failures.length ? `Failed (${failures.length}, exceptions raised): ${failures.map((f) => `${f.url} [${f.exceptionType}]`).join(", ")}.` : "",
    invalidated ? `Source changed: ${invalidated} validated ledger rows invalidated (source_changed) for targeted rework.` : "",
    run.unit === "extract" ? `Extracted ${candidates.length} verbatim-backed candidates (${droppedCandidates} dropped: excerpt not in snapshot).` : "",
    extractionFailures.length ? `Extraction failed on ${extractionFailures.length} snapshots (snapshots kept): ${String(extractionFailures[0]?.error)}.` : "",
  ].filter(Boolean).join(" ");
  return { notes, datavalues: { evidenceBundle: { snapshots, skipped: plan.skipped, failures, candidates, extractionFailures, ledgerInvalidated: invalidated } } };
}

registerHandler("fetch", "*", fetchRole);
