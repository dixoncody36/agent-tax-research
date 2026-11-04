"use client";
import { useCallback, useEffect, useState } from "react";
import Globe, { type GlobePoint } from "./Globe";

type Totals = { jurisdictions: number; tax_types: number; verified_rates: number; awaiting_human: number; snapshots: number; exceptions: number };
type EventRow = { created_at: string; level: string; message: string; role: string | null; jurisdiction: string | null };
type ExRow = { created_at: string; type: string; title: string };
type ResolveResult = {
  applicable: { slug: string; name: string; level: string }[];
  components: { slug: string; name: string; rateValue: number; rateUnit: string }[];
  combinedPercent: number; complete: boolean; unresolvedCount: number; reason: string | null;
  error?: string;
};

export default function Home() {
  const [points, setPoints] = useState<GlobePoint[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [exceptions, setExceptions] = useState<ExRow[]>([]);
  const [selected, setSelected] = useState<GlobePoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latIn, setLatIn] = useState("30.2672");
  const [lngIn, setLngIn] = useState("-97.7431");
  const [lookup, setLookup] = useState<ResolveResult | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);

  const runLookup = useCallback(async (lat: number, lng: number) => {
    setLookupBusy(true);
    try {
      const r = await fetch(`/api/geo/resolve?lat=${lat}&lng=${lng}&taxType=us-tx-sales-use`);
      setLookup((await r.json()) as ResolveResult);
    } catch (e) { setLookup({ applicable: [], components: [], combinedPercent: 0, complete: false, unresolvedCount: 0, reason: null, error: String(e) }); }
    setLookupBusy(false);
  }, []);
  const latNum = Number(latIn); const lngNum = Number(lngIn);
  const latOk = Number.isFinite(latNum) && latNum >= -90 && latNum <= 90;
  const lngOk = Number.isFinite(lngNum) && lngNum >= -180 && lngNum <= 180;

  const loadData = useCallback(async () => {
    try {
      const r = await fetch("/api/jurisdictions");
      if (!r.ok) throw new Error(`jurisdictions ${r.status}`);
      const d = (await r.json()) as { points: GlobePoint[]; totals: Totals };
      setPoints((prev) => prev ?? d.points);
      setTotals(d.totals);
    } catch (e) { setError(String(e)); }
  }, []);

  const loadFeed = useCallback(async () => {
    try {
      const r = await fetch("/api/activity");
      if (!r.ok) return;
      const d = (await r.json()) as { events: EventRow[]; exceptions: ExRow[] };
      setEvents(d.events); setExceptions(d.exceptions);
    } catch { /* feed is best-effort; globe keeps working */ }
  }, []);

  useEffect(() => {
    void loadData(); void loadFeed();
    const t = setInterval(() => { void loadData(); void loadFeed(); }, 5000);
    return () => clearInterval(t);
  }, [loadData, loadFeed]);

  return (
    <main>
      {error && <p className="err">Could not load data ({error}). Is the database up? <code>docker compose up -d</code></p>}
      {totals && (
        <div className="stats">
          <div className="stat"><b>{Number(totals.jurisdictions).toLocaleString()}</b><span>jurisdictions</span></div>
          <div className="stat"><b>{Number(totals.tax_types).toLocaleString()}</b><span>tax types</span></div>
          <div className="stat"><b>{Number(totals.verified_rates).toLocaleString()}</b><span>verified rates</span></div>
          <div className="stat"><b>{Number(totals.awaiting_human).toLocaleString()}</b><span>awaiting human</span></div>
          <div className="stat"><b>{Number(totals.snapshots).toLocaleString()}</b><span>source snapshots</span></div>
          <div className="stat"><b>{Number(totals.exceptions).toLocaleString()}</b><span>exceptions</span></div>
        </div>
      )}
      <div className="wrap">
        <section className="panel">
          <h2>World jurisdictions by verification status</h2>
          {points ? <Globe points={points} onSelect={setSelected} onPoint={(la, ln) => { setLatIn(String(la)); setLngIn(String(ln)); void runLookup(la, ln); }} /> : <p className="note">Loading globe…</p>}
          <div className="legend">
            <span><i className="dot" style={{ background: "#2ecc71" }} />verified data published</span>
            <span><i className="dot" style={{ background: "#0085ca" }} />populated (in review)</span>
            <span><i className="dot" style={{ background: "#f0b429" }} />held for live demo</span>
            <span><i className="dot" style={{ background: "#e05d5d" }} />blocked / exceptions</span>
            <span><i className="dot" style={{ background: "#7fa8c9" }} />skeleton only</span>
          </div>
          <p className="note">Drag to spin. Click a marker for detail. Markers sit at capital coordinates; color is the aggregate verification state of that jurisdiction subtree.</p>
          {selected && (
            <p className="selected">
              <strong>{selected.name}</strong> ({selected.slug}) — status <em>{selected.status}</em>, {selected.typeCount} tax types,
              {" "}{selected.publishedCount} published proposals, {selected.verifiedQueue} awaiting human approval.
            </p>
          )}
          <form data-testid="geo-lookup" className="lookup" onSubmit={(e) => { e.preventDefault(); if (latOk && lngOk) void runLookup(latNum, lngNum); }}>
            <strong>Point lookup — which jurisdictions tax here?</strong>
            <div className="lookup-row">
              <label className="field">Lat
                <input value={latIn} onChange={(e) => setLatIn(e.target.value)} inputMode="decimal" aria-invalid={!latOk} style={{ width: 120 }} />
              </label>
              <label className="field">Lng
                <input value={lngIn} onChange={(e) => setLngIn(e.target.value)} inputMode="decimal" aria-invalid={!lngOk} style={{ width: 130 }} />
              </label>
              <button className="btn" type="submit" disabled={!latOk || !lngOk || lookupBusy}>Resolve</button>
            </div>
            {!latOk && <span className="err">Latitude must be between -90 and 90. </span>}
            {!lngOk && <span className="err">Longitude must be between -180 and 180.</span>}
            <p className="note">Or click any point on the globe. Defaults to downtown Austin.</p>
          </form>
          <div data-testid="geo-result">
            {lookup?.error && <p className="err">{lookup.error}</p>}
            {lookup && !lookup.error && lookup.applicable.length > 0 && (
              <div>
                <ol className="result-list">
                  {lookup.applicable.map((a) => {
                    const comp = lookup.components.find((x) => x.slug === a.slug);
                    return <li key={a.slug}><strong>{a.name}</strong> ({a.level}){comp ? ` — ${comp.rateValue}%` : ""}</li>;
                  })}
                </ol>
                <p className="combined">Combined sales tax: <strong>{lookup.combinedPercent}%</strong>
                  {lookup.complete
                    ? <> — complete, every imposing jurisdiction boundary-tested.</>
                    : <> — <em>partial</em>: {lookup.unresolvedCount} imposing jurisdiction(s) have no published boundary yet, so this sum is a floor, not the final rate.</>}
                </p>
              </div>
            )}
            {lookup && !lookup.error && lookup.applicable.length === 0 && (
              <p className="note">{lookup.reason === "no_published_geo"
                ? "No published boundaries yet — Texas geo is verified and awaiting the human publish gate; this lights up on approval."
                : "Outside published boundary coverage for this point."}</p>
            )}
          </div>
        </section>
        <aside className="panel">
          <h2>Agent activity</h2>
          <div className="feed">
            {events.length === 0 && <div className="note">No run events yet — start a run with <code>pnpm tax scope start</code>.</div>}
            {events.map((e, i) => (
              <div key={i}>
                <time>{new Date(e.created_at).toLocaleTimeString()}</time>
                [{e.role ?? "system"}{e.jurisdiction ? ` · ${e.jurisdiction}` : ""}] {e.message}
              </div>
            ))}
          </div>
          <h2 className="sub">Latest exceptions</h2>
          <div className="feed" style={{ maxHeight: 200 }}>
            {exceptions.length === 0 && <div className="note">None.</div>}
            {exceptions.map((x, i) => <div key={i}><time>{new Date(x.created_at).toLocaleDateString()}</time>[{x.type}] {x.title}</div>)}
          </div>
        </aside>
      </div>
    </main>
  );
}
