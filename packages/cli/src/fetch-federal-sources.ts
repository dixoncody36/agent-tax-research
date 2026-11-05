// US federal source descriptors (issue #16 conformity pack) — the
// classified IRS primary sources federal coverage determinations may
// cite. Data module mirror of fetch-kansas-sources.ts so register
// invariants stay unit-testable. URLs verified live at fetch time by
// fetch-federal.ts (FAIL lines name any dead path; irs.gov is the only
// host — vendor summaries are never evidence).
export type Descriptor = {
  jurisdictionSlug: string;
  taxTypeSlug: string;
  name: string;
  url: string;
  publisher: string;
  notes: string;
};

const IRS = "Internal Revenue Service";

export const DESCRIPTORS: Descriptor[] = [
  {
    jurisdictionSlug: "us", taxTypeSlug: "us-federal-income-individual", publisher: IRS,
    name: "Federal Individual Income Tax — IRS (filing hub)",
    url: "https://www.irs.gov/filing/individuals",
    notes: "Individual filing hub: existence + filing channel evidence.",
  },
  {
    jurisdictionSlug: "us", taxTypeSlug: "us-federal-income-individual", publisher: IRS,
    name: "Federal Income Tax Rates and Brackets — IRS",
    url: "https://www.irs.gov/filing/federal-income-tax-rates-and-brackets",
    notes: "Current-year individual brackets/rates (rates_brackets). Historical brackets need year-specific revenue procedures — named gap until snapshotted.",
  },
  {
    jurisdictionSlug: "us", taxTypeSlug: "us-federal-income-corporate", publisher: IRS,
    name: "Federal Corporate Income Tax — IRS (corporations hub)",
    url: "https://www.irs.gov/businesses/corporations",
    notes: "Corporation tax hub: existence, filing (Form 1120), starting-point evidence.",
  },
  {
    jurisdictionSlug: "us", taxTypeSlug: "us-federal-excise", publisher: IRS,
    name: "Federal Excise Taxes — IRS",
    url: "https://www.irs.gov/businesses/small-businesses-self-employed/excise-tax",
    notes: "Excise hub: levy existence + Form 720 family. Per-unit rate schedules live in Form 720 instructions — named gap until snapshotted.",
  },
  {
    jurisdictionSlug: "us", taxTypeSlug: "us-federal-income-corporate", publisher: IRS,
    name: "Businesses (federal business taxes index) — IRS",
    url: "https://www.irs.gov/businesses",
    notes: "Peer-existence evidence base: the federal business-tax index Decision searches for each peer category (sales_tax, property, occupancy, franchise_margin, gross_receipts, severance, fee). Absence findings must record the searches run against this index, never assert from silence alone.",
  },
  {
    jurisdictionSlug: "us", taxTypeSlug: "us-federal-excise", publisher: IRS,
    name: "Penalties — IRS",
    url: "https://www.irs.gov/payments/penalties",
    notes: "Penalty regime hub (failure-to-file/pay, accuracy, interest) — current penalties evidence; penalty HISTORY needs dated sources, still a named gap.",
  },
  {
    jurisdictionSlug: "us", taxTypeSlug: "us-federal-income-individual", publisher: IRS,
    name: "Credits and Deductions — IRS",
    url: "https://www.irs.gov/credits-and-deductions",
    notes: "Individual credits/deductions hub — exemptions_exclusions evidence base (families exist; per-credit parameters need topic pages).",
  },
];
