CREATE TABLE "coverage_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"tax_type_id" uuid,
	"question_key" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"answer" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"answered_by_run_id" uuid,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coverage_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text NOT NULL,
	"question_key" text NOT NULL,
	"question" text NOT NULL,
	"evidence_required" text,
	"absence_requires" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jurisdiction_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"guidance" text NOT NULL,
	"memory" text,
	"author" text NOT NULL,
	"approved_by" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"retrieved_text" text,
	"fetched_by_run_id" uuid,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coverage_answers" ADD CONSTRAINT "coverage_answers_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_answers" ADD CONSTRAINT "coverage_answers_tax_type_id_tax_types_id_fk" FOREIGN KEY ("tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_answers" ADD CONSTRAINT "coverage_answers_answered_by_run_id_agent_runs_id_fk" FOREIGN KEY ("answered_by_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jurisdiction_context" ADD CONSTRAINT "jurisdiction_context_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_fetched_by_run_id_agent_runs_id_fk" FOREIGN KEY ("fetched_by_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coverage_answers_check_idx" ON "coverage_answers" USING btree ("jurisdiction_id","tax_type_id","question_key");--> statement-breakpoint
CREATE INDEX "coverage_answers_status_idx" ON "coverage_answers" USING btree ("jurisdiction_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "coverage_questions_category_key_idx" ON "coverage_questions" USING btree ("category","question_key");--> statement-breakpoint
CREATE INDEX "coverage_questions_category_idx" ON "coverage_questions" USING btree ("category","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "jurisdiction_context_version_idx" ON "jurisdiction_context" USING btree ("jurisdiction_id","version");--> statement-breakpoint
CREATE INDEX "jurisdiction_context_active_idx" ON "jurisdiction_context" USING btree ("jurisdiction_id","status");--> statement-breakpoint
CREATE INDEX "source_snapshots_source_idx" ON "source_snapshots" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "source_snapshots_hash_idx" ON "source_snapshots" USING btree ("content_hash");