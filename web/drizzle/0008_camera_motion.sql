ALTER TABLE "calibrations" ADD COLUMN "frame_time_seconds" real;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "camera_motion" text;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_camera_motion_values" CHECK ("videos"."camera_motion" is null or "videos"."camera_motion" in ('fixed', 'moving', 'unknown'));