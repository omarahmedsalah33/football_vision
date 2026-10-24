CREATE TYPE "public"."persona" AS ENUM('player', 'coach', 'club', 'scout', 'parent');--> statement-breakpoint
CREATE TYPE "public"."player_position" AS ENUM('goalkeeper', 'defender', 'midfielder', 'forward');--> statement-breakpoint
CREATE TYPE "public"."preferred_foot" AS ENUM('left', 'right', 'both');--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"position" "player_position",
	"preferred_foot" "preferred_foot",
	"shirt_number" integer,
	"birth_year" integer,
	"club_name" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "players_name_length" CHECK (char_length("players"."name") between 1 and 60),
	CONSTRAINT "players_shirt_range" CHECK ("players"."shirt_number" is null or "players"."shirt_number" between 0 and 99),
	CONSTRAINT "players_birth_year_range" CHECK ("players"."birth_year" is null or "players"."birth_year" between 1940 and 2030),
	CONSTRAINT "players_club_length" CHECK ("players"."club_name" is null or char_length("players"."club_name") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "player_labels" ADD COLUMN "player_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "persona" "persona";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "players_org_idx" ON "players" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_org_user_uq" ON "players" USING btree ("org_id","user_id") WHERE "players"."user_id" is not null;--> statement-breakpoint
ALTER TABLE "player_labels" ADD CONSTRAINT "player_labels_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_labels_player_idx" ON "player_labels" USING btree ("player_id");