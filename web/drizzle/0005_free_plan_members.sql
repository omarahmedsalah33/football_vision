-- Free trial: allow a club to try team features (owner + two invitees). Limits stay configurable.
UPDATE "plans" SET "limits" = jsonb_set("limits", '{maxMembers}', '3') WHERE "id" = 'free';
