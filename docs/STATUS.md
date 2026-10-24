# Status

Last updated: 2026-10-24.

| Phase | State |
|---|---|
| 1 Foundation | Done |
| 2 Core SaaS | **Done** (email delivery for invitations not connected; links are shared manually) |
| 3 First AI slice | **Built and verified on synthetic ground truth; real-footage accuracy not yet measured** (needs SoccerTrack v2 access) |
| 4 Analytics | Not started |
| 5 Commercial | Plans, limits and usage enforced; payment provider not connected (provider undecided) |
| 6 Production readiness | Partly: strict CSP, CI pipeline (not yet run), startup migration check |

## Working and tested

| Area | What exists | Evidence |
|---|---|---|
| Data model | 19 tables, every tenant row carries `org_id`, constraints, 8 migrations | rebuilt from migrations on every test run |
| Authorization | Actor from DB membership; 6 roles; one permission matrix; 404 for other tenants | `permissions.test.ts`, `tenancy.test.ts` (mutation-checked) |
| Workspaces | Personal workspace on first sign-in (race-safe), club/academy workspaces, switcher, rename, delete (owner, typed name, recent sign-in) | `tenancy.test.ts`, `org-settings.test.ts` |
| Members & invitations | Invite links (single use, 7 days, email-bound, hash-only storage), role changes, remove, leave; admins can't touch owners; last owner can't be removed (row lock); invitations count toward member limit | `members.test.ts` (12 tests; last-owner race mutation-checked with 20 concurrent races), `e2e/team.spec.ts` with two real users |
| Account deletion | Shows impact first; blocks while sole owner of a club with members; erases name/email; deleted accounts can't sign back in; requires sign-in within 10 min; deletes the Clerk user | `account.test.ts`, `e2e/team.spec.ts` (confirms deletion at Clerk) |
| Clerk webhook | Signature-verified (`user.deleted`, `user.updated`), replay-safe via `processed_webhooks`; sole-owner deletion hands ownership to the longest-standing admin | `account.test.ts`: forged, tampered, stale and replayed deliveries |
| Retention & purge | Footage deleted after the plan's retention period; abandoned uploads aborted after 24 h; deleted matches/workspaces purged after 7 days; storage deleted before DB is updated; one sweeper at a time | `worker/tests/test_maintenance.py` (7 tests) |
| Audit log | Workspace, member, match and account events, written in the same transaction as the change; visible to owners/admins | `members.test.ts`, `org-settings.test.ts`, E2E |
| Usage dashboard | Plan, analyses this month (incl. in progress), members, stored footage | `org-settings.test.ts`, E2E |
| Uploads | Presigned multipart with signed part sizes, size + magic-byte checks, idempotent completion, retention date set | `uploads.test.ts` against real S3-compatible storage |
| Quota | Atomic reservation; one active job per video (unique index) | `quota.test.ts` (mutation-checked) |
| Job queue & worker | Leases, heartbeats, `SKIP LOCKED`, fencing, retries, reaper, cancel; isolated time-limited video probe | `worker/tests` (37 tests, fencing mutation-checked) |
| HTTP layer | Origin check, authenticate before validation, JSON only, size limits, safe errors, DB-backed rate limits, public variant for forms | `route.test.ts`, `rate-limit.test.ts` |
| Content Security Policy | Strict nonce + `'strict-dynamic'`; partial prerendering off (can't carry nonces) | E2E checks headers, nonce freshness, nonce on every script |
| Marketing site | Landing, solutions, pricing (limits from the enforced plan table), docs (roles table generated from the matrix), FAQ, about, contact, **draft** privacy/terms/AI limitations, sitemap, robots | `e2e/marketing.spec.ts`: axe WCAG 2.1 AA (zero serious/critical; scanner proven on an injected failure), links, pricing = DB, contact stored |
| Startup safety | Production refuses to start when DB migrations lag the build | `migrations.test.ts` |
| Job kinds | Free **prepare** job (validate + 3 reference frames, decoded in the isolated probe) and counted **analyze** job; one active job per video and kind | `test_pipeline.py`, `quota.test.ts`, `status.test.ts` |
| Pitch calibration | **Guided flow**: pick the pitch type (11, 9, 7/8 or 5/6-a-side; small-sided pitches use corners and halfway points only), then click one point at a time on a pitch drawing, skip points you can't see, plain-language accuracy ("Great: accurate to about 0.4 m"), confirm the green lines by eye; reuse the calibration of an earlier match from the same camera spot. Server: at least 5 points (so a wrong click can't hide), mirrored or behind-the-camera fits rejected, >3 m rejected naming the worst landmark | `homography.test.ts` (exact recovery, noise, misplaced click, mirrored, behind camera, formats), `calibration.test.ts` (5-point minimum, small-sided rules, reuse limited to own workspace and live matches; plausibility mutation-checked), E2E guided calibration incl. skip, pick on drawing and pitch-type switch |
| Match deletion | Owners and admins only (button with confirmation; server checks again); cancels a queued analysis and returns the reserved allowance, stops a running one; footage purged after 7 days | `tenancy.test.ts` (roles, queued/running jobs; mutation-checked), E2E delete flow |
| Analysis pipeline | RF-DETR (Apache-2.0, tiled) → ByteTrack (`trackers`, Apache-2.0) → foot-point projection → shirt-colour teams (referees kept out) → per-track and team-shape metrics with provenance and quality gates (thresholds follow players per side: 8 of 11, 4 of 5); runs in a child process with progress, cancel and timeout | `test_metrics.py`, `test_analysis.py` (synthetic match: positions ≤ 0.75 m, width ≤ 1 m, distance ≤ 15 %), real RF-DETR smoke test on a CC photo, E2E analysis on GPU |
| Moving cameras (beta) | Auto-tracking and broadcast cameras that pan, tilt and zoom from one spot. The upload check labels each video fixed / moving (8 reference frames compared). The user calibrates one frame; the worker follows the camera (ORB features, keyframe bank with depth so drift is discarded when a view returns, matching only static scenery), checks every placement against the white lines on the grass (lines along and across the pitch scored separately; refined against the lines when slightly off), refuses frames it can't confirm (cuts, replays, close-ups; first frame after a cut waits for the next to confirm), and tracks players on a top-down pitch canvas so camera motion doesn't break identities. Positions from moving cameras are always "estimated"; the reliability panel shows the share of the video followed. Calibrations made before this (points across frames) are flagged and must be redone | `test_camera.py` (synthetic pan/zoom: median 0.16 m, 95 % < 0.7 m; cut: no positions during it; wrong placements rejected; drift refined), `test_analysis_moving.py` (full analysis: ≥ 95 % followed, median position error < 0.5 m; upload check labels moving/fixed; old calibration fails with a clear message), `calibration.test.ts`. **Real footage:** on a broadcast highlights clip it followed only the continuous shot containing the calibrated frame (5 %) with the drawn lines on the real lines, and refused every other shot; no real auto-tracking footage tested yet |
| Team separation | Shirt colour from each player's clearest sighting (largest, nobody overlapping); over-clustered into up to 6 colour groups; groups seldom seen several at once (referees, goalkeepers) set aside; the rest split into two teams; players far from their team's colour left as "other" | `test_metrics.py` (officials in team-like colours, shade, the "most different colours" failure); real footage: 91 % of 125 assigned players right on 170 hand-labelled tracks (previous method 89 %), 17/17 on an analysed shot where the previous method assigned 3 of 20 |
| Automatic pitch calibration (experimental, not used yet) | `fa_worker/analysis/autocalib.py`: searches a physical camera (position, aim, zoom) so the drawn pitch lines land on the white lines detected on the grass and explain them, loose-to-tight matching, line refinement; confident only when the lines match closely in both directions, explain the detected lines, and pin positions down everywhere on the visible grass. **Status:** on synthetic frames, confident answers within 1.2 m (most within 0.15 m) and unclear views declined; on real broadcast frames, not yet confident (one midfield frame was fitted almost perfectly in one configuration, a goal-area close-up roughly); on the XbotGo small-sided night pitch it fails (partial outline, unknown pitch size, camera at an end). Not connected to the product until it is reliable on real footage | `test_autocalib.py` (confident ⇒ accurate; unclear view declined; no lines ⇒ not attempted) |
| Player profiles (beta) | Onboarding by persona (player, coach, club, scout, parent, or skip); a player's own profile in their personal workspace (one per person), squad profiles in clubs; name, position, foot, shirt number, birth year only, club; tracked players linked per analysis ("This is me", link to squad player, add new); profile built from the latest succeeded analysis of each live match: average score (minutes-weighted), form chart, top speed with match, distance and sprints per match, high-intensity m/min, average rank per score component, strengths/weaknesses that hold across matches (at most 3 each, form first), heatmap across matches oriented attacking right, match log; plan and allowance shown to the player. `player.manage` for owner/admin/coach/analyst; all queries scoped to the workspace; audit events | `player-profile.test.ts`, `player-profiles.test.ts` (permissions, validation, tenancy incl. cross-club links, one "me" profile, latest-analysis rule, deleted matches, unlink), `e2e/player-onboarding.spec.ts` (new Clerk user → welcome → profile → "This is me" → profile filled, axe), `e2e/players.spec.ts` |
| Development plans (beta) | Performance framework of 22 dimensions (5 measured from video, 17 rated 1–5 by a coach or the player), each with meaning, method, limitations and possible reasons; priorities from measured weaknesses across matches and low coach ratings (evidence per match, confidence, reasons, drills, measurable goal; at most 3 of each kind); 23-drill starter library, each with an animated step-by-step diagram (consistency-checked: known players, points inside the area, ball present), + club drills (`drill.manage`); one active plan per player with 1–3 objectives, baselines computed on the server from matches up to the start day or the latest rating, drill content copied into the plan; training log (date, minutes, effort, reflection), coach feedback and player reflections; progress keeps training done and measured change apart, counts only matches after the start day and ratings after the plan was made, "too early" with one match, noise thresholds, minutes caveat; active plans limited per tier (`maxActivePlans`, advisory lock). `plan.manage` owner/admin/coach, `plan.read` + `observation.write` for analysts, players reach only their own plan (object-level check), others get 404 | `development.test.ts` (framework, library coverage, priorities, baselines, follow-up rules, planned sessions), `test/integration/development.test.ts` (8: server baselines, validation, roles, tenancy, concurrent plan limit, player logging and reflections, progress and history, coach ratings, club drills), `e2e/development.spec.ts` (new player → priorities → plan → log → reflection → self rating → home card → library; axe) |
| Player reports (beta) | Track fragments of the same person joined (same team, reachable at running pace, refused when two continuations are equally likely); per player: minutes on camera, distance, high-intensity distance (> 20 km/h), sprints (> 25 km/h for ≥ 1 s), top speed (best 1-second average), late-vs-early work rate; a private photo per player for staff to recognise them (purged with the footage). Web: **physical score out of 100** = average of percentile ranks among comparable outfield players in the same match (work rate, high-intensity running, top speed, sprints, stamina); goalkeepers, officials, players seen too briefly and matches with < 4 comparable players are not scored, with the reason shown; strengths/weaknesses each quote their number; staff add names and shirt numbers. Goals, assists, shots, passes are shown as not measured | `test_stitch.py` (joins, ambiguity, teams, officials; profile recovers known speeds and stamina), `test_analysis.py` (a player missed for 3 s is still one player; profiles and photos stored), `test_maintenance.py` (photos purged), `player-report.test.ts`, `players.test.ts` (naming permissions and tenancy), `e2e/players.spec.ts` (seeded results: cards, scores, report, axe, naming) |
| Automatic start | Saving the pitch calibration starts the analysis for roles allowed to run one; if it can't start (quota), the reason is shown and the button remains | E2E journey (queued without pressing Start) |
| Results UI | Reliability panel, team shape over time (small multiples, crosshair tooltip, gaps for insufficient evidence, table view), average positions, heatmap, track table, provenance on every metric, honest empty state | E2E + manual visual QA with synthetic results |
| Evaluation harness | SoccerTrack v2 loader (streams 2.7 GB files, handles the shipped-vs-documented schema differences), oracle calibration, recall/precision/localisation/team accuracy/ID switches/width error | `test_eval.py`; **not run on real data yet** — see `docs/evaluation/` |
| Staff testing plan | `internal` plan (not sold, not billed) assigned by `scripts/grant-plan.mts` with an audit event | applied to omarahmedsalah33@gmail.com's workspace |
| CI | GitHub Actions: web check + audit, worker tests + pip-audit, optional E2E | written and YAML-validated; **not run yet** (no GitHub remote) |

