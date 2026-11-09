"use client";
import { useCallback, useEffect, useState } from "react";
import { approveDisabled, approveHint } from "./approveGate";

type Item = {
  target_table: string; citation: string; verdict: string; source_url: string | null;
  payload: {
    rateValue?: number; rateUnit?: string; jurisdictionSlug?: string; appliesTo?: string; summary?: string; ruleType?: string;
    centroidLat?: number; centroidLng?: number; geometryHash?: string; precision?: string;
    questionKey?: string; status?: string; answer?: string; excerpt?: string; snapshotHash?: string;
  };
};
type Proposal = {
  id: string; status: string; created_at: string; jurisdiction: string | null; tax_type: string | null;
  item_count: number; approved_by: string | null; items: Item[];
};

export default function Review() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/proposals");
    if (r.ok) setProposals(((await r.json()) as { proposals: Proposal[] }).proposals);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (id: string, action: "approve" | "publish") => {
    setBusy(id); setMsg(null);
    try {
    const r = await fetch(`/api/proposals/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, approvedBy: name }),
    });
    const d = (await r.json()) as { ok?: boolean; error?: string };
    setMsg(r.ok ? `${action} ok` : `failed: ${d.error ?? r.status}`);
    } catch (e) {
      setMsg(`failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
    await load();
  };

  return (
    <main>
      <section className="panel">
        <h2>Human review queue — you are the last gate</h2>
        <p className="note">
          Every item here was extracted by an agent from a snapshotted government primary source and passed an
          independent agent reviewer. Approving records your name as the human approver; publishing writes the
          verified facts. The database refuses self-approval and ineligible sources regardless of this page.
        </p>
        <div className="review-name">
          <label className="field">Your name (recorded as approver) *
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cody Dixon" autoFocus aria-required="true" />
          </label>
        </div>
        <p className="note" data-testid="approve-hint">{approveHint(name)}</p>
        {msg && <p className={msg.startsWith("failed") ? "err" : "note"}>{msg}</p>}
        <table>
          <thead><tr><th>Proposal</th><th>Facts (agent-extracted, reviewer-passed)</th><th>Status</th><th>Human action</th></tr></thead>
          <tbody>
            {proposals.length === 0 && <tr><td colSpan={4} className="note">Queue empty — nothing awaiting a human.</td></tr>}
            {proposals.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.jurisdiction ?? "?"}</strong><br />{p.tax_type ?? ""}
                  <br /><span className="note">{Number(p.item_count)} item(s) · {new Date(p.created_at).toLocaleDateString()}</span>
                  {p.approved_by && <><br /><span className="note">approved by {p.approved_by}</span></>}
                </td>
                <td>
                  {p.items.slice(0, 12).map((it, i) => (
                    <div key={i} className="fact">
                      {it.target_table === "coverage_answers"
                        ? <>
                            <code>{it.payload.questionKey}</code> — <strong>{it.payload.status?.replace("_", " ")}</strong>: {it.payload.answer}
                            {it.payload.excerpt && <blockquote className="excerpt">“{it.payload.excerpt}”</blockquote>}
                            {it.payload.snapshotHash && <span className="note">snapshot {it.payload.snapshotHash.slice(0, 12)}…</span>}
                          </>
                        : it.target_table === "tax_rates"
                        ? <>{it.payload.rateValue}{it.payload.rateUnit === "percent" ? "%" : ` ${it.payload.rateUnit ?? ""}`} — {it.payload.appliesTo}</>
                        : it.target_table === "jurisdiction_geo" ? <>Boundary for <strong>{it.payload.jurisdictionSlug}</strong> — centroid {it.payload.centroidLat}, {it.payload.centroidLng} · precision {it.payload.precision ?? "published"} · geometry {String(it.payload.geometryHash ?? "").slice(0, 12)}…</> : <>{it.payload.summary ?? it.payload.ruleType ?? "rule"}</>}
                      <br /><span className="note">{it.citation} · verdict {it.verdict}
                        {it.source_url && <> · <a href={it.source_url} target="_blank" rel="noreferrer">primary source</a></>}
                      </span>
                    </div>
                  ))}
                  {Number(p.item_count) > 12 && <span className="note">…and {Number(p.item_count) - 12} more items (bulk table import — review the source snapshot, not each row)</span>}
                </td>
                <td><span className={`pill ${p.status}`}>{p.status}</span></td>
                <td>
                  {p.status === "verified" && (
                    <button className="btn" disabled={approveDisabled(name, busy, p.id)} onClick={() => void act(p.id, "approve")}>Approve</button>
                  )}
                  {p.status === "approved" && (
                    <button className="btn secondary" disabled={busy === p.id} onClick={() => void act(p.id, "publish")}>Publish</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
