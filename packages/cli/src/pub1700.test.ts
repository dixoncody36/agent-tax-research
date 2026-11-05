import assert from "node:assert/strict";
import test from "node:test";
import {
  excelSerialToDate, extractComponents, microFromFraction,
  parsePub1700Rows, parseSharedStrings, percentFromMicro,
} from "./pub1700.js";

// Synthetic Pub 1700 sheet (same cell layout as pub17001026): one county
// row, one city in it, one zero-rate city, one special district with a
// continuation address row. Pins micro conversion, serial dates, totals
// recomputation and component extraction.
const STRINGS = [
  "Reno County", "RNCO", "Hutchinson", "HUTRN", "Abilene", "ABIDK",
  "Dickinson County", "DKCO", "Family Dollar CID", "ABIC4", "Special Districts",
  "1709 N Buckeye Ave", "RNHUT", "DKABI", "C4ABI",
];
const ssXml = `<sst>${STRINGS.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
const s = (i: number) => `t="s"><v>${i}</v>`;
const sheetXml = `<worksheet><sheetData>
<row r="1"><c r="A1" ${s(10)}</c></row>
<row r="2"><c r="A2" ${s(10)}</c></row>
<row r="3"><c r="A3" ${s(0)}</c><c r="C3" ${s(1)}</c><c r="G3"><v>43647</v></c><c r="H3"><v>0.01</v></c><c r="I3"><v>0</v></c><c r="J3"><v>0</v></c><c r="K3"><v>6.5000000000000002E-2</v></c><c r="L3"><v>0</v></c></row>
<row r="4"><c r="A4" ${s(2)}</c><c r="C4" ${s(3)}</c><c r="E4" ${s(12)}</c><c r="G4"><v>45839</v></c><c r="H4"><v>0.01</v></c><c r="I4"><v>1.2499999999999999E-2</v></c><c r="J4"><v>0</v></c><c r="K4"><v>6.5000000000000002E-2</v></c><c r="L4"><v>0</v></c></row>
<row r="5"><c r="A5" ${s(4)}</c><c r="C5" ${s(5)}</c><c r="E5" ${s(13)}</c><c r="G5"><v>45839</v></c><c r="H5"><v>1.7500000000000002E-2</v></c><c r="I5"><v>0</v></c><c r="J5"><v>0</v></c><c r="K5"><v>6.5000000000000002E-2</v></c><c r="L5"><v>0</v></c></row>
<row r="6"><c r="A6" ${s(8)}</c><c r="C6" ${s(9)}</c><c r="E6" ${s(14)}</c><c r="G6"><v>45839</v></c><c r="H6"><v>1.7500000000000002E-2</v></c><c r="I6"><v>1.0999999999999999E-2</v></c><c r="J6"><v>0.02</v></c><c r="K6"><v>6.5000000000000002E-2</v></c><c r="L6"><v>0</v></c><c r="O6" ${s(10)}</c></row>
<row r="7"><c r="B7" ${s(11)}</c><c r="C7" ${s(9)}</c><c r="G7"><v>45839</v></c><c r="H7"><v>1.7500000000000002E-2</v></c><c r="I7"><v>1.0999999999999999E-2</v></c><c r="J7"><v>0.02</v></c><c r="K7"><v>6.5000000000000002E-2</v></c><c r="L7"><v>0</v></c><c r="O7" ${s(10)}</c></row>
</sheetData></worksheet>`;

test("micro conversion is exact on Excel float artifacts", () => {
  assert.equal(microFromFraction("6.5000000000000002E-2"), 6_500_000);
  assert.equal(microFromFraction("1.7500000000000002E-2"), 1_750_000);
  assert.equal(microFromFraction("1.0999999999999999E-2"), 1_100_000);
  assert.equal(microFromFraction("0.02"), 2_000_000);
  assert.equal(percentFromMicro(6_500_000), "6.5");
  assert.equal(percentFromMicro(1_100_000), "1.1");
  assert.equal(percentFromMicro(0), "0");
});

test("excel serial dates convert (1899-12-30 epoch)", () => {
  assert.equal(excelSerialToDate("45839"), "2025-07-01");
  assert.equal(excelSerialToDate("43647"), "2019-07-01");
  assert.equal(excelSerialToDate(""), "");
});

test("rows parse and totals recompute in micro units", () => {
  const rows = parsePub1700Rows(sheetXml, parseSharedStrings(ssXml));
  assert.equal(rows.length, 5);
  const hut = rows.find((r) => r.code === "HUTRN")!;
  assert.equal(hut.place, "Hutchinson");
  assert.equal(hut.countyMicro, 1_000_000);
  assert.equal(hut.cityMicro, 1_250_000);
  assert.equal(hut.totalNonFoodMicro, 8_750_000); // 1 + 1.25 + 0 + 6.5
  assert.equal(hut.totalFoodMicro, 2_250_000); // state food 0
  assert.equal(hut.effectiveFrom, "2025-07-01");
  assert.equal(hut.isSpecial, false);
});

test("components extract by code with specials grouped", () => {
  const rows = parsePub1700Rows(sheetXml, parseSharedStrings(ssXml));
  const c = extractComponents(rows);
  assert.equal(c.conflicts.length, 0);
  assert.equal(c.counties.get("RNCO")?.name, "Reno County");
  assert.equal(c.counties.get("RNCO")?.micro, 1_000_000);
  assert.equal(c.cities.get("ABIDK")?.micro, 0); // zero-levy city kept as structure
  assert.equal(c.cities.get("HUTRN")?.countySuffix, "RN");
  const sp = c.specials.get("ABIC4")!;
  assert.equal(sp.name, "Family Dollar CID");
  assert.equal(sp.micro, 2_000_000);
  assert.deepEqual(sp.addressRanges, ["1709 N Buckeye Ave"]);
});
