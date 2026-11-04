// Shared helpers for the published-data export routes (B2). Hand-rolled CSV
// (RFC 4180 quoting) — no dependency. Text cells that start with a formula
// character are prefixed with an apostrophe so a spreadsheet never executes
// source-derived text.

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
export const safeSlug = (s: string | null): string | null => (s && SAFE_SLUG.test(s) ? s : null);

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function attachment(body: string, contentType: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "content-type": `${contentType}; charset=utf-8`,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

// JSON exports carry a meta block: publishedOnly is always true (only
// verified facts leave the database) and draft marks the client-facing
// DRAFT rule (028).
export function jsonExport(kind: string, scope: Record<string, unknown>, rows: unknown[], filename: string): Response {
  const body = JSON.stringify({
    meta: { kind, generatedAt: new Date().toISOString(), publishedOnly: true, draft: true, count: rows.length, ...scope },
    data: rows,
  }, null, 2);
  return attachment(body, "application/json", filename);
}
