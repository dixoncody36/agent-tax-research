CREATE TABLE "operator_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_slug" text NOT NULL,
	"name" text NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"category_id" uuid,
	"classification_status" text DEFAULT 'unclassified' NOT NULL,
	"classified_by_run_id" uuid,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"definition" text,
	"classification_facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_tax_treatments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"tax_type_id" uuid NOT NULL,
	"source_id" uuid,
	"treatment" text NOT NULL,
	"taxable_fraction" numeric(5, 4),
	"summary" text,
	"sourcing_rule" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"citation" text,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_products" ADD CONSTRAINT "operator_products_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_id_product_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_tax_treatments" ADD CONSTRAINT "product_tax_treatments_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_tax_treatments" ADD CONSTRAINT "product_tax_treatments_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_tax_treatments" ADD CONSTRAINT "product_tax_treatments_tax_type_id_tax_types_id_fk" FOREIGN KEY ("tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_tax_treatments" ADD CONSTRAINT "product_tax_treatments_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_products_profile_idx" ON "operator_products" USING btree ("profile_slug","classification_status");--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_slug_idx" ON "product_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "product_categories_parent_idx" ON "product_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "product_treatments_lookup_idx" ON "product_tax_treatments" USING btree ("category_id","jurisdiction_id","tax_type_id");--> statement-breakpoint
CREATE VIEW "reporting"."product_treatments_current" AS (select "category_id", "jurisdiction_id", "tax_type_id", "treatment", "taxable_fraction", "summary", "sourcing_rule", "effective_from", "effective_to", "verification_status" from "product_tax_treatments" where "product_tax_treatments"."effective_from" <= current_date and ("product_tax_treatments"."effective_to" is null or "product_tax_treatments"."effective_to" >= current_date));