CREATE TYPE "public"."job_kind" AS ENUM('prepare', 'analyze');--> statement-breakpoint
CREATE TYPE "public"."track_team" AS ENUM('a', 'b', 'other');--> statement-breakpoint
CREATE TABLE "analysis_results" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"calibration_id" uuid,
	"summary" jsonb NOT NULL,
	"tracks_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"track_no" integer NOT NULL,
	"team" "track_team" NOT NULL,
	"first_seconds" real NOT NULL,
	"last_seconds" real NOT NULL,
	"coverage" real NOT NULL,
	"avg_x" real,
	"avg_y" real,
	"distance_m" real,
	"heatmap" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"points" jsonb NOT NULL,
	"homography" jsonb NOT NULL,
	"image_width" integer NOT NULL,
	"image_height" integer NOT NULL,
	"rms_error_m" real NOT NULL,
	"loo_error_m" real,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "analysis_jobs_one_active_per_video";--> statement-breakpoint
ALTER TABLE "analysis_jobs" ALTER COLUMN "usage_period_start" DROP NOT NULL;--> statement-breakpoint
-- Every job created before job kinds existed was a validation (prepare) job.
ALTER TABLE "analysis_jobs" ADD COLUMN "kind" "job_kind" NOT NULL DEFAULT 'prepare';--> statement-breakpoint
ALTER TABLE "analysis_jobs" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "frames" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_job_id_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."analysis_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_calibration_id_calibrations_id_fk" FOREIGN KEY ("calibration_id") REFERENCES "public"."calibrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_tracks" ADD CONSTRAINT "analysis_tracks_job_id_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."analysis_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_tracks" ADD CONSTRAINT "analysis_tracks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibrations" ADD CONSTRAINT "calibrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibrations" ADD CONSTRAINT "calibrations_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibrations" ADD CONSTRAINT "calibrations_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibrations" ADD CONSTRAINT "calibrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_tracks_job_track_uq" ON "analysis_tracks" USING btree ("job_id","track_no");--> statement-breakpoint
CREATE INDEX "analysis_tracks_org_idx" ON "analysis_tracks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "calibrations_video_idx" ON "calibrations" USING btree ("org_id","video_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_jobs_one_active_per_video_kind" ON "analysis_jobs" USING btree ("video_id","kind") WHERE "analysis_jobs"."status" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_usage_period_for_analyze" CHECK ("analysis_jobs"."kind" = 'prepare' or "analysis_jobs"."usage_period_start" is not null);