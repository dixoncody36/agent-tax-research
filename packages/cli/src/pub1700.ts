import { inflateRawSync } from "node:zlib";

// KDOR Publication 1700 parser (issue #55) — pure functions over the
// quarterly "all city, county and special jurisdiction tax rates" Excel
// workbook. No dependencies: minimal zip local-header reader + sheet XML
// scan. Money math is integer micro-percent (rate fraction x 1e8) so no
// float ever touches a rate (027); Excel float artifacts like
// 1.7500000000000002E-2 round to the exact published micro value.
//
// Sheet "Sales Tax Rates" columns (verified against pub17001026):
//  A place/district name (continuation rows blank)  B address range
//  C jurisdiction code (non-food)   D total non-food (formula, may be uncached)
//  E jurisdiction code (food)       F total food (formula, may be uncached)
//  G effective date (Excel serial)  H county rate   I city rate
//  J combined special-district rate K state non-food L state food
//  M/N totals (formulas)            O "Special Districts" marker
// Totals are always RECOMPUTED (H+I+J+K / H+I+J+L) — cached formula
// values, when present, are only a cross-check the reviewer re-performs.

export type Pub1700Row = {
  rowNumber: number;
  place: string;
  addressRange: string;
  code: string;
  foodCode: string;
  effectiveFrom: string;
  countyMicro: number | null;
  cityMicro: number | null;
  specialMicro: number | null;
  stateMicro: number | null;
  stateFoodMicro: number | null;
  totalNonFoodMicro: number | null;
  totalFoodMicro: number | null;
  isSpecial: boolean;
};

export function unzipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break; // PK\3\4 local header
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString("utf8", off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    off = dataStart + compSize;
  }
  return out;
}

const xmlUnescape = (s: string) =>
  s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&");

export function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>(.*?)<\/si>/gs)].map((m) =>
    xmlUnescape(m[1]!.replace(/<[^>]+>/g, "")));
}

export const microFromFraction = (v: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e8); // fraction -> micro-percent-points (x100 x1e6)
};
// Blank sheet cell = "not stated on this row" (district header rows, KDOR
// continuation-row defects) — distinct from an explicit 0 rate.
export const microOrNull = (v: string | undefined): number | null =>
  v === undefined || v.trim() === "" ? null : microFromFraction(v);
export const percentFromMicro = (m: number): string => {
  const s = (m / 1e6).toFixed(6);
  return s.replace(/\.?0+$/, "") || "0";
};
export const excelSerialToDate = (v: string): string => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
};

