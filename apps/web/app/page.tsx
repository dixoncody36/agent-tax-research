"use client";
import { useCallback, useEffect, useState } from "react";
import Globe, { type GlobePoint } from "./Globe";

type Totals = { jurisdictions: number; tax_types: number; verified_rates: number; awaiting_human: number; snapshots: number; exceptions: number };
type EventRow = { created_at: string; level: string; message: string; role: string | null; jurisdiction: string | null };
type ExRow = { created_at: string; type: string; title: string };

export default function Home() {
  const [points, setPoints] = useState<GlobePoint[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [exceptions, setExceptions] = useState<ExRow[]>([]);
  const [selected, setSelected] = useState<GlobePoint | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <main style={{ padding: "16px 20px" }}>
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
      <div className="wrap" style={{ padding: 0 }}>
        <section className="panel">
          <h2>World jurisdictions by verification status</h2>
          {points ? <Globe points={points} onSelect={setSelected} /> : <p className="note">Loading globe…</p>}
          <div className="legend">
            <span><i className="dot" style={{ background: "#2ecc71" }} />verified data published</span>
            <span><i className="dot" style={{ background: "#0085ca" }} />populated (in review)</span>
            <span><i className="dot" style={{ background: "#f0b429" }} />held for live demo</span>
            <span><i className="dot" style={{ background: "#e05d5d" }} />blocked / exceptions</span>
            <span><i className="dot" style={{ background: "#3d5a7a" }} />skeleton only</span>
          </div>
          <p className="note">Drag to spin. Click a marker for detail. Markers sit at capital coordinates; color is the aggregate verification state of that jurisdiction subtree.</p>
          {selected && (
            <p>
              <strong>{selected.name}</strong> ({selected.slug}) — status <em>{selected.status}</em>, {selected.typeCount} tax types,
              {" "}{selected.publishedCount} published proposals, {selected.verifiedQueue} awaiting human approval.
            </p>
          )}
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
          <h2 style={{ marginTop: 16 }}>Latest exceptions</h2>
          <div className="feed" style={{ maxHeight: 200 }}>
            {exceptions.length === 0 && <div className="note">None.</div>}
            {exceptions.map((x, i) => <div key={i}><time>{new Date(x.created_at).toLocaleDateString()}</time>[{x.type}] {x.title}</div>)}
          </div>
        </aside>
      </div>
    </main>
  );
}
