-- Internal plan for the team's own testing: effectively unlimited, never sold, never billed.
-- Assigned only with scripts/grant-plan.mts (which writes an audit event). Not shown on /pricing.
INSERT INTO "plans" ("id", "name", "limits", "active") VALUES
  ('internal', 'Internal (staff testing)', '{"monthlyAnalyses":100000,"maxUploadBytes":53687091200,"maxVideoDurationSeconds":14400,"maxMembers":1000,"maxTeams":1000,"retentionDays":3650}', true)
ON CONFLICT ("id") DO NOTHING;
