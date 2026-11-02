CREATE TYPE "public"."jurisdiction_level" AS ENUM('country', 'state', 'province', 'region', 'county', 'city', 'special_district', 'other');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('unverified', 'verified', 'needs_review');--> statement-breakpoint
CREATE TABLE "jurisdictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"level" "jurisdiction_level" NOT NULL,
	"slug" text NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"official_name" text,
	"country_code" text,
	"currency_code" text,
	"timezone" text,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_by" text,
	"http_status" integer,
	"content_hash" text,
	"changed" boolean DEFAULT false NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction_id" uuid,
	"tax_type_id" uuid,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"source_type" text DEFAULT 'agency_guidance' NOT NULL,
	"publisher" text,
	"language" text DEFAULT 'en' NOT NULL,
	"is_authoritative" boolean DEFAULT false NOT NULL,
	"monitor_cadence" text DEFAULT 'weekly' NOT NULL,
	"check_method" text DEFAULT 'content_hash' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"content_hash" text,
	"notes" text,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_compliance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_type_id" uuid NOT NULL,
	"jurisdiction_id" uuid,
	"source_id" uuid,
	"obligation_type" text DEFAULT 'return_filing' NOT NULL,
	"form_number" text,
	"form_name" text,
	"form_url" text,
	"filing_frequency" text,
	"due_date_rule" text,
	"filing_methods" text,
	"payment_methods" text,
	"efile_threshold" numeric(14, 2),
	"efile_threshold_currency" text,
	"collect_remit_summary" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"citation" text,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_type_id" uuid NOT NULL,
	"jurisdiction_id" uuid,
	"source_id" uuid,
	"name" text NOT NULL,
	"license_type" text DEFAULT 'permit' NOT NULL,
	"required_for" text,
	"issuing_agency" text,
	"application_url" text,
	"form_number" text,
	"fee_amount" numeric(14, 2),
	"fee_currency" text,
	"renewal_period" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"citation" text,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_type_id" uuid NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"source_id" uuid,
	"rate_value" numeric(14, 6) NOT NULL,
	"rate_unit" text DEFAULT 'percent' NOT NULL,
	"applies_to" text,
	"conditions" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"citation" text,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_type_id" uuid NOT NULL,
	"jurisdiction_id" uuid,
	"source_id" uuid,
	"rule_type" text DEFAULT 'other' NOT NULL,
	"authority_level" text DEFAULT 'guidance' NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"full_text" text,
	"embedding" vector(1536),
	"effective_from" date NOT NULL,
	"effective_to" date,
	"citation" text,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"description" text,
	"administering_agency" text,
	"official_url" text,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jurisdictions" ADD CONSTRAINT "jurisdictions_parent_id_jurisdictions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_checks" ADD CONSTRAINT "source_checks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_tax_type_id_tax_types_id_fk" FOREIGN KEY ("tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_compliance" ADD CONSTRAINT "tax_compliance_tax_type_id_tax_types_id_fk" FOREIGN KEY ("tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_compliance" ADD CONSTRAINT "tax_compliance_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_compliance" ADD CONSTRAINT "tax_compliance_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_licenses" ADD CONSTRAINT "tax_licenses_tax_type_id_tax_types_id_fk" FOREIGN KEY ("tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_licenses" ADD CONSTRAINT "tax_licenses_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_licenses" ADD CONSTRAINT "tax_licenses_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tax_type_id_tax_types_id_fk" FOREIGN KEY ("tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_tax_type_id_tax_types_id_fk" FOREIGN KEY ("tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_types" ADD CONSTRAINT "tax_types_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jurisdictions_slug_idx" ON "jurisdictions" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "jurisdictions_parent_idx" ON "jurisdictions" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "jurisdictions_level_idx" ON "jurisdictions" USING btree ("level");--> statement-breakpoint
CREATE INDEX "source_checks_source_idx" ON "source_checks" USING btree ("source_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_url_idx" ON "sources" USING btree ("url");--> statement-breakpoint
CREATE INDEX "sources_tax_type_idx" ON "sources" USING btree ("tax_type_id");--> statement-breakpoint
CREATE INDEX "sources_jurisdiction_idx" ON "sources" USING btree ("jurisdiction_id");--> statement-breakpoint
CREATE INDEX "sources_due_idx" ON "sources" USING btree ("status","monitor_cadence","last_checked_at");--> statement-breakpoint
CREATE INDEX "tax_compliance_tax_type_idx" ON "tax_compliance" USING btree ("tax_type_id");--> statement-breakpoint
CREATE INDEX "tax_licenses_tax_type_idx" ON "tax_licenses" USING btree ("tax_type_id");--> statement-breakpoint
CREATE INDEX "tax_rates_lookup_idx" ON "tax_rates" USING btree ("tax_type_id","jurisdiction_id","effective_from");--> statement-breakpoint
CREATE INDEX "tax_rates_jurisdiction_idx" ON "tax_rates" USING btree ("jurisdiction_id");--> statement-breakpoint
CREATE INDEX "tax_rules_tax_type_idx" ON "tax_rules" USING btree ("tax_type_id","rule_type");--> statement-breakpoint
CREATE INDEX "tax_rules_jurisdiction_idx" ON "tax_rules" USING btree ("jurisdiction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_types_slug_idx" ON "tax_types" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tax_types_jurisdiction_idx" ON "tax_types" USING btree ("jurisdiction_id");--> statement-breakpoint
CREATE INDEX "tax_types_category_idx" ON "tax_types" USING btree ("category");