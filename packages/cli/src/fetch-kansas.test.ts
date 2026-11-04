import assert from "node:assert/strict";
import test from "node:test";
import { DESCRIPTORS, KS_TAX_TYPE_SLUGS } from "./fetch-kansas-sources.js";

// Register invariants for the Kansas fetch (#53): every seeded tax type
// carries a classified primary source, government hosts only, unique URLs.
const GOV_HOSTS = new Set(["www.ksrevenue.gov", "www.kansasgis.org", "kansasgis.org"]);

test("every Kansas tax type has at least one classified source", () => {
  for (const slug of KS_TAX_TYPE_SLUGS) {
    assert.ok(
      DESCRIPTORS.some((d) => d.taxTypeSlug === slug),
      `no source descriptor for tax type ${slug}`,
    );
  }
});

test("descriptor URLs are unique https Kansas government hosts", () => {
  const urls = DESCRIPTORS.map((d) => d.url);
  assert.equal(new Set(urls).size, urls.length, "duplicate descriptor URL");
  for (const d of DESCRIPTORS) {
    const u = new URL(d.url);
    assert.equal(u.protocol, "https:", d.url);
    assert.ok(GOV_HOSTS.has(u.host), `non-government host: ${u.host}`);
    assert.equal(d.jurisdictionSlug, "us-ks", d.url);
  }
});
