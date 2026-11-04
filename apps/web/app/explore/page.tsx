"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LEVEL_LABEL, LEVEL_ORDER } from "../../lib/levels";
import { fmtDate, fmtRate } from "../../lib/format";

type JRow = { slug: string; name: string; level: string; parent_slug: string | null };
type TableRow = { table: string; purpose: string; tab: string | null; total: number; published: number | null };
type Ref = { slug: string; name: string; level: string };
type Prov = { status: string; citation: string | null; source_name?: string | null; source_url?: string | null; effective_from: string; effective_to: string | null };
type Detail = {
  jurisdiction: { slug: string; code: string | null; name: string; officialName: string | null; level: string; countryCode: string | null; currencyCode: string | null; timezone: string | null };
  ancestors: Ref[]; children: Ref[];
  taxTypes: { slug: string; name: string; category: string; administering_agency: string | null; official_url: string | null }[];
  rates: (Prov & { tax_type: string; tax_type_name: string; rate_value: string; rate_unit: string; applies_to: string | null; conditions: string | null })[];
  rules: (Prov & { tax_type: string; rule_type: string; authority_level: string; title: string; summary: string | null })[];
  licenses: (Prov & { tax_type: string; name: string; license_type: string; required_for: string | null; issuing_agency: string | null; application_url: string | null; form_number: string | null; fee_amount: string | null; fee_currency: string | null; renewal_period: string | null })[];
  compliance: (Prov & { tax_type: string; obligation_type: string; form_number: string | null; form_name: string | null; form_url: string | null; filing_frequency: string | null; due_date_rule: string | null; filing_methods: string | null; payment_methods: string | null; collect_remit_summary: string | null })[];
  geo: (Prov & { geo_kind: string; has_boundary: boolean; geometry_hash: string | null; simplification: string | null; precision: string; centroid_lat: string | null; centroid_lng: string | null })[];
  coverage: { question_key: string; status: string; answer: string | null }[];
  sources: { name: string; url: string; source_type: string; publisher: string | null; is_authoritative: boolean; eligibility: string; status: string; snapshot_at: string | null; snapshot_hash: string | null; last_checked_at: string | null }[];
  ledger: { question_key: string; tax_type: string | null; determination: string | null; status: string; snapshot_hash: string | null; invalidated_reason: string | null; validated_at: string | null }[];
  agentRuns: { id: string; role: string; model: string | null; unit: string | null; status: string; attempt: number; started_at: string | null; finished_at: string | null; created_at: string }[];
};

type Tab = "rates" | "rules" | "licenses" | "compliance" | "geo" | "sources" | "ledger";
const TABS: { key: Tab; label: string }[] = [
  { key: "rates", label: "Rates" }, { key: "rules", label: "Rules" }, { key: "licenses", label: "Licenses" },
  { key: "compliance", label: "Compliance" }, { key: "geo", label: "Geo boundary" },
  { key: "sources", label: "Sources & evidence" }, { key: "ledger", label: "Research ledger" },
];
const isTab = (v: string | null): v is Tab => TABS.some((t) => t.key === v);
const GROUP_CAP = 100;

function Status({ status }: { status: string }) {
  return status === "verified"
    ? <span className="pill approved">published</span>
    : <span className="pill verified" title="Not published — awaiting verification or review">unpublished · {status.replace(/_/g, " ")}</span>;
}
function Dates({ from, to }: { from: string; to: string | null }) {
  return <span title={`${from} → ${to ?? "open"}`}>{fmtDate(from)} – {to ? fmtDate(to) : "present"}</span>;
}
function Evidence({ p }: { p: { citation: string | null; source_name?: string | null; source_url?: string | null } }) {
  return (
    <span className="note">
      {p.citation ?? "no citation recorded"}
      {p.source_url && <> · <a href={p.source_url} target="_blank" rel="noreferrer">{p.source_name ?? "source"}</a></>}
    </span>
  );
}
const Empty = ({ why }: { why: string }) => <p className="note">{why}</p>;

