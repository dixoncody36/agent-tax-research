"use client";
import { useState } from "react";
import { fmtDate } from "../../lib/format";
import { EXAMPLES, type AskResult } from "../../lib/askTypes";

export default function Ask() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AskResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/ask?q=${encodeURIComponent(question)}`);
      const d = (await r.json()) as AskResult & { error?: string };
      if (!r.ok) { setErr(d.error ?? `ask ${r.status}`); setRes(null); } else setRes(d);
    } catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  const i = res?.interpretation;
  return (
    <main>
      <section className="panel">
        <h1 className="page-title">Ask <span className="pill">feasibility</span></h1>
        <p className="note">
          Answers come only from published, cited data, by deterministic parsing — no model is involved and no number is ever guessed.
          If a question is not understood, or the data is not published, the answer says so.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); void run(q); }} className="ask-form">
          <input data-testid="ask-input" className="child-filter" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. What is the sales tax rate in Austin?" aria-label="Your question" maxLength={300} />
          <button className="btn" type="submit" disabled={busy || !q.trim()}>{busy ? "Asking…" : "Ask"}</button>
        </form>
        <div className="chips" aria-label="Example questions">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="chip" onClick={() => { setQ(ex); void run(ex); }}>{ex}</button>
          ))}
        </div>
        {err && <p className="err">{err}</p>}

        {res && i && (
          <div data-testid="ask-answer" className="answer">
            <h2 className="sub">Interpretation</h2>
            <table className="kv">
              <tbody>
                <tr><th>Intent</th><td>{i.intent === "unknown" ? "not understood" : i.intent}</td></tr>
                <tr><th>Jurisdiction</th><td>{i.jurisdiction ? <a href={`/explore?slug=${i.jurisdiction.slug}`}>{i.jurisdiction.name}</a> : "—"}{i.jurisdiction && <span className="note"> {i.jurisdiction.level.replace(/_/g, " ")} · {i.jurisdiction.slug}</span>}</td></tr>
                <tr><th>Tax</th><td>{i.taxTypes.length ? i.taxTypes.slice(0, 4).map((t) => t.name).join("; ") + (i.taxTypes.length > 4 ? ` +${i.taxTypes.length - 4} more` : "") : "—"} {i.taxScope !== "none" && <span className="note">({i.taxScope === "specific" ? "named levy" : "category"})</span>}</td></tr>
                <tr><th>As of</th><td>{i.asOf}</td></tr>
                {i.coordinates && <tr><th>Point</th><td>{i.coordinates.lat}, {i.coordinates.lng}</td></tr>}
              </tbody>
            </table>
            {i.notes.map((n, k) => <p key={k} className="note">{n}</p>)}

            <h2 className="sub">Answer</h2>
            <p className="headline">{res.answer.headline}</p>
            {res.answer.flags.map((f, k) => <p key={k} className={`flag ${f.level}`}>{f.text}</p>)}
            {res.answer.rows.length > 0 && (
              <table>
                <tbody>
                  {res.answer.rows.map((r, k) => (
                    <tr key={k}><td>{r.label}</td><td><strong>{r.value}</strong></td><td className="note">{r.detail ?? ""}</td></tr>
                  ))}
                </tbody>
              </table>
            )}

            <h2 className="sub">Evidence</h2>
            {res.evidence.length === 0 ? <p className="note">No evidence links apply to this answer.</p> : (
              <ul className="plain">
                {res.evidence.map((e, k) => (
                  <li key={k}>
                    {e.url ? <a href={e.url} {...(e.url.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>{e.title}</a> : e.title}
                    <span className="note"> {e.citation ?? ""}{e.snapshotAt ? ` · snapshot ${fmtDate(e.snapshotAt)}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
