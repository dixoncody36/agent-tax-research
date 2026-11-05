// City name/slug hygiene for Comptroller rate-table bulk parses (#35).
// Pure logic, no DB: bulk-cities.ts and fix-city-slugs.ts both consume it,
// and city-slug.test.ts pins the observed malformed inputs as regressions.

export type CityRow = { name: string; code: string; rate: number; total: number };
export type RejectedRow = { name: string; code: string; reason: string };

const AUSTIN_CODE = "2227016";

/** Display name: drop every parenthetical and any "- formerly ..." tail. */
export function cleanCityName(raw: string): string {
  return raw
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s*-+\s*formerly\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[)\]]+$/, "")
    .trim();
}

// Coded rows in the city table that are not incorporated places: library and
// assistance districts, county levies, authorities. Districts belong to the
// SPD bulk; registering them as cities twins them at the wrong level.
const NON_CITY =
  /\b(Lib|Library|Asst|Assistance|Dist|District|County|Co|MTA|CTA|CTD|Transit|Authority)\b\.?/;

/** Null when the cleaned row is a plausible incorporated place, else reason. */
export function nonCityReason(cleanedName: string): string | null {
  if (cleanedName.length < 3) return "fragment_name";
  if (/error/i.test(cleanedName)) return "parse_artifact";
  if (/local code|city name/i.test(cleanedName)) return "table_header";
  if (NON_CITY.test(cleanedName)) return "non_city_row";
  return null;
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Stable slug for a city row. `taken` maps slug -> Comptroller code already
 * using it; a true same-name/different-code collision (distinct places
 * sharing a name) disambiguates with the code instead of silently merging.
 */
export function citySlug(
  cleanedName: string,
  code: string,
  taken: ReadonlyMap<string, string> = new Map(),
): string {
  if (code === AUSTIN_CODE) return "us-tx-austin";
  const body = cleanedName
    .toLowerCase()
    .replace(/['.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!KEBAB.test(body)) throw new Error(`unsluggable city name: ${cleanedName}`);
  const slug = `us-tx-city-${body}`;
  const holder = taken.get(slug);
  return holder && holder !== code ? `${slug}-${code}` : slug;
}

export function isValidCitySlug(slug: string): boolean {
  return slug === "us-tx-austin" || /^us-tx-city-[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

/** Parse the city rate-table snapshot text into accepted + rejected rows. */
/** Decimal fraction digits -> percent points via integer micro-units (no float dust). */
function fracToPercent(digits: string): number {
  const micro = Number.parseInt(digits, 10) * 10 ** (8 - digits.length);
  return micro / 1e6;
}

export function parseCityRows(text: string): { rows: CityRow[]; rejected: RejectedRow[] } {
  const re = /([A-Z][A-Za-z'.()\- ]+?)\s+(\d{7})\s+\.(\d{6,7})\s+\.(\d{6,7})/g;
  const byCode = new Map<string, CityRow>();
  const rejected: RejectedRow[] = [];
  for (const m of text.matchAll(re)) {
    const rawName = m[1]!.trim().replace(/\s+/g, " ");
    const code = m[2]!;
    if (byCode.has(code)) continue;
    const name = cleanCityName(rawName);
    const reason = nonCityReason(name);
    if (reason) {
      rejected.push({ name: rawName, code, reason });
      continue;
    }
    byCode.set(code, {
      name,
      code,
      rate: fracToPercent(m[3]!),
      total: fracToPercent(m[4]!),
    });
  }
  return { rows: [...byCode.values()], rejected };
}

/** Assign slugs to parsed rows in order, resolving same-name collisions. */
export function assignSlugs(rows: CityRow[]): Map<string, string> {
  const taken = new Map<string, string>();
  const slugByCode = new Map<string, string>();
  for (const r of rows) {
    const slug = citySlug(r.name, r.code, taken);
    taken.set(slug, r.code);
    slugByCode.set(r.code, slug);
  }
  return slugByCode;
}
