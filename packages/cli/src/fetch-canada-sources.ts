// Canada source descriptors (issue #47) — the classified primary
// government sources Canada determinations may cite. Data module so the
// register invariants are unit-testable (fetch-canada.test.ts): every
// province/territory covered, government hosts only, unique URLs.
// URLs verified live 2026-11 (see fetch-canada.ts run log / snapshots).
export type Descriptor = {
  jurisdictionSlug: string;
  taxTypeSlug: string;
  name: string;
  url: string;
  publisher: string;
  notes: string;
};

const CRA = "Canada Revenue Agency";

export const DESCRIPTORS: Descriptor[] = [
  {
    jurisdictionSlug: "ca", taxTypeSlug: "ca-gst-hst", publisher: CRA,
    name: "GST/HST — charge and collect: which rate — CRA",
    url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate.html",
    notes: "Rate authority for GST 5% and HST combined rates by province (CRA administers HST).",
  },
  {
    jurisdictionSlug: "ca", taxTypeSlug: "ca-gst-hst", publisher: CRA,
    name: "GST/HST — when to register and start charging — CRA",
    url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge.html",
    notes: "Small-supplier threshold / registration triggers (compliance issue).",
  },
  {
    jurisdictionSlug: "ca", taxTypeSlug: "ca-gst-hst", publisher: CRA,
    name: "GST/HST — place of supply — CRA",
    url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html",
    notes: "Place-of-supply rules selecting the provincial HST rate (compliance issue).",
  },
  {
    jurisdictionSlug: "ca-on", taxTypeSlug: "ca-gst-hst", publisher: "Ontario Ministry of Finance",
    name: "Harmonized Sales Tax (HST) — Ontario",
    url: "https://www.ontario.ca/document/harmonized-sales-tax-hst",
    notes: "Provincial confirmation of Ontario HST participation (CRA administers).",
  },
  {
    jurisdictionSlug: "ca-qc", taxTypeSlug: "ca-qst", publisher: "Revenu Quebec",
    name: "Collecting GST and QST — Revenu Quebec",
    url: "https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/collecting-gst-and-qst/",
    notes: "QST rate authority (9.975%, GST-excluded base since 2013).",
  },
  {
    jurisdictionSlug: "ca-bc", taxTypeSlug: "ca-bc-pst", publisher: "British Columbia Ministry of Finance",
    name: "Provincial sales tax (PST) — B.C. Government",
    url: "https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst",
    notes: "BC PST rate + registration landing.",
  },
  {
    jurisdictionSlug: "ca-ab", taxTypeSlug: "ca-gst-hst", publisher: "Alberta Tax and Revenue Administration",
    name: "Corporate income tax — Alberta Tax and Revenue Administration",
    url: "https://www.alberta.ca/corporate-income-tax",
    notes: "TRA program page. Alberta levies no provincial sales tax (GST-only per CRA rate table); TRA administers Alberta corporate income tax (AT1), fuel/tobacco/tourism levies — provincial income register depth is a follow-on issue.",
  },
  {
    jurisdictionSlug: "ca-sk", taxTypeSlug: "ca-sk-pst", publisher: "Government of Saskatchewan",
    name: "Provincial Sales Tax — Saskatchewan",
    url: "https://www.saskatchewan.ca/business/taxes-licensing-and-reporting/provincial-taxes-policies-and-bulletins/provincial-sales-tax",
    notes: "Saskatchewan PST landing.",
  },
  {
    jurisdictionSlug: "ca-mb", taxTypeSlug: "ca-mb-rst", publisher: "Manitoba Finance — Taxation Division",
    name: "Retail Sales Tax — Manitoba",
    url: "https://www.gov.mb.ca/finance/taxation/taxes/retail.html",
    notes: "Manitoba RST landing.",
  },
  {
    jurisdictionSlug: "ca-nb", taxTypeSlug: "ca-gst-hst", publisher: "Government of New Brunswick",
    name: "Taxes — Finance (New Brunswick)",
    url: "https://www2.gnb.ca/content/gnb/en/departments/finance/taxes.html",
    notes: "Provincial finance/taxes landing (HST administered by CRA).",
  },
  {
    jurisdictionSlug: "ca-ns", taxTypeSlug: "ca-gst-hst", publisher: "Government of Nova Scotia",
    name: "Taxation — Finance and Treasury Board (Nova Scotia)",
    url: "https://www.novascotia.ca/programs-and-services/taxation",
    notes: "Provincial taxation landing (HST administered by CRA). Older novascotia.ca/finance URLs are meta-refresh stubs pointing here — do not use them.",
  },
  {
    jurisdictionSlug: "ca-nl", taxTypeSlug: "ca-gst-hst", publisher: "Government of Newfoundland and Labrador",
    name: "Tax Programs — Finance (Newfoundland and Labrador)",
    url: "https://www.gov.nl.ca/fin/tax-programs-incentives/",
    notes: "Provincial tax programs landing (HST administered by CRA).",
  },
  {
    jurisdictionSlug: "ca-pe", taxTypeSlug: "ca-gst-hst", publisher: "Government of Prince Edward Island",
    name: "Taxes — Prince Edward Island",
    url: "https://www.princeedwardisland.ca/en/topic/taxes",
    notes: "Provincial taxes landing (HST administered by CRA).",
  },
  {
    jurisdictionSlug: "ca-yt", taxTypeSlug: "ca-gst-hst", publisher: "Government of Yukon",
    name: "Finance — Yukon",
    url: "https://yukon.ca/en/department-finance",
    notes: "Territorial finance landing — evidence base for no-territorial-sales-tax absence finding (#48).",
  },
  {
    jurisdictionSlug: "ca-nt", taxTypeSlug: "ca-gst-hst", publisher: "Government of the Northwest Territories",
    name: "Finance — Northwest Territories",
    url: "https://www.fin.gov.nt.ca/en",
    notes: "Territorial finance landing — absence-finding evidence base (#48).",
  },
  {
    jurisdictionSlug: "ca-nu", taxTypeSlug: "ca-gst-hst", publisher: "Government of Nunavut",
    name: "Finance — Nunavut",
    url: "https://www.gov.nu.ca/finance",
    notes: "Territorial finance landing — absence-finding evidence base (#48). Host 403s automated reads incl. curl (recorded 2026-11); classified anyway — GST-only position evidences from the CRA rate table.",
  },
];

// Every registered Canada jurisdiction must carry >= 1 classified source.
export const CA_JURISDICTION_SLUGS = [
  "ca", "ca-on", "ca-qc", "ca-bc", "ca-ab", "ca-mb", "ca-sk",
  "ca-ns", "ca-nb", "ca-nl", "ca-pe", "ca-yt", "ca-nt", "ca-nu",
] as const;

// The ca tax-type register seeded by seed-canada.ts (#46).
export const CA_TAX_TYPE_SLUGS = [
  "ca-gst-hst", "ca-federal-income-corporate", "ca-federal-income-individual",
  "ca-payroll-cpp-ei", "ca-qst", "ca-bc-pst", "ca-sk-pst", "ca-mb-rst",
] as const;
