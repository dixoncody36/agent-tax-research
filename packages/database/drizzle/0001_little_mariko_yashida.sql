CREATE TYPE "public"."agent_role" AS ENUM('orchestrator', 'fetch', 'decision', 'reviewer');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_run_id" uuid,
	"role" "agent_role" NOT NULL,
	"model" text,
	"jurisdiction_id" uuid,
	"tax_type_id" uuid,
	"unit" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"handoff_notes" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"tax_type_id" uuid,
	"question_key" text NOT NULL,
	"determination" text,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"snapshot_hash" text,
	"validated_by_run_id" uuid,
	"validated_at" timestamp with time zone,
	"invalidated_reason" text,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scope_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_name" text NOT NULL,
	"root_jurisdiction_id" uuid,
	"scope_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"goal_ref" text,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_scope_run_id_scope_runs_id_fk" FOREIGN KEY ("scope_run_id") REFERENCES "public"."scope_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tax_type_id_tax_types_id_fk" FOREIGN KEY ("tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_ledger" ADD CONSTRAINT "research_ledger_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_ledger" ADD CONSTRAINT "research_ledger_tax_type_id_tax_types_id_fk" FOREIGN KEY ("tax_type_id") REFERENCES "public"."tax_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_ledger" ADD CONSTRAINT "research_ledger_validated_by_run_id_agent_runs_id_fk" FOREIGN KEY ("validated_by_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_runs" ADD CONSTRAINT "scope_runs_root_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("root_jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_assignment_idx" ON "agent_runs" USING btree ("jurisdiction_id","tax_type_id","role");--> statement-breakpoint
CREATE INDEX "agent_runs_scope_idx" ON "agent_runs" USING btree ("scope_run_id","status");--> statement-breakpoint
CREATE INDEX "research_ledger_check_idx" ON "research_ledger" USING btree ("jurisdiction_id","tax_type_id","question_key","status");--> statement-breakpoint
CREATE INDEX "scope_runs_status_idx" ON "scope_runs" USING btree ("status");