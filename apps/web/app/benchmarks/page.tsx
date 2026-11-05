"use client";
import { useEffect, useState } from "react";
import { fmtDate, fmtNum, fmtUsd } from "../../lib/format";

type Row = {
  role: string; model: string; harness: string | null; runs: number; completed: number; avg_attempts: string;
  runs_with_tokens: number; tokens_in: string; tokens_out: string; runs_with_cost: number; cost_usd: string | null;
  runs_with_wall: number; median_wall_s: number | null; proposals_extracted: number; proposals_verified: number;
};
type BResult = {
  file: string; generatedAt: string; harness: string | null; roleModels: Record<string, string>; suiteAverage: number | null;
  results: { taskId: string; pass: boolean; total: number | null; attempts: number | null; reason: string | null }[];
};
type Data = {
  leaderboard: Row[];
  benchmarks: { suite: { name: string; version: string; maxAttempts: number; taskCount: number; tasks: { id: string; jurisdiction: string; category: string; prompt: string }[] } | null; results: BResult[] };
};

const NR = <span className="note">not recorded</span>;
const pct = (n: number, d: number) => (d === 0 ? null : `${((n / d) * 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}%`);
const wall = (s: number | null) => (s === null ? null : s < 1 ? "<1 s" : s < 60 ? `${Math.round(s)} s` : `${(s / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} min`);
const ROLE_ORDER = ["orchestrator", "fetch", "decision", "reviewer"];

export default function Benchmarks() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/agents/leaderboard").then(async (r) => {
      if (!r.ok) throw new Error(`leaderboard ${r.status}`);
      setData((await r.json()) as Data);
    }).catch((e) => setErr(String(e)));
  }, []);

  const byRole = ROLE_ORDER.map((role) => ({ role, rows: (data?.leaderboard ?? []).filter((r) => r.role === role) })).filter((g) => g.rows.length);
  const suite = data?.benchmarks.suite;
  const real = data?.benchmarks.results ?? [];

  return (
    <main>
      <section className="panel">
        <h1 className="page-title">Benchmarks</h1>
        <p className="note">Which agent and harness researches best. The leaderboard is computed live from recorded runs; unrecorded fields stay “not recorded” and are never averaged in as zero.</p>
        {err && <p className="err">{err}</p>}
        {!data && !err && <p className="note">Loading…</p>}

        <h2 className="sub">Live leaderboard — by role and model</h2>
        {data && byRole.length === 0 && <p className="note">No agent runs recorded yet.</p>}
        {byRole.length > 0 && (
          <table data-testid="leaderboard-table">
            <thead>
              <tr>
                <th>Role</th><th>Model / harness</th><th style={{ textAlign: "right" }}>Runs</th><th style={{ textAlign: "right" }}>Completed</th>
                <th style={{ textAlign: "right" }}>Verified-proposal rate</th><th style={{ textAlign: "right" }}>Avg attempts</th>
                <th style={{ textAlign: "right" }}>Tokens in / out</th><th style={{ textAlign: "right" }}>Cost</th><th style={{ textAlign: "right" }}>Median wall time</th>
              </tr>
            </thead>
            <tbody>
              {byRole.flatMap((g) => g.rows.map((r, i) => (
                <tr key={`${r.role}|${r.model}|${r.harness}`}>
                  <td>{i === 0 ? <strong>{r.role}</strong> : ""}</td>
                  <td>{r.model === "not recorded" ? NR : r.model}{r.harness && <><br /><span className="note">{r.harness}</span></>}</td>
                  <td style={{ textAlign: "right" }}>{r.runs.toLocaleString()}</td>
                  <td style={{ textAlign: "right" }}>{pct(r.completed, r.runs)} <span className="note">({r.completed.toLocaleString()})</span></td>
                  <td style={{ textAlign: "right" }}>{r.proposals_extracted === 0 ? <span className="note">no proposals extracted</span> : <>{pct(r.proposals_verified, r.proposals_extracted)} <span className="note">({r.proposals_verified.toLocaleString()}/{r.proposals_extracted.toLocaleString()})</span></>}</td>
                  <td style={{ textAlign: "right" }}>{Number(r.avg_attempts).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td style={{ textAlign: "right" }}>{r.runs_with_tokens === 0 ? NR : <>{fmtNum(r.tokens_in)} / {fmtNum(r.tokens_out)}<br /><span className="note">{r.runs_with_tokens} of {r.runs} runs</span></>}</td>
                  <td style={{ textAlign: "right" }}>{r.cost_usd === null ? NR : <>{fmtUsd(r.cost_usd)}<br /><span className="note">{r.runs_with_cost} of {r.runs} runs</span></>}</td>
                  <td style={{ textAlign: "right" }}>{wall(r.median_wall_s) ?? NR}</td>
                </tr>
              )))}
            </tbody>
          </table>
        )}
        <p className="note">Verified-proposal rate = proposals extracted by runs in the group that reached verified, approved or published. Historical harness runs mostly recorded no model, so they group under “not recorded”.</p>

        <h2 className="sub">Benchmark suite{suite ? ` — ${suite.name} ${suite.version}` : ""}</h2>
        {data && !suite && <p className="note">Benchmark suite definition not found (benchmarks/v1/tasks.json).</p>}
        {suite && (
          <>
            <p className="note">{suite.taskCount} fixed tasks scored 0–100 on accuracy, citation validity, coverage and efficiency; max {suite.maxAttempts} attempts per task. Run the offline scorer with <code>node benchmarks/run.mjs</code>.</p>
            {real.length === 0 ? (
              <p className="selected">No recorded benchmark results yet. Results appear here when a scored run writes a <code>benchmarks/results*.json</code> file.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Task</th>
                    {real.map((r) => <th key={r.file}>{r.harness ?? "harness not recorded"}<br /><span className="note">{r.file} · {fmtDate(r.generatedAt)}</span></th>)}
                  </tr>
                </thead>
                <tbody>
                  {suite.tasks.map((t) => (
                    <tr key={t.id}>
                      <td><code>{t.id}</code><br /><span className="note">{t.jurisdiction} · {t.category.replace(/_/g, " ")}</span></td>
                      {real.map((r) => {
                        const x = r.results.find((y) => y.taskId === t.id);
                        return <td key={r.file}>{!x ? <span className="note">not run</span> : <><span className={`pill ${x.pass ? "approved" : "bad"}`}>{x.pass ? "pass" : "fail"}</span> <span className="note">{x.total === null ? "" : `${x.total}/100`}{x.reason ? ` · ${x.reason}` : ""}</span></>}</td>;
                      })}
                    </tr>
                  ))}
                  <tr>
                    <td><strong>Suite average</strong></td>
                    {real.map((r) => <td key={r.file}>{r.suiteAverage === null ? NR : `${r.suiteAverage}/100`}<br /><span className="note">{Object.entries(r.roleModels).map(([k, v]) => `${k}: ${v}`).join(" · ")}</span></td>)}
                  </tr>
                </tbody>
              </table>
            )}
            {real.length === 0 && (
              <table>
                <thead><tr><th>Task</th><th>Prompt</th></tr></thead>
                <tbody>
                  {suite.tasks.map((t) => <tr key={t.id}><td><code>{t.id}</code><br /><span className="note">{t.jurisdiction} · {t.category.replace(/_/g, " ")}</span></td><td>{t.prompt}</td></tr>)}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </main>
  );
}
