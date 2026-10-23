# Status

Last updated: 2026-10-23.

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
| Pitch calibration | Landmark catalogue for any pitch size; normalised-DLT homography (shared browser/server code); fit and leave-one-out error; >3 m rejected naming the worst landmark; UI with live pitch-line overlay, zoom, keyboard nudging | `homography.test.ts` (exact recovery, noise, misplaced click), `calibration.test.ts`, E2E calibration by clicks |
| Analysis pipeline | RF-DETR (Apache-2.0, tiled) → ByteTrack (`trackers`, Apache-2.0) → foot-point projection → shirt-colour teams (referees kept out) → per-track and team-shape metrics with provenance and quality gates; runs in a child process with progress, cancel and timeout | `test_metrics.py`, `test_analysis.py` (synthetic match: positions ≤ 0.75 m, width ≤ 1 m, distance ≤ 15 %), real RF-DETR smoke test on a CC photo, E2E analysis on GPU |
| Results UI | Reliability panel, team shape over time (small multiples, crosshair tooltip, gaps for insufficient evidence, table view), average positions, heatmap, track table, provenance on every metric, honest empty state | E2E + manual visual QA with synthetic results |
| Evaluation harness | SoccerTrack v2 loader (streams 2.7 GB files, handles the shipped-vs-documented schema differences), oracle calibration, recall/precision/localisation/team accuracy/ID switches/width error | `test_eval.py`; **not run on real data yet** — see `docs/evaluation/` |
| Staff testing plan | `internal` plan (not sold, not billed) assigned by `scripts/grant-plan.mts` with an audit event | applied to omarahmedsalah33@gmail.com's workspace |
| CI | GitHub Actions: web check + audit, worker tests + pip-audit, optional E2E | written and YAML-validated; **not run yet** (no GitHub remote) |

Latest full run (2026-10-23): web 105 unit/integration tests, worker 57, browser 20 (all
first-try, including a real RF-DETR analysis on the GPU), production build passing; worker
`pip-audit` clean after upgrading Pillow to 13 (12.3 had 35 CVEs).

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
