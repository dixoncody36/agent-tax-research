// Texas insurance premium-tax source descriptors (issue #16 depth pass) —
// Comptroller insurance subpages discovered from the snapshotted hub's
// link set (hub snapshot itself carries no rates). Fetch snapshots these
// so rates_by_class determinations can cite per-line evidence.
export type Descriptor = {
  jurisdictionSlug: string;
  taxTypeSlug: string;
  name: string;
  url: string;
  publisher: string;
  notes: string;
};

const COMPTROLLER = "Texas Comptroller of Public Accounts";
const BASE = "https://comptroller.texas.gov/taxes/insurance/";

export const DESCRIPTORS: Descriptor[] = [
  ["licensed.php", "Insurance Premium Taxes — Licensed Insurers", "Per-line premium tax rates for licensed insurers (life/health, property & casualty, title...)."],
  ["captive.php", "Insurance Premium Taxes — Licensed Captive Insurers", "Captive insurer premium tax."],
  ["surplus-lines.php", "Surplus Lines Premium Tax / Purchasing Groups", "Surplus lines premium tax rate and stamping-office mechanics."],
  ["independent.php", "Independently Procured Insurance Premium Tax", "Self-procured coverage premium tax."],
  ["unauthorized.php", "Unauthorized Insurance Premium Tax", "Unauthorized-insurer premium tax."],
].map(([path, name, notes]) => ({
  jurisdictionSlug: "us-tx",
  taxTypeSlug: "us-tx-insurance",
  name: name!,
  url: BASE + path,
  publisher: COMPTROLLER,
  notes: notes!,
}));
