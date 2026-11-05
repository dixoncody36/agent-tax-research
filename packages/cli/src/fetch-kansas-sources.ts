// Kansas source descriptors (issue #53) — the classified primary
// government sources Kansas determinations may cite. Data module so the
// register invariants are unit-testable (fetch-kansas.test.ts).
// URLs verified live 2026-11. Traps recorded: ksrevenue.gov serves
// HTTP 200 with a "404 - Page Not Found" body for dead paths (sales.html);
// real tax-type paths are bustaxtypes*.html.
export type Descriptor = {
  jurisdictionSlug: string;
  taxTypeSlug: string;
  name: string;
  url: string;
  publisher: string;
  notes: string;
};

const KDOR = "Kansas Department of Revenue";

export const DESCRIPTORS: Descriptor[] = [
  {
    jurisdictionSlug: "us-ks", taxTypeSlug: "us-ks-sales-use", publisher: KDOR,
    name: "Sales and Use Tax — KDOR",
    url: "https://www.ksrevenue.gov/bustaxtypessales.html",
    notes: "State rate authority: \"Kansas imposes a 6.5 percent (effective July 1, 2015) state retailers' sales tax\". Pre-2015 state history not stated here (named gap).",
  },
  {
    jurisdictionSlug: "us-ks", taxTypeSlug: "us-ks-sales-use", publisher: KDOR,
    name: "Local Sales Tax Information — Quarterly Updates (Publication 1700 index) — KDOR",
    url: "https://www.ksrevenue.gov/salesratechanges.html",
    notes: "Index of quarterly Publication 1700 Excel files (all city/county/special jurisdiction rates + jurisdiction codes + effective dates). The #55 cascade parses the current file like the Texas Comptroller tables.",
  },
  {
    jurisdictionSlug: "us-ks", taxTypeSlug: "us-ks-income-corporate", publisher: KDOR,
    name: "Corporate Income Tax — KDOR",
    url: "https://www.ksrevenue.gov/bustaxtypescorp.html",
    notes: "Corporate income tax hub.",
  },
  {
    jurisdictionSlug: "us-ks", taxTypeSlug: "us-ks-income-individual", publisher: KDOR,
    name: "Personal Income Tax — KDOR",
    url: "https://www.ksrevenue.gov/perstaxtypes.html",
    notes: "Individual income tax hub.",
  },
  {
    jurisdictionSlug: "us-ks", taxTypeSlug: "us-ks-motor-fuels", publisher: KDOR,
    name: "Motor Fuel Tax — KDOR",
    url: "https://www.ksrevenue.gov/bustaxtypesmf.html",
    notes: "Motor fuel excise hub.",
  },
  {
    jurisdictionSlug: "us-ks", taxTypeSlug: "us-ks-tobacco", publisher: KDOR,
    name: "Cigarette and Tobacco Products Tax — KDOR",
    url: "https://www.ksrevenue.gov/bustaxtypescig.html",
    notes: "Cigarette/tobacco excise hub.",
  },
  {
    jurisdictionSlug: "us-ks", taxTypeSlug: "us-ks-property", publisher: KDOR,
    name: "Property Valuation Division — KDOR",
    url: "https://www.ksrevenue.gov/pvdindex.html",
    notes: "PVD oversight of the property tax system; statewide mill levies (local depth out of M10 scope).",
  },
  {
    jurisdictionSlug: "us-ks", taxTypeSlug: "us-ks-sales-use", publisher: "Kansas Data Access and Support Center (DASC)",
    name: "Kansas Geospatial Data Clearinghouse (DASC)",
    url: "https://www.kansasgis.org/",
    notes: "State GIS clearinghouse — geo cross-check only; boundary authority for #56 remains Census TIGERweb (Texas precedent).",
  },
];

// The us-ks tax-type register seeded by seed-kansas.ts (#52).
export const KS_TAX_TYPE_SLUGS = [
  "us-ks-sales-use", "us-ks-income-corporate", "us-ks-income-individual",
  "us-ks-motor-fuels", "us-ks-tobacco", "us-ks-property",
] as const;
