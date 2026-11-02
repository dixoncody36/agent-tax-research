/**
 * Texas seed data — Phase 1 example jurisdiction.
 *
 * Tax type list taken from the Texas Comptroller "Texas Taxes and Fees"
 * A-to-Z index (https://comptroller.texas.gov/taxes/a-to-z.php), fetched
 * 2026-11-01. Every entry becomes one `tax_types` row plus one monitored
 * `sources` row (its official landing page) for Phase 2 agents.
 *
 * Deep detail (rates/rules/licenses/compliance) is seeded only where it
 * was read from the official subpage in this phase — Sales and Use,
 * Franchise, and Hotel Occupancy. All other types are deliberate stubs:
 * Phase 2 agents populate them from their sources. Do not treat stub
 * absence as "no rate exists".
 */

export const TX_AGENCY = "Texas Comptroller of Public Accounts";
export const TX_BASE = "https://comptroller.texas.gov";

export interface TexasTaxType {
  slug: string;
  name: string;
  category: string;
  path: string;
}

export const texasTaxTypes: TexasTaxType[] = [
  { slug: "us-tx-911-fees", name: "9-1-1 Fees and Surcharge", category: "fee", path: "/taxes/911/" },
  { slug: "us-tx-automotive-oil-fee", name: "Automotive Oil Sales Fee", category: "fee", path: "/taxes/auto-oil/" },
  { slug: "us-tx-battery-fee", name: "Battery Sales Fee", category: "fee", path: "/taxes/battery/" },
  { slug: "us-tx-boat-motor", name: "Boat and Boat Motor Tax", category: "sales_tax", path: "/taxes/boat/" },
  { slug: "us-tx-cement-production", name: "Cement Production Tax", category: "excise", path: "/taxes/cement/" },
  { slug: "us-tx-coastal-protection", name: "Coastal Protection Fee", category: "fee", path: "/taxes/coastal/" },
  { slug: "us-tx-coin-operated-machines", name: "Coin-Operated Machines Tax", category: "excise", path: "/taxes/coin-op/" },
  { slug: "us-tx-crude-oil", name: "Crude Oil Tax", category: "severance", path: "/taxes/crude-oil/" },
  { slug: "us-tx-franchise", name: "Franchise Tax", category: "franchise_margin", path: "/taxes/franchise/" },
  { slug: "us-tx-hotel-occupancy", name: "Hotel Occupancy Tax", category: "occupancy", path: "/taxes/hotel/" },
  { slug: "us-tx-insurance", name: "Insurance Taxes, Assessments and Fees", category: "gross_receipts", path: "/taxes/insurance/" },
  { slug: "us-tx-loan-administration-fee", name: "Loan Administration Fee", category: "fee", path: "/taxes/loan/" },
  { slug: "us-tx-manufactured-housing", name: "Manufactured Housing Tax", category: "sales_tax", path: "/taxes/mfg-housing/" },
  { slug: "us-tx-misc-gross-receipts", name: "Miscellaneous Gross Receipts Tax", category: "gross_receipts", path: "/taxes/misc-gross-receipts/" },
  { slug: "us-tx-mixed-beverage", name: "Mixed Beverage Taxes", category: "excise", path: "/taxes/mixed-beverage/" },
  { slug: "us-tx-motor-fuels", name: "Motor Fuels, IFTA and Interstate Truckers Taxes", category: "excise", path: "/taxes/fuels/" },
  { slug: "us-tx-motor-vehicle", name: "Motor Vehicle Taxes and Surcharges", category: "sales_tax", path: "/taxes/motor-vehicle/" },
  { slug: "us-tx-natural-gas", name: "Natural Gas Tax", category: "severance", path: "/taxes/natural-gas/" },
  { slug: "us-tx-well-servicing", name: "Oil and Gas Well Servicing Tax", category: "severance", path: "/taxes/well-servicing/" },
  { slug: "us-tx-oyster-fee", name: "Oyster Sales Fee", category: "fee", path: "/taxes/oyster/" },
  { slug: "us-tx-pari-mutuel", name: "Pari-Mutuel Tax", category: "excise", path: "/taxes/pari-mutuel/" },
  { slug: "us-tx-property", name: "Property Tax", category: "property", path: "/taxes/property-tax/" },
  { slug: "us-tx-public-utility-gr", name: "Public Utility Gross Receipts Assessment", category: "gross_receipts", path: "/taxes/public-utility/" },
  { slug: "us-tx-sales-use", name: "Sales and Use Tax", category: "sales_tax", path: "/taxes/sales/" },
  { slug: "us-tx-sob-fee", name: "Sexually Oriented Business Fee", category: "fee", path: "/taxes/sobf/" },
  { slug: "us-tx-terp-offroad", name: "Texas Emissions Reduction Plan (TERP) Off-Road Heavy-Duty Diesel Equipment Surcharge", category: "excise", path: "/taxes/motor-vehicle/terp-offroad.php" },
  { slug: "us-tx-tobacco", name: "Tobacco, Cigarette and E-Cigarette Taxes and Fees", category: "excise", path: "/taxes/tobacco/" },
];
