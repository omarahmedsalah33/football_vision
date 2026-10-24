CREATE TABLE "player_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"track_no" integer NOT NULL,
	"name" text,
	"shirt_number" integer,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_labels_shirt_range" CHECK ("player_labels"."shirt_number" is null or "player_labels"."shirt_number" between 0 and 99),
	CONSTRAINT "player_labels_name_length" CHECK ("player_labels"."name" is null or char_length("player_labels"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "analysis_tracks" ADD COLUMN "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_tracks" ADD COLUMN "crop_key" text;--> statement-breakpoint
ALTER TABLE "player_labels" ADD CONSTRAINT "player_labels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_labels" ADD CONSTRAINT "player_labels_job_id_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."analysis_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_labels" ADD CONSTRAINT "player_labels_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_labels_job_track_uq" ON "player_labels" USING btree ("job_id","track_no");--> statement-breakpoint
CREATE INDEX "player_labels_org_idx" ON "player_labels" USING btree ("org_id");