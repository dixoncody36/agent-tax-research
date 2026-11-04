// Display helpers shared by the read-only surfaces. Canonical values stay
// ISO / numeric strings; formatting happens at the edge (field sense 023).

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "not recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
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
