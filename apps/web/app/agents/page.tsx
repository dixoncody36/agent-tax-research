"use client";
import { useEffect, useMemo, useState } from "react";
import { fmtDate, fmtDateTime, fmtNum, fmtUsd, parseTs } from "../../lib/format";

type Run = {
  id: string; role: string; model: string | null; unit: string | null; status: string; attempt: number;
  tokens_in: number | null; tokens_out: number | null; cost_usd: string | null;
  started_at: string | null; finished_at: string | null; created_at: string;
  jurisdiction_slug: string | null; jurisdiction_name: string | null; tax_type: string | null;
  provider: string | null; spec: string | null; error: string | null; harness: string | null;
  exception_type: string | null; exception_detail: string | null; retried: boolean;
};
type Facets = { roles: string[]; statuses: string[]; jurisdictions: { slug: string; name: string }[]; total: number };
type Detail = {
  run: Run & { handoff_notes: string | null; datavalues: Record<string, unknown>; scope_profile: string | null };
  proposals: { id: string; status: string; linked_as: string; jurisdiction_slug: string; tax_type: string | null; approved_by: string | null; created_at: string; item_count: number; verdicts: Record<string, number>; items: { table: string; verdict: string; citation: string | null; summary: string }[] }[];
  ledger: { question_key: string; tax_type: string | null; determination: string | null; status: string; snapshot_hash: string | null; invalidated_reason: string | null; validated_at: string | null }[];
  coverage: { question_key: string; status: string; answer: string | null }[];
  sources: { name: string; url: string; eligibility: string; snapshot_hash: string | null; snapshot_at: string | null }[];
  events: { event_type: string; detail: Record<string, unknown>; created_at: string }[];
};

const NR = <span className="note">not recorded</span>;
const when = (r: Run) => r.started_at ?? r.created_at;
const ms = (r: Run) => (r.started_at && r.finished_at ? parseTs(r.finished_at) - parseTs(r.started_at) : null);
const dur = (m: number | null) => (m === null ? null : m < 1000 ? "<1 s" : m < 60000 ? `${Math.round(m / 1000)} s` : `${Math.round(m / 60000)} min`);
const MAX_ATTEMPTS = 3;
const LIVE = new Set(["queued", "running"]);
// Direct model-API calls are not queue assignments: nothing to retry.
const ONE_OFF = new Set(["model-api", "model-loop"]);
const words = (s: string) => s.replace(/_/g, " ");

// One readable line per run event: what the agent did, in domain words.
function eventSummary(e: { event_type: string; detail: Record<string, unknown> }): string {
  const d = e.detail;
  switch (e.event_type) {
    case "claimed": return `claimed on ${String(d.provider)}:${String(d.model)} (attempt ${String(d.attempt)})`;
    case "model_call": return `model call ${String(d.model)}: ${fmtNum(Number(d.tokensIn))} in / ${fmtNum(Number(d.tokensOut))} out${d.costUsd === null ? ", cost not reported" : `, ${fmtUsd(String(d.costUsd))}`}`;
    case "source_fetched": return `fetched ${String(d.url)}${d.changed ? " (changed)" : d.reused ? " (unchanged)" : ""}`;
    case "proposal_filed": return `filed proposal with ${String(d.items)} answer(s) for review`;
    case "proposal_reviewed": return `reviewed proposal: ${String(d.passed)}/${String(d.items)} items pass`;
    case "completed": return "completed";
    case "failed": return `failed (${words(String(d.exceptionType ?? "error"))}): ${String(d.error ?? "")}`;
    case "loop_finished": return `loop finished: ${String(d.runs)} runs, ${String(d.stopReason)}`;
    default: return words(e.event_type);
  }
}

