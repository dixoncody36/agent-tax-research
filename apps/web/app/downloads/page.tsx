"use client";
import { useState } from "react";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export default function Downloads() {
  const [jur, setJur] = useState("");
  const [tax, setTax] = useState("");
  const jurOk = jur === "" || SLUG.test(jur);
  const taxOk = tax === "" || SLUG.test(tax);
  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (jur && jurOk) p.set("jurisdiction", jur);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    return p.toString();
  };
  const scope = jur && jurOk ? jur : "all jurisdictions";

  return (
    <main>
      <section className="panel">
        <h1 className="page-title">Downloads</h1>
        <p className="note">
          Published data only — facts that passed the reviewer and human gates. Every export is stamped DRAFT in its metadata.
          CSV rows carry citation and source columns; JSON adds a <code>meta</code> block (generatedAt, publishedOnly, draft).
        </p>

        <div className="lookup">
          <strong>Scope</strong>
          <div className="lookup-row">
            <label className="field">Jurisdiction slug
              <input value={jur} onChange={(e) => setJur(e.target.value.trim().toLowerCase())} placeholder="e.g. us-tx (blank = all)" aria-invalid={!jurOk} style={{ width: 240 }} />
            </label>
            <label className="field">Tax type slug (rates only)
              <input value={tax} onChange={(e) => setTax(e.target.value.trim().toLowerCase())} placeholder="e.g. us-tx-sales-use" aria-invalid={!taxOk} style={{ width: 240 }} />
            </label>
          </div>
          {(!jurOk || !taxOk) && <span className="err">Slugs use lowercase letters, digits and hyphens only.</span>}
          <p className="note">Exact-slug match: <code>us-tx</code> exports Texas state rows, not its counties or cities. Currently exporting: <strong>{scope}</strong>.</p>
        </div>

        <h2 className="sub">Exports</h2>
        <table>
          <thead><tr><th>Dataset</th><th>Contents</th><th>Download</th></tr></thead>
          <tbody>
            <tr>
              <td><strong>Rates</strong></td>
              <td>Published, effective-dated rate components, newest first, with citation and source title/URL.</td>
              <td>
                <a className="btn link" data-testid="download-rates" href={`/api/export/rates?${qs({ taxType: taxOk ? tax : "", format: "csv" })}`}>CSV</a>{" "}
                <a className="btn secondary link" href={`/api/export/rates?${qs({ taxType: taxOk ? tax : "", format: "json" })}`}>JSON</a>
              </td>
            </tr>
            <tr>
              <td><strong>Rules</strong></td>
              <td>Published rules (applicability, exemptions, thresholds, penalties) with authority level and citation.</td>
              <td>
                <a className="btn link" data-testid="download-rules" href={`/api/export/rules?${qs({ format: "csv" })}`}>CSV</a>{" "}
                <a className="btn secondary link" href={`/api/export/rules?${qs({ format: "json" })}`}>JSON</a>
              </td>
            </tr>
            <tr>
              <td><strong>Geo boundaries</strong></td>
              <td>Published boundaries as a GeoJSON FeatureCollection with geometry hash and source. With no jurisdiction this is every published boundary and is large.</td>
              <td><a className="btn link" data-testid="download-geo" href={`/api/export/geo?${qs({})}`}>GeoJSON</a></td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  );
}
