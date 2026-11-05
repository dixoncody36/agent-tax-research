// Display helpers shared by the read-only surfaces. Canonical values stay
// ISO / numeric strings; formatting happens at the edge (field sense 023).

// Postgres timestamptz::text looks like "2026-11-04 13:39:16.833+00" — not
// ISO, and engines disagree on parsing it. Normalize before Date.parse.
export function parseTs(s: string): number {
  if (s.length <= 10) return Date.parse(`${s}T00:00:00`);
  return Date.parse(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = parseTs(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString();
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "not recorded";
  const t = parseTs(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

export function fmtRate(value: string | number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined) return "not recorded";
  const n = Number(value);
  const s = n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return !unit || unit === "percent" ? `${s}%` : `${s} ${unit.replace(/_/g, " ")}`;
}

export function fmtNum(n: number | string | null | undefined): string {
  return n === null || n === undefined ? "not recorded" : Number(n).toLocaleString();
}

export function fmtUsd(n: number | string | null | undefined): string {
  return n === null || n === undefined ? "not recorded" : Number(n).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
