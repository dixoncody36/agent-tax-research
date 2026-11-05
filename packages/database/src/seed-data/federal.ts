/**
 * US Federal seed data — first-wave federal profile (decree p4.t1).
 * Administered by the United States (country jurisdiction `us`).
 * Sources are federal primaries only: IRS and the US Code via
 * uscode.house.gov / govinfo. Rates seeded below in seed.ts carry
 * their IRC citations; snapshots are taken by Fetch at runtime.
 */
export const FED_AGENCY = "Internal Revenue Service";

export interface FederalTaxType {
  slug: string;
  name: string;
  category: string;
  officialUrl: string;
  description: string;
}

export const federalTaxTypes: FederalTaxType[] = [
  {
    slug: "us-federal-income-individual",
    name: "Federal Individual Income Tax",
    category: "income",
    officialUrl: "https://www.irs.gov/filing/individuals",
    description: "Graduated income tax on individuals under IRC Subtitle A Chapter 1; the conformity anchor for state income taxes.",
  },
  {
    slug: "us-federal-income-corporate",
    name: "Federal Corporate Income Tax",
    category: "income",
    officialUrl: "https://www.irs.gov/businesses/corporations",
    description: "Flat-rate income tax on corporations under IRC section 11.",
  },
  {
    slug: "us-federal-payroll-fica",
    name: "Federal Payroll Tax (FICA)",
    category: "payroll",
    officialUrl: "https://www.irs.gov/businesses/small-businesses-self-employed/understanding-employment-taxes",
    description: "Social Security and Medicare taxes on wages under IRC Chapter 21 (FICA), shared employer/employee.",
  },
  {
    slug: "us-federal-unemployment-futa",
    name: "Federal Unemployment Tax (FUTA)",
    category: "payroll",
    officialUrl: "https://www.irs.gov/businesses/small-businesses-self-employed/federal-unemployment-tax",
    description: "Employer-only unemployment tax under IRC Chapter 23 (FUTA), with credit for state unemployment taxes.",
  },
  {
    slug: "us-federal-excise",
    name: "Federal Excise Taxes",
    category: "excise",
    officialUrl: "https://www.irs.gov/businesses/small-businesses-self-employed/excise-tax",
    description: "Per-unit and ad valorem excise taxes under IRC Subtitle D (fuels, communications, air transportation, and others).",
  },
];
