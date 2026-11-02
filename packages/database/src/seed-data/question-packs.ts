/**
 * Coverage question packs v1 (decree p2) — as data, not prompts.
 *
 * One pack per `tax_types.category`, plus the `federal_conformity` pack
 * (US states) and niche overlays (oil_and_gas, telecom, ...). Opening a
 * jurisdiction generates its checklist from these packs; every question
 * resolves to found / confirmed_absent / unknown in `coverage_answers`.
 *
 * `evidenceRequired` names what answers the question; `absenceRequires`
 * names what a confirmed_absent verdict demands (AGENTS.md rule 7:
 * searched + not found + queries recorded, verifier-confirmed).
 * Seeded idempotently by seed.ts on (category, questionKey).
 */

export interface PackQuestion {
  questionKey: string;
  question: string;
  evidenceRequired?: string;
  absenceRequires?: string;
}

export const DEFAULT_EVIDENCE_REQUIRED =
  "Eligible government source (statute, regulation, agency guidance, rate table, or form library) stating the answer, cited against a source snapshot.";

export const DEFAULT_ABSENCE_REQUIRES =
  "Recorded search of the administering agency's tax index/landing pages and the relevant statute titles finding no such levy, rate, or rule; queries tried recorded in coverage_answers.evidence and verifier-confirmed.";

const q = (
  questionKey: string,
  question: string,
  evidenceRequired?: string,
  absenceRequires?: string,
): PackQuestion => ({ questionKey, question, evidenceRequired, absenceRequires });

const LEVY_ABSENCE =
  "Agency A-to-Z / tax-type index and statute title search recorded with no such levy listed; peer-jurisdiction expectation noted in evidence; verifier-confirmed.";