Latest run (2026-10-24): web 159 unit/integration tests, worker 90, production build passing; all 24
browser tests passing (journey with a real RF-DETR analysis on the GPU, new player onboarding and
profile, development plan loop with drill diagrams and signed-in public pages, player reports and squad linking, team flows, marketing site). Worker `pip-audit`
clean after upgrading Pillow to 13 (12.3 had 35 CVEs).

## Not done yet (prioritised)

1. **Measure real accuracy (Phase 3 exit criterion):** run `fa_worker.eval.soccertrack` on the
   SoccerTrack v2 validation/test matches once the dataset is accessible; publish the numbers in
   `docs/evaluation/` and only then describe accuracy anywhere in the product.
2. **Phase 4:** analytics UI (heatmaps, team shape, timeline, video playback), player profiles,
   "Ask your match" grounded in stored evidence, per-team scoping for the player role.
3. **Phase 5:** payment provider adapter + verified, idempotent payment webhooks; PDF reports and
   expiring share links; email delivery (invitations, notifications).
4. **Phase 6:** container images (non-root, read-only), least-privilege DB role for the worker,
   deployment + environments, backups with a restore drill, monitoring/alerting, runbooks.

## Known limitations and technical debt

- **Accuracy on real football is unmeasured.** Pipeline logic is verified on synthetic truth only.
- **Processing speed** (GTX 1660 Ti, fp32, RF-DETR Medium, 4 tiles of a 1920×1280 frame): about
  0.4 s per frame, i.e. ~2.5 h for a 90-minute match at 4 sampled fps. Production needs a cloud GPU
  with tensor cores (and FP16) and a measured choice of model size / tiling / sample rate.