export default function Agents() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [role, setRole] = useState(""); const [jur, setJur] = useState(""); const [status, setStatus] = useState("");
  const [desc, setDesc] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);

  useEffect(() => { const r = new URLSearchParams(window.location.search).get("run"); if (r) setSel(r); }, []);

  // Glass box: while anything shown is queued or running, re-read the
  // persisted run state every 5 s so completion appears without a reload.
  const active = Boolean(runs?.some((r) => LIVE.has(r.status)) || (detail && LIVE.has(detail.run.status)));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, [active]);

  const retry = async (r: Run) => {
    setRetrying(r.id); setRetryMsg(null);
    try {
      const res = await fetch(`/api/agents/runs/${r.id}/retry`, { method: "POST" });
      const d = (await res.json()) as { error?: string; result?: { attempt?: number } };
      setRetryMsg(res.ok ? `Queued attempt ${d.result?.attempt ?? r.attempt + 1} of ${r.role} — a worker (tax work run) picks it up.` : `Retry refused: ${d.error ?? res.status}`);
    } catch (e) {
      setRetryMsg(`Retry failed: ${String(e)}`);
    } finally {
      setRetrying(null); setTick((x) => x + 1);
    }
  };

  useEffect(() => {
    const p = new URLSearchParams();
    if (role) p.set("role", role); if (jur) p.set("jurisdiction", jur); if (status) p.set("status", status);
    let live = true;
    fetch(`/api/agents/runs?${p.toString()}`).then(async (r) => {
      if (!r.ok) throw new Error(`runs ${r.status}`);
      const d = (await r.json()) as { runs: Run[]; facets: Facets };
      if (live) { setRuns(d.runs); setFacets(d.facets); setErr(null); }
    }).catch((e) => live && setErr(String(e)));
    return () => { live = false; };
  }, [role, jur, status, tick]);

  useEffect(() => {
    if (!sel) { setDetail(null); return; }
    let live = true;
    fetch(`/api/agents/runs/detail?id=${encodeURIComponent(sel)}`).then(async (r) => {
      const d = (await r.json()) as Detail & { error?: string };
      if (live) { if (r.ok) setDetail(d); else { setDetail(null); setErr(d.error ?? `detail ${r.status}`); } }
    }).catch((e) => live && setErr(String(e)));
    return () => { live = false; };
  }, [sel, tick]);

  // Sort on timestamp values (Date.parse), never on rendered strings.
  const sorted = useMemo(() => [...(runs ?? [])].sort((a, b) => (parseTs(when(a)) - parseTs(when(b))) * (desc ? -1 : 1)), [runs, desc]);
  const open = (id: string) => { setSel(id); window.history.replaceState(null, "", `/agents?run=${id}`); };

  return (
    <main>
      <div className="wrap">
        <section className="panel">
          <h1 className="page-title">Agent activity</h1>
          <p className="note">Every recorded agent run. Model, token and cost fields are sparse on early harness runs and show “not recorded” rather than a guess. Prompts are not stored anywhere today.</p>
          <div className="lookup-row">
            <label className="field">Role
              <select value={role} onChange={(e) => setRole(e.target.value)}><option value="">All roles</option>{(facets?.roles ?? []).map((r) => <option key={r}>{r}</option>)}</select>
            </label>
            <label className="field">Status
              <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{(facets?.statuses ?? []).map((s) => <option key={s}>{s}</option>)}</select>
            </label>
            <label className="field">Jurisdiction
              <select value={jur} onChange={(e) => setJur(e.target.value)}><option value="">All jurisdictions</option>{(facets?.jurisdictions ?? []).map((j) => <option key={j.slug} value={j.slug}>{j.name}</option>)}</select>
            </label>
            <span className="note">{runs ? `${runs.length.toLocaleString()} of ${(facets?.total ?? 0).toLocaleString()} runs` : "Loading…"}{active && " · live, refreshing every 5 s"}</span>
          </div>
          {err && <p className="err">{err}</p>}
          {retryMsg && <p className="note" role="status">{retryMsg}</p>}
          {runs && runs.length === 0 && <p className="note">No runs match these filters{facets && facets.total === 0 ? " — no agent run has been recorded yet; start one with pnpm tax scope start." : "."}</p>}
          {runs && runs.length > 0 && (
            <table data-testid="agents-table">
              <thead>
                <tr>
                  <th><button className="sort" onClick={() => setDesc((d) => !d)} aria-label="Toggle time sort">Started {desc ? "▼" : "▲"}</button></th>
                  <th>Role</th><th>Unit</th><th>Jurisdiction</th><th>Model</th><th>Status</th>
                  <th style={{ textAlign: "right" }}>Try</th><th style={{ textAlign: "right" }}>Tokens in / out</th><th style={{ textAlign: "right" }}>Cost</th><th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.id} className={r.id === sel ? "sel" : ""}>
                    <td><a href={`/agents?run=${r.id}`} onClick={(e) => { e.preventDefault(); open(r.id); }} title={when(r)}>{fmtDateTime(when(r))}</a></td>
                    <td>{r.role}</td>
                    <td>{r.unit ?? NR}</td>
                    <td>{r.jurisdiction_name ?? NR}{r.tax_type && <><br /><span className="note">{r.tax_type}</span></>}</td>
                    <td>{r.spec ?? r.model ?? NR}</td>
                    <td><span className={`pill ${r.status === "completed" ? "approved" : r.status === "failed" ? "bad" : "verified"}`}>{r.status}</span>
                      {r.status === "failed" && (
                        <>
                          <br /><span className="note" title={r.exception_detail ?? r.error ?? ""}>
                            {r.exception_type ? `${words(r.exception_type)}: ` : ""}{(r.exception_detail ?? r.error ?? "no reason recorded").slice(0, 140)}
                          </span>
                          {!ONE_OFF.has(r.harness ?? "") && <><br /><button className="btn secondary" data-testid="retry-run" disabled={r.attempt >= MAX_ATTEMPTS || r.retried || retrying === r.id}
                            title={r.attempt >= MAX_ATTEMPTS ? "Attempt cap reached: failed permanently, orchestrator notified" : r.retried ? "Already retried as the next attempt" : "Queue the next attempt"}
                            onClick={() => void retry(r)}>
                            {retrying === r.id ? "Retrying…" : r.attempt >= MAX_ATTEMPTS ? "Cap reached" : r.retried ? "Retried" : "Retry"}
                          </button></>}
                        </>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>{r.attempt}</td>
                    <td style={{ textAlign: "right" }}>{r.tokens_in === null && r.tokens_out === null ? NR : `${fmtNum(r.tokens_in)} / ${fmtNum(r.tokens_out)}`}</td>
                    <td style={{ textAlign: "right" }}>{r.cost_usd === null ? NR : fmtUsd(r.cost_usd)}</td>
                    <td>{dur(ms(r)) ?? NR}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <aside className="panel" data-testid="agent-run-detail">
          <h2>Run detail</h2>
          {!sel && <p className="note">Select a run to see its handoff notes, proposal linkage, ledger determinations and evidence.</p>}
          {sel && !detail && !err && <p className="note">Loading…</p>}
          {detail && (
            <div className="run-detail">
              <p><strong>{detail.run.role}</strong> · {detail.run.unit ?? "unit not recorded"} · attempt {detail.run.attempt}</p>
              <p className="note">
                {detail.run.jurisdiction_slug ? <a href={`/explore?slug=${detail.run.jurisdiction_slug}&tab=agents`}>{detail.run.jurisdiction_name}</a> : "no jurisdiction"}
                {" · "}model {detail.run.model ?? "not recorded"} · scope {detail.run.scope_profile ?? "not recorded"}<br />
                {fmtDateTime(when(detail.run))} → {detail.run.finished_at ? fmtDateTime(detail.run.finished_at) : "not finished / not recorded"}
              </p>

              <h2 className="sub">Handoff notes</h2>
              {detail.run.handoff_notes ? <pre className="notes">{detail.run.handoff_notes}</pre> : <p className="note">No handoff notes recorded for this run.</p>}

              <h2 className="sub">Proposals ({detail.proposals.length})</h2>
              {detail.proposals.length === 0 && <p className="note">This run is not linked to a proposal as extractor or verifier.</p>}
              {detail.proposals.map((p) => (
                <div key={p.id} className="fact">
                  <span className={`pill ${p.status === "published" || p.status === "approved" ? "approved" : "verified"}`}>{p.status}</span>{" "}
                  <strong>{p.jurisdiction_slug}</strong> {p.tax_type && <span className="note">{p.tax_type}</span>}
                  <br /><span className="note">linked as {p.linked_as} · {p.item_count.toLocaleString()} item(s) · verdicts {Object.entries(p.verdicts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}{p.approved_by ? ` · approved by ${p.approved_by}` : ""}</span>
                  {p.items.map((i, k) => <div key={k} className="note item">{i.table} · {i.verdict}{i.citation ? ` · ${i.citation}` : ""}<br /><code>{i.summary}</code></div>)}
                  {p.item_count > p.items.length && <div className="note">…and {(p.item_count - p.items.length).toLocaleString()} more item(s).</div>}
                </div>
              ))}

              <h2 className="sub">Ledger determinations ({detail.ledger.length})</h2>
              {detail.ledger.length === 0 && <p className="note">No research-ledger entries were validated by this run.</p>}
              {detail.ledger.map((l, k) => (
                <div key={k} className="fact">
                  <code>{l.question_key}</code> <span className={`pill ${l.status === "validated" ? "approved" : "verified"}`}>{l.status.replace(/_/g, " ")}</span>
                  <br />{l.determination ?? <span className="note">no determination text</span>}
                  <br /><span className="note">snapshot {l.snapshot_hash ? `${l.snapshot_hash.slice(0, 12)}…` : "not recorded"}{l.invalidated_reason ? ` · invalidated: ${l.invalidated_reason}` : ""}</span>
                </div>
              ))}
              {detail.coverage.length > 0 && (
                <>
                  <h2 className="sub">Coverage answers ({detail.coverage.length})</h2>
                  {detail.coverage.map((c, k) => <div key={k} className="note item"><code>{c.question_key}</code> · {c.status.replace(/_/g, " ")}{c.answer ? ` · ${c.answer}` : ""}</div>)}
                </>
              )}

              <h2 className="sub">Evidence sources ({detail.sources.length})</h2>
              {detail.sources.length === 0 && <p className="note">No sources are referenced by this run's proposals or snapshots.</p>}
              {detail.sources.map((s, k) => (
                <div key={k} className="item"><a href={s.url} target="_blank" rel="noreferrer">{s.name}</a> <span className="note">{s.eligibility.replace(/_/g, " ")}{s.snapshot_at ? ` · snapshot ${fmtDate(s.snapshot_at)}` : " · no snapshot"}</span></div>
              ))}

              {detail.events.length > 0 && (
                <>
                  <h2 className="sub">Activity ({detail.events.length})</h2>
                  {detail.events.map((e, k) => <div key={k} className="note item">{fmtDateTime(e.created_at)} · {eventSummary(e)}</div>)}
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
