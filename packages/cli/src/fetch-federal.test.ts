import assert from "node:assert/strict";
import test from "node:test";
import { DESCRIPTORS } from "./fetch-federal-sources.js";

// Register invariants for the federal fetch (#16): the three federal
// coverage-pack tax types each carry a classified IRS source, irs.gov
// only, unique URLs, everything scoped to the us jurisdiction.
const PACK_TYPES = ["us-federal-excise", "us-federal-income-corporate", "us-federal-income-individual"];

test("every federal coverage-pack tax type has at least one classified source", () => {
  for (const slug of PACK_TYPES) {
    assert.ok(DESCRIPTORS.some((d) => d.taxTypeSlug === slug), `no source descriptor for ${slug}`);
  }
});

test("descriptor URLs are unique https irs.gov hosts under the us jurisdiction", () => {
  const urls = DESCRIPTORS.map((d) => d.url);
  assert.equal(new Set(urls).size, urls.length, "duplicate descriptor URL");
  for (const d of DESCRIPTORS) {
    const u = new URL(d.url);
    assert.equal(u.protocol, "https:", d.url);
    assert.equal(u.host, "www.irs.gov", `non-IRS host: ${u.host}`);
    assert.equal(d.jurisdictionSlug, "us", d.url);
    assert.equal(d.publisher, "Internal Revenue Service", d.url);
  }
});