export function parsePub1700Rows(sheetXml: string, strings: string[]): Pub1700Row[] {
  const rows: Pub1700Row[] = [];
  const rowMatches = [...sheetXml.matchAll(/<row[^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs)];
  for (const rm of rowMatches) {
    const rowNumber = Number(rm[1]);
    if (rowNumber <= 2) continue; // instruction + header rows
    const cells: Record<string, string> = {};
    for (const c of rm[2]!.matchAll(/<c r="([A-Z]+)\d+"(?:[^>]*t="(\w+)")?[^>]*>(?:<f[^>]*>.*?<\/f>)?(?:<v>([^<]*)<\/v>)?/gs)) {
      const [, col, t, v] = c;
      cells[col!] = t === "s" && v !== undefined ? (strings[Number(v)] ?? "") : (v ?? "");
    }
    const code = (cells.C ?? "").trim();
    if (!code) continue;
    const countyMicro = microOrNull(cells.H);
    const cityMicro = microOrNull(cells.I);
    const specialMicro = microOrNull(cells.J);
    const stateMicro = microOrNull(cells.K);
    const stateFoodMicro = microOrNull(cells.L);
    rows.push({
      rowNumber,
      place: (cells.A ?? "").trim(),
      addressRange: (cells.B ?? "").trim(),
      code,
      foodCode: (cells.E ?? "").trim(),
      effectiveFrom: excelSerialToDate(cells.G ?? ""),
      countyMicro, cityMicro, specialMicro, stateMicro, stateFoodMicro,
      totalNonFoodMicro: [countyMicro, cityMicro, specialMicro, stateMicro].every((x) => x !== null) ? countyMicro! + cityMicro! + specialMicro! + stateMicro! : null,
      totalFoodMicro: [countyMicro, cityMicro, specialMicro, stateFoodMicro].every((x) => x !== null) ? countyMicro! + cityMicro! + specialMicro! + stateFoodMicro! : null,
      isSpecial: (cells.O ?? "").trim() === "Special Districts",
    });
  }
  return rows;
}

export type Components = {
  counties: Map<string, { name: string; code: string; micro: number | null; effectiveFrom: string; totalMicro: number | null }>;
  cities: Map<string, { name: string; code: string; micro: number | null; effectiveFrom: string; countySuffix: string; totalMicro: number | null }>;
  specials: Map<string, { name: string; code: string; micro: number | null; effectiveFrom: string; totalMicro: number | null; addressRanges: string[] }>;
  conflicts: string[];
};

// Component extraction. County identity: rows whose code ends in "CO"
// (county-wide/unincorporated rows, place = "<Name> County"). City
// identity: non-special rows keyed by jurisdiction code (a city spanning
// counties repeats with the same city rate; divergence is a conflict).
// Special districts: col-O rows keyed by code; name from the group's
// first row, continuation rows contribute address ranges.
export function extractComponents(rows: Pub1700Row[]): Components {
  const counties: Components["counties"] = new Map();
  const cities: Components["cities"] = new Map();
  const specials: Components["specials"] = new Map();
  const conflicts: string[] = [];

  for (const r of rows) {
    // Blank rate cells (district header rows, KDOR continuation-row
    // defects) are "not stated": adopt the first non-null value and
    // treat only differing non-null values as conflicts.
    const adopt = (prev: number | null, next: number | null, label: string): number | null => {
      if (prev === null) return next;
      if (next !== null && next !== prev) {
        conflicts.push(`${label} rate conflict ${prev} vs ${next} (row ${r.rowNumber})`);
      }
      return prev;
    };
    if (!r.isSpecial && r.code.endsWith("CO") && r.place) {
      const prev = counties.get(r.code);
      if (!prev) {
        counties.set(r.code, { name: r.place, code: r.code, micro: r.countyMicro, effectiveFrom: r.effectiveFrom, totalMicro: r.totalNonFoodMicro });
      } else {
        prev.micro = adopt(prev.micro, r.countyMicro, `county ${r.code}`);
        if (prev.totalMicro === null) prev.totalMicro = r.totalNonFoodMicro;
        if (!prev.effectiveFrom) prev.effectiveFrom = r.effectiveFrom;
      }
      continue;
    }
    if (!r.isSpecial && r.place) {
      const prev = cities.get(r.code);
      if (!prev) {
        cities.set(r.code, {
          name: r.place, code: r.code, micro: r.cityMicro,
          effectiveFrom: r.effectiveFrom, countySuffix: r.code.slice(-2),
          totalMicro: r.totalNonFoodMicro,
        });
      } else {
        prev.micro = adopt(prev.micro, r.cityMicro, `city ${r.code} (${r.place})`);
        if (prev.totalMicro === null) prev.totalMicro = r.totalNonFoodMicro;
        if (!prev.effectiveFrom) prev.effectiveFrom = r.effectiveFrom;
      }
      continue;
    }
    if (r.isSpecial) {
      const prev = specials.get(r.code);
      if (!prev) {
        specials.set(r.code, {
          name: r.place || r.code, code: r.code, micro: r.specialMicro,
          effectiveFrom: r.effectiveFrom, totalMicro: r.totalNonFoodMicro,
          addressRanges: r.addressRange ? [r.addressRange] : [],
        });
      } else {
        if (r.place && prev.name === prev.code) prev.name = r.place;
        prev.micro = adopt(prev.micro, r.specialMicro, `special ${r.code}`);
        if (prev.totalMicro === null) prev.totalMicro = r.totalNonFoodMicro;
        if (!prev.effectiveFrom) prev.effectiveFrom = r.effectiveFrom;
        if (r.addressRange) prev.addressRanges.push(r.addressRange);
      }
    }
  }
  return { counties, cities, specials, conflicts };
}
