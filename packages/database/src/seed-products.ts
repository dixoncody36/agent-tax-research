import { eq } from "drizzle-orm";
import { client, db, productCategories } from "./index.js";

// Product taxonomy seed (issue #27). Definitions are written the way
// statutes draw lines; each leaf carries a classification question pack
// plus a deterministic fact-match so an operator product can be
// re-classified from its recorded facts and reproduce the bucket (027).
// Idempotent: upserts by slug. Run: pnpm --filter @agent-tax-research/database run db:seed:products
type Cat = {
  slug: string; code: string; name: string; parent?: string; definition: string;
  questions: { fact: string; question: string }[]; match: Record<string, string>;
};
const CATS: Cat[] = [
  { slug: "software", code: "SW", name: "Computer software (all delivery modes)",
    definition: "Computer programs and associated data, however delivered. Jurisdictions split this bucket by delivery mode and by whether the charge is for the program itself or for using the seller's computers.",
    questions: [{ fact: "delivery_mode", question: "How does the customer get/use it: download, physical media, or remote access to seller-hosted software (SaaS)?" }, { fact: "customization", question: "Canned (prewritten) or custom-developed for one customer?" }, { fact: "possession", question: "Does the customer ever possess a copy?" }],
    match: { product_kind: "software" } },
  { slug: "software-downloaded", code: "SW-DL", name: "Software delivered electronically (download)", parent: "software",
    definition: "Prewritten computer software transferred electronically with a right to use; no tangible medium changes hands.",
    questions: [{ fact: "delivery_mode", question: "Delivered by download/electronic transfer?" }, { fact: "possession", question: "Customer possesses and runs a copy on their own hardware?" }],
    match: { product_kind: "software", delivery_mode: "download" } },
  { slug: "software-saas", code: "SW-SAAS", name: "Software as a service (remote access)", parent: "software",
    definition: "Charges for remotely accessing software hosted and operated by the seller; the customer never possesses the program. Several states reach this as a data processing or information service rather than a sale of software.",
    questions: [{ fact: "delivery_mode", question: "Accessed remotely on the seller's infrastructure (no copy transferred)?" }, { fact: "data_processing", question: "Does the service store/manipulate the customer's data on the seller's computers?" }, { fact: "sourcing_users", question: "Where are the users who access it (multi-state sourcing)?" }],
    match: { product_kind: "software", delivery_mode: "saas_remote_access" } },
  { slug: "software-physical", code: "SW-PHYS", name: "Software on tangible media", parent: "software",
    definition: "Computer software sold on physical storage media; commonly treated as tangible personal property.",
    questions: [{ fact: "delivery_mode", question: "Delivered on physical media?" }],
    match: { product_kind: "software", delivery_mode: "physical_media" } },
  { slug: "data-processing-services", code: "SVC-DP", name: "Data processing services",
    definition: "Using a computer for word processing, data entry, retrieval, compilation, storage or manipulation of data, including payroll/accounting production (framed on TX Tax Code 151.0035).",
    questions: [{ fact: "data_processing", question: "Is the essence of the charge the seller's computerized storage/manipulation of data?" }],
    match: { product_kind: "data_processing" } },
  { slug: "digital-content", code: "DIG", name: "Digital content (streamed/downloaded media & e-books)",
    definition: "Audio, video, books and similar content delivered electronically, by download or streaming, with no tangible medium.",
    questions: [{ fact: "delivery_mode", question: "Streamed or downloaded?" }, { fact: "permanence", question: "Permanent download or temporary access?" }],
    match: { product_kind: "digital_content" } },
  { slug: "telecom-services", code: "TEL", name: "Telecommunications services",
    definition: "Transmission of voice, data or video for a charge, intrastate/interstate distinctions and prepaid calling treated specially in most regimes; federal USF and 911 surcharges ride along.",
    questions: [{ fact: "transmission", question: "Is the charge for transmission itself or for content/equipment?" }, { fact: "prepaid", question: "Prepaid or postpaid?" }],
    match: { product_kind: "telecom" } },
  { slug: "lodging", code: "LDG", name: "Lodging & occupancy",
    definition: "Renting rooms or spaces for overnight occupancy; most regimes exempt stays beyond a duration threshold (e.g. 30 days) as permanent residence.",
    questions: [{ fact: "rental_term", question: "Short-term (under the local permanent-resident threshold) or long-term?" }, { fact: "platform", question: "Booked direct or through a marketplace/platform?" }],
    match: { product_kind: "lodging" } },
  { slug: "short-term-rental", code: "LDG-STR", name: "Short-term rentals (STR)", parent: "lodging",
    definition: "Residential premises rented for brief occupancy periods, commonly via platforms; frequently subject to hotel occupancy taxes plus local registration.",
    questions: [{ fact: "rental_term", question: "Rented in short stays below the permanent-resident threshold?" }, { fact: "platform", question: "Platform-collected or host-collected?" }],
    match: { product_kind: "lodging", rental_term: "short_term" } },
  { slug: "fuels", code: "FUEL", name: "Motor & special fuels",
    definition: "Gasoline, diesel and alternative fuels; excise usually measured per gallon at the rack/terminal level, with off-road and exempt-use carve-outs.",
    questions: [{ fact: "fuel_type", question: "Gasoline, diesel, CNG/LNG, aviation?" }, { fact: "use", question: "On-road use or exempt/off-road use?" }],
    match: { product_kind: "fuel" } },
  { slug: "tobacco", code: "TOB", name: "Tobacco products",
    definition: "Cigarettes and other tobacco products; typically per-unit or ad valorem at wholesale, with stamping/distributor licensing.",
    questions: [{ fact: "product_form", question: "Cigarettes, other tobacco, or vapor/e-cigarette products?" }],
    match: { product_kind: "tobacco" } },
  { slug: "e-cigarettes", code: "TOB-ECIG", name: "E-cigarettes & vapor products", parent: "tobacco",
    definition: "Vapor products and consumable material; often taxed per milliliter/container or ad valorem under separate schedules from combustible tobacco.",
    questions: [{ fact: "product_form", question: "Vapor/e-cigarette device or consumable liquid?" }],
    match: { product_kind: "tobacco", product_form: "e_cigarette" } },
  { slug: "marketplace-facilitated-goods", code: "MPF", name: "Marketplace-facilitated sales",
    definition: "Goods sold through a marketplace facilitator that lists, processes payment and often must collect/remit on the seller's behalf.",
    questions: [{ fact: "sales_channel", question: "Sold through a marketplace facilitator that processes the payment?" }],
    match: { sales_channel: "marketplace_facilitator" } },
  { slug: "delivery-services", code: "DLV", name: "Delivery & courier services",
    definition: "Delivery charges and delivery-network services; taxability often turns on whether delivery is separately stated and on who performs it (seller vs third-party network).",
    questions: [{ fact: "separately_stated", question: "Delivery charge separately stated on the invoice?" }, { fact: "carrier", question: "Seller's own vehicle or third-party carrier/network?" }],
    match: { product_kind: "delivery" } },
];

const ids = new Map<string, string>();
for (const pass of [0, 1]) {
  for (const c of CATS) {
    if ((pass === 0) === Boolean(c.parent)) continue;
    const parentId = c.parent ? ids.get(c.parent) : undefined;
    if (c.parent && !parentId) throw new Error(`parent ${c.parent} not seeded`);
    const values = {
      slug: c.slug, code: c.code, name: c.name, parentId: parentId ?? null,
      definition: c.definition,
      classificationFacts: { questions: c.questions, match: c.match },
    };
    const [row] = await db.insert(productCategories).values(values)
      .onConflictDoUpdate({ target: productCategories.slug, set: { ...values, updatedAt: new Date() } })
      .returning({ id: productCategories.id });
    ids.set(c.slug, row!.id);
  }
}
const [n] = await db.select({ id: productCategories.id }).from(productCategories).where(eq(productCategories.slug, "software-saas"));
console.log(`seeded product categories: ${CATS.length} (software-saas present: ${Boolean(n)})`);
await client.end();
