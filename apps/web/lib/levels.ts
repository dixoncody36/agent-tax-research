// Domain order for jurisdiction levels (never alphabetical): country first,
// special districts last. Shared by the explorer API and UI.
export const LEVEL_ORDER = ["country", "region", "state", "province", "county", "city", "special_district", "other"] as const;
export const LEVEL_LABEL: Record<string, string> = {
  country: "Countries", region: "Regions", state: "States", province: "Provinces",
  county: "Counties", city: "Cities", special_district: "Special districts", other: "Other",
};
export const levelRank = (level: string): number => {
  const i = (LEVEL_ORDER as readonly string[]).indexOf(level);
  return i === -1 ? LEVEL_ORDER.length : i;
};
