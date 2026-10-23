-- Proposed plan catalog (not final pricing). Limits live in the database so they can be tuned
-- without a deploy; application code reads them only through billing/entitlements.ts.
INSERT INTO "plans" ("id", "name", "limits") VALUES
  ('free',        'Free trial',       '{"monthlyAnalyses":1,"maxUploadBytes":6442450944,"maxVideoDurationSeconds":7800,"maxMembers":1,"maxTeams":1,"retentionDays":30}'),
  ('player_pro',  'Player Pro',       '{"monthlyAnalyses":4,"maxUploadBytes":8589934592,"maxVideoDurationSeconds":7800,"maxMembers":1,"maxTeams":1,"retentionDays":365}'),
  ('coach_pro',   'Coach Pro',        '{"monthlyAnalyses":10,"maxUploadBytes":10737418240,"maxVideoDurationSeconds":7800,"maxMembers":5,"maxTeams":3,"retentionDays":365}'),
  ('club',        'Club / Academy',   '{"monthlyAnalyses":40,"maxUploadBytes":12884901888,"maxVideoDurationSeconds":7800,"maxMembers":50,"maxTeams":20,"retentionDays":730}'),
  ('enterprise',  'Enterprise',       '{"monthlyAnalyses":40,"maxUploadBytes":12884901888,"maxVideoDurationSeconds":7800,"maxMembers":50,"maxTeams":20,"retentionDays":730}')
ON CONFLICT ("id") DO NOTHING;
