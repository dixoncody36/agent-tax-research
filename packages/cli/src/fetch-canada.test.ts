import assert from "node:assert/strict";
import test from "node:test";
import { CA_JURISDICTION_SLUGS, CA_TAX_TYPE_SLUGS, DESCRIPTORS } from "./fetch-canada-sources.js";

// Register invariants for the Canada fetch (#47): every jurisdiction in
// scope carries a classified primary source, government hosts only, and
// every descriptor points at a seeded ca tax type. These pin the URL
// corrections made after live 404/403 probes (2026-11).

const GOV_HOST_SUFFIXES = [
  ".canada.ca", ".gc.ca", ".gov.bc.ca", ".gov.mb.ca", ".gov.nl.ca",
  ".gov.nt.ca", ".gov.nu.ca", ".gnb.ca",
];
const GOV_HOSTS = new Set([
  "www.canada.ca", "www.revenuquebec.ca", "www2.gov.bc.ca", "www.alberta.ca",
  "www.saskatchewan.ca", "www.gov.mb.ca", "www.ontario.ca", "www2.gnb.ca",
  "novascotia.ca", "www.novascotia.ca", "www.gov.nl.ca", "www.princeedwardisland.ca",
  "yukon.ca", "www.fin.gov.nt.ca", "www.gov.nu.ca",
]);

test("every Canada jurisdiction has at least one classified source", () => {
  for (const slug of CA_JURISDICTION_SLUGS) {
    assert.ok(
      DESCRIPTORS.some((d) => d.jurisdictionSlug === slug),
      `no source descriptor for ${slug}`,
    );
  }
});

test("descriptor URLs are unique https government hosts", () => {
  const urls = DESCRIPTORS.map((d) => d.url);
  assert.equal(new Set(urls).size, urls.length, "duplicate descriptor URL");
  for (const d of DESCRIPTORS) {
    const u = new URL(d.url);
    assert.equal(u.protocol, "https:", d.url);
    assert.ok(
      GOV_HOSTS.has(u.host) || GOV_HOST_SUFFIXES.some((s) => u.host.endsWith(s)),
      `non-government host: ${u.host}`,
    );
  }
});

test("descriptors reference only seeded ca tax types", () => {
  const known = new Set<string>(CA_TAX_TYPE_SLUGS);
  for (const d of DESCRIPTORS) {
    assert.ok(known.has(d.taxTypeSlug), `unknown tax type ${d.taxTypeSlug}`);
    assert.ok(d.publisher.length > 0 && d.name.length > 0, d.url);
  }
});
