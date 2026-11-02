ALTER TABLE "agent_runs" ADD COLUMN "tokens_in" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "tokens_out" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cost_usd" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;