export default function Explore() {
  const [index, setIndex] = useState<{ jurisdictions: JRow[]; tables: TableRow[] } | null>(null);
  const [indexErr, setIndexErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("rates");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [showUnpublished, setShowUnpublished] = useState(false);
  const [childFilter, setChildFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("slug")) setSlug(q.get("slug"));
    const t = q.get("tab");
    if (isTab(t)) setTab(t);
    fetch("/api/explore/overview").then(async (r) => {
      if (!r.ok) throw new Error(`overview ${r.status}`);
      setIndex((await r.json()) as { jurisdictions: JRow[]; tables: TableRow[] });
    }).catch((e) => setIndexErr(String(e)));
  }, []);

  useEffect(() => {
    if (!slug) { setDetail(null); return; }
    setDetailErr(null);
    setChildFilter("");
    let live = true;
    fetch(`/api/jurisdictions/detail?slug=${encodeURIComponent(slug)}`).then(async (r) => {
      const d = (await r.json()) as Detail & { error?: string };
      if (!live) return;
      if (!r.ok) { setDetail(null); setDetailErr(d.error ?? `detail ${r.status}`); } else setDetail(d);
    }).catch((e) => { if (live) setDetailErr(String(e)); });
    return () => { live = false; };
  }, [slug]);

  const go = useCallback((s: string | null, t?: Tab) => {
    setSlug(s);
    if (t) setTab(t);
    const q = new URLSearchParams();
    if (s) q.set("slug", s);
    if (t ?? tab) q.set("tab", (t ?? tab));
    window.history.replaceState(null, "", s ? `/explore?${q.toString()}` : "/explore");
  }, [tab]);

  const needle = search.trim().toLowerCase();
  const grouped = useMemo(() => {
    const g: Record<string, JRow[]> = {};
    for (const j of index?.jurisdictions ?? []) {
      if (needle && !j.name.toLowerCase().includes(needle) && !j.slug.toLowerCase().includes(needle)) continue;
      (g[j.level] ??= []).push(j);
    }
    return g;
  }, [index, needle]);
  const matchCount = Object.values(grouped).reduce((s, l) => s + l.length, 0);

  const vis = <T extends { status: string }>(rows: T[]) => (showUnpublished ? rows : rows.filter((r) => r.status === "verified"));
  const hidden = (rows: { status: string }[]) => rows.length - rows.filter((r) => r.status === "verified").length;
  const hiddenNote = (rows: { status: string }[]) => !showUnpublished && hidden(rows) > 0
    ? <p className="note">{hidden(rows)} unpublished row(s) hidden — tick “Include unpublished” to see them, labeled.</p> : null;

  const children = useMemo(() => {
    const f = childFilter.trim().toLowerCase();
    return (detail?.children ?? []).filter((c) => !f || c.name.toLowerCase().includes(f) || c.slug.includes(f));
  }, [detail, childFilter]);

  return (
    <main>
      {indexErr && <p className="err">Could not load the explorer index ({indexErr}). Is the database up?</p>}
      <div className="wrap">
        <section className="panel" data-testid="explorer-detail">
          {!slug && <ModelOverview tables={index?.tables ?? null} onOpen={(tab) => { if (tab) setTab(tab as Tab); }} />}
          {slug && detailErr && <p className="err">{detailErr}</p>}
          {slug && !detail && !detailErr && <p className="note">Loading {slug}…</p>}
          {slug && detail && (
            <>
              <nav className="crumbs" aria-label="Ancestors">
                <a href="/explore" onClick={(e) => { e.preventDefault(); go(null); }}>All jurisdictions</a>
                {detail.ancestors.map((a) => (
                  <span key={a.slug}> / <a href={`/explore?slug=${a.slug}`} onClick={(e) => { e.preventDefault(); go(a.slug); }}>{a.name}</a></span>
                ))}
                <span> / <strong>{detail.jurisdiction.name}</strong></span>
              </nav>
              <h1 className="detail-title">{detail.jurisdiction.name}</h1>
              <p className="note">
                {slugLevel(detail.jurisdiction.level)} · <code>{detail.jurisdiction.slug}</code>
                {detail.jurisdiction.code && <> · code {detail.jurisdiction.code}</>}
                {detail.jurisdiction.timezone && <> · {detail.jurisdiction.timezone}</>}
                {detail.jurisdiction.currencyCode && <> · {detail.jurisdiction.currencyCode}</>}
              </p>
              <div className="actions" data-slot="detail-actions" />
              <div className="tabs" role="tablist">
                {TABS.map((t) => (
                  <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab${tab === t.key ? " on" : ""}`} onClick={() => go(slug, t.key)}>
                    {t.label}
                  </button>
                ))}
                <label className="note toggle"><input type="checkbox" checked={showUnpublished} onChange={(e) => setShowUnpublished(e.target.checked)} /> Include unpublished</label>
              </div>

              {tab === "rates" && (
                <div>
                  {vis(detail.rates).length === 0
                    ? <Empty why={detail.rates.length === 0 ? "This jurisdiction imposes no rate components in the database (it may only be a parent, or not yet populated)." : "No published rates yet."} />
                    : (
                      <table>
                        <thead><tr><th>Tax type</th><th>Rate</th><th>Applies to</th><th>Effective</th><th>Status</th><th>Evidence</th></tr></thead>
                        <tbody>
                          {vis(detail.rates).map((r, i) => (
                            <tr key={i}>
                              <td>{r.tax_type_name}<br /><span className="note">{r.tax_type}</span></td>
                              <td><strong>{fmtRate(r.rate_value, r.rate_unit)}</strong></td>
                              <td>{r.applies_to ?? "—"}{r.conditions && <><br /><span className="note">{r.conditions}</span></>}</td>
                              <td><Dates from={r.effective_from} to={r.effective_to} /></td>
                              <td><Status status={r.status} /></td>
                              <td><Evidence p={r} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  {hiddenNote(detail.rates)}
                  {detail.taxTypes.length > 0 && (
                    <>
                      <h2 className="sub">Tax types administered here</h2>
                      <ul className="plain">{detail.taxTypes.map((t) => <li key={t.slug}><strong>{t.name}</strong> <span className="note">{t.category.replace(/_/g, " ")} · {t.slug}{t.administering_agency ? ` · ${t.administering_agency}` : ""}</span></li>)}</ul>
                    </>
                  )}
                </div>
              )}

              {tab === "rules" && (
                vis(detail.rules).length === 0 ? <Empty why={detail.rules.length === 0 ? "No rules recorded for this jurisdiction's levies." : "No published rules yet."} /> : (
                  <div>
                    {vis(detail.rules).map((r, i) => (
                      <div key={i} className="fact">
                        <strong>{r.title}</strong> <span className="pill">{r.rule_type}</span> <Status status={r.status} />
                        <p style={{ margin: "4px 0" }}>{r.summary ?? <span className="note">no summary recorded</span>}</p>
                        <span className="note">{r.authority_level} · {r.tax_type} · <Dates from={r.effective_from} to={r.effective_to} /> · </span><Evidence p={r} />
                      </div>
                    ))}
                    {hiddenNote(detail.rules)}
                  </div>
                )
              )}

              {tab === "licenses" && (
                vis(detail.licenses).length === 0 ? <Empty why={detail.licenses.length === 0 ? "No licenses or permits recorded here." : "No published licenses yet."} /> : (
                  <div>
                    {vis(detail.licenses).map((l, i) => (
                      <div key={i} className="fact">
                        <strong>{l.name}</strong> <span className="pill">{l.license_type}</span> <Status status={l.status} />
                        <p style={{ margin: "4px 0" }}>{l.required_for ?? "—"}</p>
                        <span className="note">
                          {l.issuing_agency ?? "agency not recorded"}
                          {l.fee_amount && <> · fee {Number(l.fee_amount).toLocaleString(undefined, { style: "currency", currency: l.fee_currency ?? "USD" })}</>}
                          {l.renewal_period && <> · renewal {l.renewal_period}</>}
                          {l.application_url && <> · <a href={l.application_url} target="_blank" rel="noreferrer">application</a></>} · </span><Evidence p={l} />
                      </div>
                    ))}
                    {hiddenNote(detail.licenses)}
                  </div>
                )
              )}

              {tab === "compliance" && (
                vis(detail.compliance).length === 0 ? <Empty why={detail.compliance.length === 0 ? "No filing or payment obligations recorded here." : "No published obligations yet."} /> : (
                  <div>
                    {vis(detail.compliance).map((c, i) => (
                      <div key={i} className="fact">
                        <strong>{c.form_name ?? c.obligation_type}</strong> {c.form_number && <span className="pill">{c.form_number}</span>} <Status status={c.status} />
                        <p style={{ margin: "4px 0" }}>
                          {c.filing_frequency ?? "frequency not recorded"} · due: {c.due_date_rule ?? "not recorded"}
                        </p>
                        {c.collect_remit_summary && <p className="note" style={{ margin: "2px 0" }}>{c.collect_remit_summary}</p>}
                        <span className="note">file: {c.filing_methods ?? "not recorded"} · pay: {c.payment_methods ?? "not recorded"} · </span><Evidence p={c} />
                      </div>
                    ))}
                    {hiddenNote(detail.compliance)}
                  </div>
                )
              )}

              {tab === "geo" && (
                <div>
                  {detail.coverage.filter((c) => c.question_key === "has_published_boundary").map((c, i) => (
                    <p key={i} className="selected">
                      Boundary coverage: <strong>{c.status.replace(/_/g, " ")}</strong>
                      {c.status === "confirmed_absent" && " — no government-published boundary exists; none is hand-drawn."}
                      {c.answer && <> <span className="note">({c.answer})</span></>}
                    </p>
                  ))}
                  {vis(detail.geo).length === 0 ? <Empty why={detail.geo.length === 0 ? "No geo rows (centroid or boundary) recorded for this jurisdiction." : "No published geo yet."} /> : (
                    <table>
                      <thead><tr><th>Kind</th><th>Precision</th><th>Geometry hash</th><th>Effective</th><th>Status</th><th>Source</th></tr></thead>
                      <tbody>
                        {vis(detail.geo).map((g, i) => (
                          <tr key={i}>
                            <td>{g.has_boundary ? "boundary" : g.geo_kind}{g.centroid_lat && <><br /><span className="note">{g.centroid_lat}, {g.centroid_lng}</span></>}</td>
                            <td>{g.precision}{g.simplification && <><br /><span className="note">{g.simplification}</span></>}</td>
                            <td><code title={g.geometry_hash ?? ""}>{g.geometry_hash ? `${g.geometry_hash.slice(0, 14)}…` : "not recorded"}</code></td>
                            <td><Dates from={g.effective_from} to={g.effective_to} /></td>
                            <td><Status status={g.status} /></td>
                            <td><Evidence p={g} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {hiddenNote(detail.geo)}
                </div>
              )}

              {tab === "sources" && (
                detail.sources.length === 0 ? <Empty why="No sources are registered directly against this jurisdiction." /> : (
                  <table>
                    <thead><tr><th>Source</th><th>Type</th><th>Eligibility</th><th>Latest snapshot</th></tr></thead>
                    <tbody>
                      {detail.sources.map((s, i) => (
                        <tr key={i}>
                          <td><a href={s.url} target="_blank" rel="noreferrer">{s.name}</a><br /><span className="note">{s.publisher ?? "publisher not recorded"}</span></td>
                          <td>{s.source_type.replace(/_/g, " ")}{s.is_authoritative && <> <span className="pill approved">authoritative</span></>}</td>
                          <td>{s.eligibility.replace(/_/g, " ")}</td>
                          <td>{s.snapshot_at ? <><span title={s.snapshot_at}>{fmtDate(s.snapshot_at)}</span><br /><code title={s.snapshot_hash ?? ""}>{(s.snapshot_hash ?? "").slice(0, 12)}…</code></> : <span className="note">no snapshot yet</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {tab === "ledger" && (
                detail.ledger.length === 0 ? <Empty why="No research determinations recorded yet — this jurisdiction has not been researched by an agent." /> : (
                  <table>
                    <thead><tr><th>Question</th><th>Determination</th><th>Status</th><th>Snapshot</th></tr></thead>
                    <tbody>
                      {detail.ledger.map((l, i) => (
                        <tr key={i}>
                          <td><code>{l.question_key}</code>{l.tax_type && <><br /><span className="note">{l.tax_type}</span></>}</td>
                          <td>{l.determination ?? <span className="note">none recorded</span>}</td>
                          <td><span className={`pill ${l.status === "validated" ? "approved" : "verified"}`}>{l.status.replace(/_/g, " ")}</span>
                            {l.invalidated_reason && <><br /><span className="note">{l.invalidated_reason}</span></>}
                            {l.validated_at && <><br /><span className="note">{fmtDate(l.validated_at)}</span></>}</td>
                          <td>{l.snapshot_hash ? <code title={l.snapshot_hash}>{l.snapshot_hash.slice(0, 12)}…</code> : <span className="note">not recorded</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              <h2 className="sub">Children ({detail.children.length.toLocaleString()})</h2>
              {detail.children.length === 0 ? <Empty why="No child jurisdictions below this one." /> : (
                <>
                  {detail.children.length > 12 && <input className="child-filter" type="text" placeholder="Filter children…" value={childFilter} onChange={(e) => setChildFilter(e.target.value)} aria-label="Filter children" />}
                  <ul className="chips">
                    {children.slice(0, expanded.children ? undefined : 60).map((c) => (
                      <li key={c.slug}><a href={`/explore?slug=${c.slug}`} onClick={(e) => { e.preventDefault(); go(c.slug); }}>{c.name}</a> <span className="note">{c.level.replace(/_/g, " ")}</span></li>
                    ))}
                  </ul>
                  {children.length > 60 && !expanded.children && <button className="btn secondary" onClick={() => setExpanded((x) => ({ ...x, children: true }))}>Show all {children.length.toLocaleString()}</button>}
                  {children.length === 0 && <Empty why="No children match that filter." />}
                </>
              )}
            </>
          )}
        </section>

        <aside className="panel">
          <h2>Jurisdictions</h2>
          <input data-testid="explorer-search" className="child-filter" type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or slug…" aria-label="Search jurisdictions" />
          {!index && !indexErr && <p className="note">Loading…</p>}
          {index && <p className="note">{matchCount.toLocaleString()} of {index.jurisdictions.length.toLocaleString()} jurisdictions</p>}
          {index && matchCount === 0 && <Empty why={`No jurisdiction matches “${search}”. Try a name like Austin or a slug like us-tx.`} />}
          <div className="browse">
            {LEVEL_ORDER.filter((l) => grouped[l]?.length).map((l) => {
              const list = grouped[l]!;
              const isOpen = needle ? true : open[l];
              const shown = expanded[l] ? list : list.slice(0, GROUP_CAP);
              return (
                <div key={l} className="group">
                  <button className="group-head" onClick={() => setOpen((o) => ({ ...o, [l]: !o[l] }))} aria-expanded={!!isOpen}>
                    <span>{isOpen ? "▾" : "▸"} {LEVEL_LABEL[l]}</span><span className="note">{list.length.toLocaleString()}</span>
                  </button>
                  {isOpen && (
                    <ul className="plain">
                      {shown.map((j) => (
                        <li key={j.slug}><a className={j.slug === slug ? "cur" : ""} href={`/explore?slug=${j.slug}`} onClick={(e) => { e.preventDefault(); go(j.slug); }}>{j.name}</a></li>
                      ))}
                      {list.length > shown.length && <li><button className="btn secondary" onClick={() => setExpanded((x) => ({ ...x, [l]: true }))}>Show all {list.length.toLocaleString()} (search to narrow)</button></li>}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </main>
  );
}

const slugLevel = (l: string) => l.replace(/_/g, " ");

function ModelOverview({ tables, onOpen }: { tables: TableRow[] | null; onOpen: (tab: string | null) => void }) {
  return (
    <>
      <h2>Data model — every table, row counts, purpose</h2>
      <p className="note">Pick a jurisdiction on the right to walk its rates, rules, licenses, compliance, boundary, sources and research ledger. “Published” counts verified facts only.</p>
      {!tables ? <p className="note">Loading…</p> : (
        <table>
          <thead><tr><th>Table</th><th style={{ textAlign: "right" }}>Rows</th><th style={{ textAlign: "right" }}>Published</th><th>Purpose</th></tr></thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.table}>
                <td>{t.tab
                  ? <a href={`/explore?tab=${t.tab}`} onClick={() => onOpen(t.tab)} title={`Browse ${t.table} per jurisdiction (${t.tab} tab)`}><code>{t.table}</code></a>
                  : <code>{t.table}</code>}</td>
                <td style={{ textAlign: "right" }}>{t.total.toLocaleString()}</td>
                <td style={{ textAlign: "right" }}>{t.published === null ? <span className="note">n/a</span> : t.published.toLocaleString()}</td>
                <td>{t.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