- **Moving cameras are beta and unproven on real auto-tracking footage.** Verified on synthetic
  pan/zoom footage and on one broadcast clip (only the calibrated shot is followed). A camera that is
  carried around, or one with strong lens distortion, can't be followed. Broadcast highlights are a
  series of shots: only the shot containing the calibrated frame is analysed.
- **The physical score is relative and running-only.** It compares players within one match and
  includes no ball events; a 90 means "ran more and faster than most players in this match", not
  "played well". Speeds come from tracking at 4 samples per second and are estimates.
- **No goals, assists, shots or passes yet** (needs ball tracking). Player names are typed by staff.
- **Team separation is about 91 % right on real footage** (170 hand-labelled broadcast tracks), and
  17 of 17 on a 6-second analysed shot. Goalkeepers are left as "other" (their kit differs from the
  team's), so they don't appear in team metrics or player cards yet.
- Pure homography: lens distortion of wide/panoramic cameras is not modelled; it shows up as
  calibration error (reported) and position error away from the clicked landmarks.
- The detector finds all people; spectators and substitutes are removed only by the on-pitch filter,
  referees and goalkeepers only by colour clustering ("other"). Identity switches split players
  into several tracks (reported as "tracks per expected person").
- Teams are named A (defends left when first seen) and B; users can't yet mark which one is theirs.
- `pip-audit` cannot check the CUDA builds of PyTorch (not on PyPI); track PyTorch advisories manually.
- Invitation emails are not sent automatically (no email provider yet); the inviter copies the link.
- Free plan raised to 3 members (owner + 2) so clubs can try team features; limits stay in the DB.
- Server-side calls to Clerk (first sign-in, invitation acceptance) have no explicit timeout; slow
  Clerk responses make those requests slow.
- `player` role can read every match in the workspace (no per-team scoping yet).
- Uploads cannot resume after a page reload (needs S3 `ListParts`).
- Usage periods are UTC calendar months, not billing-cycle anchored.
- Rate limits are fixed-window; IP-based limits only on the public contact form.
- Dev-only `npm audit` advisories (ESLint `braces`, drizzle-kit's esbuild); production: 0.
- E2E tests share the dev database and the Clerk dev instance (test users `e2e+clerk_test@…`).
- Windows time sync on this PC is broken: the clock drifted 8.8 s and broke Clerk sign-in. It was
  corrected by hand on 2026-10-23; automatic sync still needs fixing (Settings → Time → Sync now).

## Manual configuration required from you

- Claim the temporary Clerk dev app (`npx clerk auth login` in `web/`) or create your own.
- To enable the Clerk webhook: in the Clerk dashboard add an endpoint for
  `https://<your-domain>/api/webhooks/clerk` (events `user.deleted`, `user.updated`) and set
  `CLERK_WEBHOOK_SIGNING_SECRET` in the environment.
- Phase 3 data: accept the access conditions for **SoccerTrack v2** at
  huggingface.co/datasets/atomscott/soccertrack-v2 and create a read token (CC BY 4.0, commercial
  use with attribution; cite arXiv 2508.01802).
- Legal: have the privacy policy and terms reviewed (Egypt PDPL, Law No. 151 of 2020) and fill in
  the bracketed company details.