export const questionPacks: Record<string, PackQuestion[]> = {
  sales_tax: [
    q("levy_exists", "Does this jurisdiction impose a retail sales / use tax? Under what name and statutory authority?", undefined, LEVY_ABSENCE),
    q("state_rate", "What is the jurisdiction-level (state/national) sales/use tax rate, effective-dated, and what does it apply to?"),
    q("local_rates_and_cap", "What local (city/county/district/transit) sales tax components exist, how are they authorized, and is there a combined-rate cap?"),
    q("tax_base", "What is taxed: retail tangible goods, leases/rentals, which services, and how is the price/base defined (sourcing: origin or destination)?"),
    q("exemptions_exclusions", "What exemptions and exclusions apply (groceries, resale, manufacturing, nonprofits, exempt entities) and what certificates document them?"),
    q("nexus_thresholds", "What creates collection nexus (physical presence, economic nexus thresholds in sales/transactions, marketplace rules), effective when?", "Statute/regulation or agency nexus guidance with threshold amounts and measurement period."),
    q("permit_registration", "What permit/registration must sellers hold to collect, who issues it, what does it cost, and how is it renewed?"),
    q("filing_penalties_discounts", "What return is filed, how often, due when, paid how — and what late penalties, interest, and timely-filing/prepayment discounts apply?"),
    q("rate_history", "What is the rate history back to the earliest published data (effective-dated changes, not just the current rate)?", "Archived rate tables, statute history, or agency historical-rate pages covering each change."),
  ],
  vat_gst: [
    q("levy_exists", "Does this jurisdiction impose a VAT/GST? Under what name and statutory authority?", undefined, LEVY_ABSENCE),
    q("standard_rate", "What is the standard VAT/GST rate, effective-dated?"),
    q("reduced_and_zero_rates", "What reduced, zero, or special rates apply and to which supplies (food, exports, financial, digital)?"),
    q("place_of_supply_sourcing", "What are the place-of-supply rules for goods, services, and cross-border/digital supplies (reverse charge, import VAT)?"),
    q("exemptions", "Which supplies are exempt without input credit (health, education, finance, public bodies), distinct from zero-rated?"),
    q("registration_threshold", "What registration threshold applies to resident and non-resident suppliers, and when is voluntary registration allowed?", "Statute/regulation or agency registration guidance with threshold amounts and look-back period."),
    q("input_credits_refunds", "How do input tax credits, bad-debt relief, and excess-credit refunds work, including for non-residents/tourists?"),
    q("filing_penalties", "What return/invoice requirements, filing frequency, due dates, payment channels, penalties, and interest apply?"),
    q("rate_history", "What is the rate history (standard and reduced) back to the earliest published data?", "Archived rate schedules or statute history covering each change."),
  ],
  franchise_margin: [
    q("levy_exists", "Does this jurisdiction impose a franchise / margin / privilege tax on entities? Under what name and authority?", undefined, LEVY_ABSENCE),
    q("rates", "What rates apply, to which entity classes (e.g. retail/wholesale vs other), effective-dated by report year?"),
    q("tax_base", "How is the base computed (margin formula, deductions — COGS/compensation, EZ/alternative computations, caps)?"),
    q("apportionment_sourcing", "How is the base apportioned or sourced to this jurisdiction (single-factor receipts, throwback, combined/unitary groups)?"),
    q("thresholds_exemptions", "What no-tax-due / de minimis thresholds and entity exemptions (passive, nonprofit, sole proprietors) apply?"),
    q("nexus", "What activity creates franchise-tax nexus for foreign entities, and what registration/forfeiture consequences follow non-compliance?", "Statute or agency nexus guidance stating the doing-business standard."),
    q("filing", "What annual report (plus information reports) is filed, due when, extended how, and what ends the obligation (final report)?"),
    q("penalties_history", "What late penalties and interest apply, and what is the rate/threshold history to the earliest published data?"),
  ],
  income: [
    q("levy_exists", "Does this jurisdiction impose an income tax (individual, corporate, or both)? Under what name and authority?", undefined, LEVY_ABSENCE),
    q("rates_brackets", "What rates/brackets apply by taxpayer class and filing status, effective-dated by tax year (including flat vs graduated and surtaxes)?"),
    q("tax_base_starting_point", "What is the starting point (federal AGI/taxable income or standalone base) and what additions/subtractions define the base?"),
    q("deductions_credits_exemptions", "What standard/itemized deductions, personal exemptions, and credits apply, including credits for taxes paid elsewhere?"),
    q("withholding_estimates", "What withholding and estimated-payment obligations exist (employers, pass-throughs, nonresidents), on what schedule?"),
    q("nexus_apportionment", "For business income: what creates nexus, and how is income apportioned (formula, market sourcing, unitary/combined reporting)?", "Statute/regulation or agency guidance stating nexus standard and apportionment formula."),
    q("residency_nonresident", "How are residents, part-year residents, and nonresidents defined and taxed (source rules, reciprocity)?"),
    q("filing", "What returns are filed, due when (extensions, fiscal years), with what e-file thresholds and payment channels?"),
    q("penalties_history", "What penalties and interest apply (late, underpayment, accuracy), and what is the rate history to earliest published data?"),
  ],
  occupancy: [
    q("levy_exists", "Does this jurisdiction impose a hotel/occupancy/lodging tax? Under what name and authority?", undefined, LEVY_ABSENCE),
    q("state_rate", "What is the jurisdiction-level occupancy tax rate and the per-day room-price threshold it attaches at?"),
    q("local_rates", "What local (municipal/county/venue) occupancy taxes exist, who collects and who receives them (split remittance)?"),
    q("tax_base", "What is taxed: room charge only or also fees/cleaning/resort charges — and which lodging types (hotels, STRs, campgrounds, extended stay)?"),
    q("exemptions", "Who/what is exempt (permanent/long-stay guests, government, nonprofits) and after how many consecutive days?"),
    q("permit_registration", "What permit or registration must operators/platforms hold, who issues it, and at what cost?"),
    q("filing_penalties_discounts", "What report is filed, how often, due when — and what timely-filing discounts, late penalties, and interest apply?"),
    q("rate_history", "What is the rate history back to the earliest published data?", "Archived rate pages or statute history covering each change."),
  ],
  excise: [
    q("levy_exists", "Does this jurisdiction impose this excise tax (fuel, tobacco, alcohol, other per-unit levy)? Under what name and authority?", undefined, LEVY_ABSENCE),
    q("per_unit_rates", "What per-unit (or ad valorem) rates apply by product/class, in what units, effective-dated?"),
    q("point_of_taxation", "Where in the chain is tax imposed/collected (terminal rack, distributor, manufacturer, retail) and who remits?"),
    q("exemptions_refunds", "What exemptions and refund claims exist (government, export, off-road/agricultural use, interstate carriers/IFTA)?"),
    q("licenses_bonds", "What licenses, permits, stamps, or bonds must handlers in the chain hold, issued by whom and at what cost?"),
    q("filing", "What returns/schedules are filed, how often, due when (including floor-stock or inventory taxes on rate changes)?"),
    q("penalties", "What late/unlicensed-activity penalties, interest, and seizure provisions apply?"),
    q("rate_history", "What is the rate history back to the earliest published data?", "Archived rate tables or statute history covering each change."),
  ],
  severance: [
    q("levy_exists", "Does this jurisdiction impose a severance/production tax on extracted resources? On which products, under what authority?", undefined, LEVY_ABSENCE),
    q("rates_by_product", "What rates apply by product (crude oil, natural gas, condensate, other minerals), percent or per-unit, effective-dated?"),
    q("base_valuation", "How is the taxable value determined (wellhead/market value, posted price, deductions for transport/processing)?"),
    q("exemptions_incentives", "What exemptions, reduced rates, or incentives apply (stripper wells, high-cost gas, enhanced recovery, inactive wells)?"),
    q("who_remits", "Who bears and remits the tax (producer, first purchaser, working/royalty interest owners) and what reports allocate it?"),
    q("filing", "What production/tax reports are filed, how often, due when, and to which agency (tax vs conservation commission)?"),
    q("penalties", "What late penalties, interest, and lien/collection provisions apply?"),
    q("rate_history", "What is the rate history back to the earliest published data?", "Archived rate pages or statute history covering each change."),
  ],
  gross_receipts: [
    q("levy_exists", "Does this jurisdiction impose a gross receipts / business-and-occupation style tax? Under what name and authority?", undefined, LEVY_ABSENCE),
    q("rates_by_class", "What rates apply by business classification (retailing, services, utilities, insurance premiums), effective-dated?"),
    q("tax_base_sourcing", "How are gross receipts defined and sourced to this jurisdiction (market/destination, apportionable income)?"),
    q("exclusions_deductions_credits", "What receipts are excluded or deductible (interstate, pass-through amounts, bad debts) and what credits apply?"),
    q("thresholds_nexus", "What filing/tax thresholds and economic-nexus standards apply to in- and out-of-jurisdiction businesses?", "Statute or agency guidance with threshold amounts and measurement period."),
    q("filing_penalties", "What return is filed, how often, due when, paid how — and what penalties and interest apply?"),
    q("rate_history", "What is the rate history back to the earliest published data?", "Archived rate schedules or statute history covering each change."),
  ],
  property: [
    q("levy_exists", "Does this jurisdiction levy a property (ad valorem) tax, and at which level(s) — state, county, municipal, school, special district?", undefined, LEVY_ABSENCE),
    q("what_is_taxed", "What property is taxable: real estate, business personal property/intangibles, centrally assessed (railroads/utilities)?"),
    q("assessment_valuation", "How is value determined: market value standard, assessment ratios by class, valuation/appraisal cycle, who assesses?"),
    q("rates_millage", "How are rates set (millage by each taxing unit, levy limits, rollback/truth-in-taxation rules), and where are adopted rates published?"),
    q("exemptions", "What exemptions/reductions apply (homestead, senior/disabled, veterans, nonprofits, abatement programs)?"),
    q("billing_collection", "When are bills issued and due, what installment/discount options exist, and what delinquency/lien/tax-sale process follows?"),
    q("appeals", "How does a taxpayer protest valuation or exemption denial (informal review, board, court deadlines)?"),
    q("rate_history", "What statewide/structural history exists (caps, classification changes) to the earliest published data?"),
  ],
  fee: [
    q("levy_exists", "Does this jurisdiction impose this fee/surcharge? Under what name and authority, and what does it fund?", undefined, LEVY_ABSENCE),
    q("fee_amount_and_unit", "What is the fee amount and unit (flat, per-unit, percentage), effective-dated, and on what transaction/object does it attach?"),
    q("who_pays_collects", "Who pays, who must collect/remit, and is the fee shown separately to the customer?"),
    q("exemptions", "Who or what is exempt from the fee?"),
    q("filing_remittance", "On what form/schedule (its own or a host tax return), how often, and due when is the fee remitted?"),
    q("penalties_history", "What late penalties and interest apply, and what is the fee-amount history to earliest published data?"),
  ],
  federal_conformity: [
    q("conformity_type", "How does the state conform to the Internal Revenue Code: rolling (current IRC), fixed-date, or selective (section-by-section)?", "State income-tax statute conformity clause or department conformity guidance.", "State has no broad-based income/franchise tax starting from federal figures: search of revenue statute for an IRC reference recorded as not found; verifier-confirmed."),
    q("conformity_date", "If fixed-date or selective: as of what IRC version/date, and how are conformity updates enacted?"),
    q("starting_point", "What federal figure starts the state computation (federal AGI, federal taxable income, federal tax liability/piggyback percentage)?"),
    q("decouplings_modifications", "From which federal provisions does the state decouple (bonus depreciation, §163(j), GILTI, NOL, QBI), and what state-specific additions/subtractions replace them?", "Statute modifications list or department decoupling guidance, by tax year where it varies."),
    q("federal_deductibility", "Is federal income tax deductible in computing state tax (fully, partially/capped, or not at all)?"),
    q("piggyback_local", "Do local income taxes piggyback on the state/federal base or return (county/city percentage-of-state-tax or state-administered locals)?"),
  ],
  // --- Niche overlays (decree p2.t3.s2): how the niche works end to end. ---
  oil_and_gas: [
    q("severance_by_product", "What severance taxes hit oil, gas, and condensate here, at what rates and on what wellhead-value rules?"),
    q("well_servicing_and_equipment", "Is there a well-servicing / oilfield-services tax or sales tax on oilfield equipment and services, with what exemptions?"),
    q("environmental_fees", "What environmental/coastal/spill-protection fees attach per barrel or transfer, and who remits them?"),
    q("incentives", "What production incentives exist (stripper/high-cost/inactive-well relief, EOR credits) and what agency certification is required?"),
  ],
  telecom: [
    q("e911_fees", "What 911/emergency-service fees or surcharges apply per line/connection (wireline, wireless, VoIP, prepaid), at what amounts?"),
    q("utility_gross_receipts", "What gross-receipts assessments hit telecom/utilities (PUC assessment, state USF), at what rates and on which receipts?"),
    q("sales_tax_sourcing", "How is telecom service taxed and sourced for sales tax (mobile sourcing act, service address), and what bundles are taxable?"),
    q("registration_filing", "What telecom-specific registrations, returns, and remittance schedules apply beyond the general sales-tax return?"),
  ],
  short_term_rentals: [
    q("str_occupancy_tax", "Are short-term rentals subject to state and local occupancy taxes, at what per-day threshold and combined rates?"),
    q("platform_collection", "Must rental platforms (Airbnb/Vrbo class) collect and remit occupancy/sales tax on hosts' behalf, and what host obligations remain?"),
    q("local_registration", "What local STR registration/permit, zoning, or license rules condition operating, and which agency issues them?"),
    q("long_stay_exemption", "When does a stay become exempt (permanent-guest rule) and how is the transition handled mid-stay?"),
  ],
  marketplace: [
    q("facilitator_duty", "Must marketplace facilitators collect and remit tax on third-party sellers' sales into this jurisdiction, since when?", "Marketplace facilitator statute or agency guidance with effective date."),
    q("facilitator_definition_threshold", "How is a facilitator defined, and what sales-volume/transaction thresholds trigger the duty?"),
    q("seller_relief", "What relief, notice-and-reporting, or exclusion rules apply to underlying marketplace sellers (duplicate collection, use-tax notices)?"),
    q("remote_seller_nexus", "What economic-nexus thresholds apply to remote sellers (post-Wayfair), measured how (current/prior year, transactions count repealed?) and effective when?"),
  ],
  software_digital: [
    q("saas_taxability", "Is remotely accessed software/SaaS taxable, and under what theory (tangible property, service, digital good)?"),
    q("delivery_mode_taxability", "Does taxability of canned/custom software vary by delivery mode (physical media, download, load-and-leave, ASP)?"),
    q("digital_goods_sourcing", "How are digital goods/services sourced (user location, billing address, multiple points of use certificates)?"),
    q("b2b_and_bundling", "What business-use exemptions, resale treatment, or bundled-transaction rules apply to software sold with services/hardware?"),
  ],
  delivery: [
    q("retail_delivery_fee", "Does this jurisdiction impose a retail delivery fee/tax per delivery, at what amount and on which deliveries?", undefined, "Agency tax index + sales-tax guidance searched for a delivery fee with none found; queries recorded and verifier-confirmed."),
    q("scope_exclusions", "Which deliveries are in scope or excluded (seller's own vehicles, exempt goods, food, small-seller thresholds)?"),
    q("collection_filing", "Who collects from the buyer, is the fee separately stated, and on what return/schedule is it remitted?"),
    q("gig_logistics_charges", "How are third-party delivery/gig platform charges (delivery fees, service fees) treated in the sales-tax base?"),
  ],
};

export interface CoverageQuestionSeed {
  category: string;
  questionKey: string;
  question: string;
  evidenceRequired: string;
  absenceRequires: string;
  sortOrder: number;
}

/** Flattened, seed-ready rows for `coverage_questions` (sortOrder = 10, 20, ...). */
export const coverageQuestionsSeed: CoverageQuestionSeed[] = Object.entries(
  questionPacks,
).flatMap(([category, questions]) =>
  questions.map((item, i) => ({
    category,
    questionKey: item.questionKey,
    question: item.question,
    evidenceRequired: item.evidenceRequired ?? DEFAULT_EVIDENCE_REQUIRED,
    absenceRequires: item.absenceRequires ?? DEFAULT_ABSENCE_REQUIRES,
    sortOrder: (i + 1) * 10,
  })),
);
