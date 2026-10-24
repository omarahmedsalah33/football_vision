CREATE TYPE "public"."comment_author_kind" AS ENUM('coach', 'player');--> statement-breakpoint
CREATE TYPE "public"."objective_kind" AS ENUM('measured', 'observed');--> statement-breakpoint
CREATE TYPE "public"."observation_source" AS ENUM('coach', 'self');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('active', 'completed', 'archived');--> statement-breakpoint
CREATE TABLE "development_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "plan_status" DEFAULT 'active' NOT NULL,
	"starts_on" date NOT NULL,
	"review_on" date NOT NULL,
	"closing_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "development_plans_title_length" CHECK (char_length("development_plans"."title") between 1 and 80),
	CONSTRAINT "development_plans_note_length" CHECK ("development_plans"."closing_note" is null or char_length("development_plans"."closing_note") <= 1000),
	CONSTRAINT "development_plans_dates" CHECK ("development_plans"."review_on" >= "development_plans"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "drills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plan_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"author_id" uuid,
	"author_kind" "comment_author_kind" NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_comments_body_length" CHECK (char_length("plan_comments"."body") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "plan_exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"objective_id" uuid,
	"position" integer NOT NULL,
	"drill_key" text NOT NULL,
	"drill" jsonb NOT NULL,
	"sessions_per_week" integer NOT NULL,
	CONSTRAINT "plan_exercises_per_week_range" CHECK ("plan_exercises"."sessions_per_week" between 1 and 7)
);
--> statement-breakpoint
CREATE TABLE "plan_objectives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"dimension" text NOT NULL,
	"kind" "objective_kind" NOT NULL,
	"metric" text,
	"baseline" real,
	"baseline_matches" integer,
	"baseline_minutes" real,
	"target" real,
	"finding" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "plan_objectives_metric_kind" CHECK (("plan_objectives"."kind" = 'measured') = ("plan_objectives"."metric" is not null))
);
--> statement-breakpoint
CREATE TABLE "player_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"rating" integer NOT NULL,
	"note" text,
	"source" "observation_source" NOT NULL,
	"match_id" uuid,
	"observed_on" date NOT NULL,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_observations_rating_range" CHECK ("player_observations"."rating" between 1 and 5),
	CONSTRAINT "player_observations_note_length" CHECK ("player_observations"."note" is null or char_length("player_observations"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "training_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"done_on" date NOT NULL,
	"duration_minutes" integer NOT NULL,
	"effort" integer,
	"note" text,
	"logged_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_logs_duration_range" CHECK ("training_logs"."duration_minutes" between 1 and 240),
	CONSTRAINT "training_logs_effort_range" CHECK ("training_logs"."effort" is null or "training_logs"."effort" between 1 and 10),
	CONSTRAINT "training_logs_note_length" CHECK ("training_logs"."note" is null or char_length("training_logs"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drills" ADD CONSTRAINT "drills_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drills" ADD CONSTRAINT "drills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_comments" ADD CONSTRAINT "plan_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_comments" ADD CONSTRAINT "plan_comments_plan_id_development_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."development_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_comments" ADD CONSTRAINT "plan_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_exercises" ADD CONSTRAINT "plan_exercises_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_exercises" ADD CONSTRAINT "plan_exercises_plan_id_development_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."development_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_exercises" ADD CONSTRAINT "plan_exercises_objective_id_plan_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."plan_objectives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_objectives" ADD CONSTRAINT "plan_objectives_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_objectives" ADD CONSTRAINT "plan_objectives_plan_id_development_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."development_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_observations" ADD CONSTRAINT "player_observations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_observations" ADD CONSTRAINT "player_observations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_observations" ADD CONSTRAINT "player_observations_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_observations" ADD CONSTRAINT "player_observations_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_logs" ADD CONSTRAINT "training_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_logs" ADD CONSTRAINT "training_logs_plan_id_development_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."development_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_logs" ADD CONSTRAINT "training_logs_exercise_id_plan_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."plan_exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_logs" ADD CONSTRAINT "training_logs_logged_by_users_id_fk" FOREIGN KEY ("logged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "development_plans_org_status_idx" ON "development_plans" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "development_plans_player_idx" ON "development_plans" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "development_plans_one_active_uq" ON "development_plans" USING btree ("player_id") WHERE "development_plans"."status" = 'active';--> statement-breakpoint
CREATE INDEX "drills_org_idx" ON "drills" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "plan_comments_plan_idx" ON "plan_comments" USING btree ("plan_id","created_at");--> statement-breakpoint
CREATE INDEX "plan_exercises_plan_idx" ON "plan_exercises" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "plan_objectives_plan_idx" ON "plan_objectives" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "player_observations_player_idx" ON "player_observations" USING btree ("player_id","observed_on");--> statement-breakpoint
CREATE INDEX "player_observations_org_idx" ON "player_observations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "training_logs_plan_idx" ON "training_logs" USING btree ("plan_id","done_on");--> statement-breakpoint
-- Development plans per workspace that can be active at once (proposed tiers, not final pricing).
UPDATE "plans" SET "limits" = "limits" || jsonb_build_object('maxActivePlans', CASE "id"
  WHEN 'free' THEN 1
  WHEN 'player_pro' THEN 3
  WHEN 'coach_pro' THEN 40
  WHEN 'club' THEN 400
  WHEN 'enterprise' THEN 2000
  WHEN 'internal' THEN 100000
  ELSE 1 END);
