import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assignSlugs,
  citySlug,
  cleanCityName,
  isValidCitySlug,
  nonCityReason,
  parseCityRows,
} from "./city-slug.js";

// Regression suite for #35: every input below was observed malformed in the
// jurisdictions table after the first city bulk parse.

describe("cleanCityName", () => {
  it("strips mid-name parentheticals and formerly tails", () => {
    assert.equal(cleanCityName("Corral City (Denton Co) - formerly Draper"), "Corral City");
  });
  it("strips trailing county hints", () => {
    assert.equal(cleanCityName("Westbank Lib Dist (Travis Co)"), "Westbank Lib Dist");
    assert.equal(cleanCityName("Lake Travis Lib Dist (Travis)"), "Lake Travis Lib Dist");
  });
  it("removes orphan closing parens from fragment captures", () => {
    assert.equal(cleanCityName("Denton Co)"), "Denton Co");
  });
});

describe("nonCityReason", () => {
  it("rejects library and assistance districts", () => {
    assert.equal(nonCityReason("Salado Lib Dist"), "non_city_row");
    assert.equal(nonCityReason("Salado Public Library District"), "non_city_row");
    assert.equal(nonCityReason("Ector Co Asst Dist"), "non_city_row");
    assert.equal(nonCityReason("Rockwall Co Asst Dist"), "non_city_row");
  });
  it("rejects county rows but keeps same-named cities", () => {
    assert.equal(nonCityReason("Hays Co"), "non_city_row");
    assert.equal(nonCityReason("Hays County"), "non_city_row");
    assert.equal(nonCityReason("Fort Bend Co"), "non_city_row");
    assert.equal(nonCityReason("Hays"), null);
    assert.equal(nonCityReason("Ector"), null);
  });
  it("rejects fragments and parse artifacts", () => {
    assert.equal(nonCityReason("A"), "fragment_name");
    assert.equal(nonCityReason("Error Tax"), "parse_artifact");
  });
  it("accepts ordinary incorporated places", () => {
    assert.equal(nonCityReason("Corral City"), null);
    assert.equal(nonCityReason("Liberty Hill"), null);
    assert.equal(nonCityReason("Commerce"), null);
  });
});

describe("citySlug", () => {
  it("produces clean kebab slugs with no parens or double hyphens", () => {
    const slug = citySlug(cleanCityName("Corral City (Denton Co) - formerly Draper"), "2061293");
    assert.equal(slug, "us-tx-city-corral-city");
    assert.ok(isValidCitySlug(slug));
  });
  it("maps Austin by code to the seeded jurisdiction", () => {
    assert.equal(citySlug("Austin", "2227016"), "us-tx-austin");
  });
  it("disambiguates same-name places by code instead of merging", () => {
    const taken = new Map([["us-tx-city-rockwall", "1000001"]]);
    assert.equal(citySlug("Rockwall", "1000002", taken), "us-tx-city-rockwall-1000002");
    assert.equal(citySlug("Rockwall", "1000001", taken), "us-tx-city-rockwall");
  });
  it("every assigned slug validates", () => {
    const rows = [
      { name: "Corral City", code: "2061293", rate: 1, total: 8 },
      { name: "St. Hedwig", code: "2015001", rate: 1, total: 8 },
      { name: "O'Brien", code: "2104001", rate: 1, total: 8 },
    ];
    for (const slug of assignSlugs(rows).values()) assert.ok(isValidCitySlug(slug), slug);
  });
});

describe("parseCityRows (#43 seven-decimal rates)", () => {
  it("keeps max-rate cities printed with seven decimals (Arlington)", () => {
    // Observed verbatim in the stored snapshot: rate .0200000 (7dp) where
    // the old pattern demanded exactly 6 — the row silently dropped.
    const text = "Arlington (Tarrant Co) 2220095 .0200000 .082500";
    const { rows, rejected } = parseCityRows(text);
    assert.equal(rejected.length, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, "Arlington");
    assert.equal(rows[0]?.rate, 2);
    assert.equal(rows[0]?.total, 8.25);
  });
});

describe("parseCityRows", () => {
  it("keeps cities and rejects districts/fragments with reasons", () => {
    const text = [
      "Austin 2227016 .010000 .082500",
      "Salado Lib Dist 6014610 .005000 .082500",
      "Corral City (Denton Co) - formerly Draper 2061293 .010000 .080000",
      "Error Tax 2254995 .010000 .077500",
      "Hays 2105086 .010000 .082500",
      "Hays Co 6105601 .005000 .082500",
    ].join("\n");
    const { rows, rejected } = parseCityRows(text);
    assert.deepEqual(rows.map((r) => r.code).sort(), ["2061293", "2105086", "2227016"]);
    assert.deepEqual(
      rejected.map((r) => r.reason).sort(),
      ["non_city_row", "non_city_row", "parse_artifact"],
    );
    const slugs = assignSlugs(rows);
    assert.equal(slugs.get("2227016"), "us-tx-austin");
    assert.equal(slugs.get("2061293"), "us-tx-city-corral-city");
  });
});
