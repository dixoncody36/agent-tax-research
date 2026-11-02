CREATE SCHEMA "reporting";
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_run_id" uuid,
	"agent_run_id" uuid,
	"jurisdiction_id" uuid,
	"source_id" uuid,
	"exception_type" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"detail" text,
	"resolution" text,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"target_table" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"citation" text,
	"source_id" uuid,
	"snapshot_id" uuid,
	"verdict" text DEFAULT 'pending' NOT NULL,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_run_id" uuid,
	"jurisdiction_id" uuid NOT NULL,
	"tax_type_id" uuid,
	"status" text DEFAULT 'proposed' NOT NULL,
	"extractor_run_id" uuid,
	"verifier_run_id" uuid,
	"approved_by" text,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_type_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_tax_type_id" uuid NOT NULL,
	"to_tax_type_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"source_id" uuid,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"citation" text,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "publisher_type" text DEFAULT 'government' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "eligibility" text DEFAULT 'eligible' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "exclusion_reason" text;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_scope_run_id_scope_runs_id_fk" FOREIGN KEY ("scope_run_id") REFERENCES "public"."scope_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_scope_run_id_scope_runs_id_fk" FOREIGN KEY ("scope_run_id") REFERENCES "public"."scope_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_tax_type_id_tax_types_id_fk" FOREIGN KEY ("tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_extractor_run_id_agent_runs_id_fk" FOREIGN KEY ("extractor_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_verifier_run_id_agent_runs_id_fk" FOREIGN KEY ("verifier_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_type_relationships" ADD CONSTRAINT "tax_type_relationships_from_tax_type_id_tax_types_id_fk" FOREIGN KEY ("from_tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_type_relationships" ADD CONSTRAINT "tax_type_relationships_to_tax_type_id_tax_types_id_fk" FOREIGN KEY ("to_tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_type_relationships" ADD CONSTRAINT "tax_type_relationships_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exceptions_open_idx" ON "exceptions" USING btree ("status","jurisdiction_id");--> statement-breakpoint
CREATE INDEX "proposal_items_proposal_idx" ON "proposal_items" USING btree ("proposal_id","verdict");--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" USING btree ("status","jurisdiction_id");--> statement-breakpoint
CREATE INDEX "run_events_run_idx" ON "run_events" USING btree ("agent_run_id","created_at");--> statement-breakpoint
CREATE INDEX "tax_type_relationships_from_idx" ON "tax_type_relationships" USING btree ("from_tax_type_id","relationship_type");--> statement-breakpoint
CREATE VIEW "reporting"."coverage_by_jurisdiction" AS (select "jurisdiction_id", "status", count(*) as "answers" from "coverage_answers" group by "coverage_answers"."jurisdiction_id", "coverage_answers"."status");--> statement-breakpoint
CREATE VIEW "reporting"."current_rates" AS (select "tax_type_id", "jurisdiction_id", "rate_value", "rate_unit", "applies_to", "effective_from", "effective_to", "verification_status" from "tax_rates" where "tax_rates"."effective_from" <= current_date and ("tax_rates"."effective_to" is null or "tax_rates"."effective_to" >= current_date));--> statement-breakpoint
CREATE VIEW "reporting"."open_exceptions" AS (select "id", "jurisdiction_id", "exception_type", "severity", "detail", "created_at" from "exceptions" where "exceptions"."status" = 'open');--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_ineligible_pass() RETURNS trigger AS $$
DECLARE elig text;
BEGIN
  IF NEW.verdict = 'pass' THEN
    SELECT eligibility INTO elig FROM sources WHERE id = NEW.source_id;
    IF NEW.source_id IS NULL OR elig IS DISTINCT FROM 'eligible' THEN
      RAISE EXCEPTION 'publish gate: verdict=pass requires an eligible source citation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER proposal_items_eligible_gate BEFORE INSERT OR UPDATE ON proposal_items FOR EACH ROW EXECUTE FUNCTION reject_ineligible_pass();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_self_approval() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('approved','published') THEN
    IF NEW.approved_by IS NULL OR NEW.approved_by = NEW.extractor_run_id::text OR NEW.approved_by = NEW.verifier_run_id::text THEN
      RAISE EXCEPTION 'publish gate: approver must be distinct from extractor and verifier';
    END IF;
  END IF;
  IF NEW.verifier_run_id IS NOT NULL AND NEW.verifier_run_id = NEW.extractor_run_id THEN
    RAISE EXCEPTION 'publish gate: verifier must differ from extractor';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER proposals_distinct_hands_gate BEFORE INSERT OR UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION reject_self_approval();