CREATE TABLE "jurisdiction_geo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"source_id" uuid,
	"geo_kind" text DEFAULT 'boundary' NOT NULL,
	"centroid_lat" numeric(9, 6),
	"centroid_lng" numeric(9, 6),
	"min_lat" numeric(9, 6),
	"max_lat" numeric(9, 6),
	"min_lng" numeric(9, 6),
	"max_lng" numeric(9, 6),
	"boundary_geojson" jsonb,
	"geometry_hash" text,
	"simplification" text,
	"precision" text DEFAULT 'published' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"citation" text,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"datavalues" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jurisdiction_geo" ADD CONSTRAINT "jurisdiction_geo_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jurisdiction_geo" ADD CONSTRAINT "jurisdiction_geo_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jurisdiction_geo_jurisdiction_idx" ON "jurisdiction_geo" USING btree ("jurisdiction_id","effective_from");--> statement-breakpoint
CREATE INDEX "jurisdiction_geo_bbox_idx" ON "jurisdiction_geo" USING btree ("min_lat","max_lat","min_lng","max_lng");--> statement-breakpoint
CREATE VIEW "reporting"."current_geo" AS (select "jurisdiction_id", "geo_kind", "centroid_lat", "centroid_lng", "min_lat", "max_lat", "min_lng", "max_lng", "geometry_hash", "precision", "effective_from", "effective_to", "verification_status" from "jurisdiction_geo" where "jurisdiction_geo"."effective_from" <= current_date and ("jurisdiction_geo"."effective_to" is null or "jurisdiction_geo"."effective_to" >= current_date));