# FootballAnalyzer — Architecture & Delivery Plan

> Working name. Status: Phase 1/2 in progress. This document is the source of truth for
> architectural decisions; update it when a decision changes. Progress lives in
> [STATUS.md](STATUS.md).

## Decisions taken with the product owner (2026-10-23)

| Decision | Choice | Consequence |
|---|---|---|
| Footage for the first AI version | **Fixed wide camera** (tripod/elevated, most of the pitch visible) | One-time pitch calibration gives real pitch coordinates → trustworthy positions, heatmaps, shape metrics. Broadcast footage is a later track. |
| Detection model licensing | **Apache-2.0 / MIT models only** (RF-DETR / RT-DETR, ByteTrack via `supervision`) | No AGPL exposure from Ultralytics. Detector sits behind an interface so it can be swapped. |
| Payments | **Undecided** | Provider-neutral billing layer + server-side entitlements now; Stripe/Paymob adapter in Phase 5. |

---

## A. Repository assessment

- `footballanalyzer/` was **empty**: greenfield. Nothing to preserve or migrate.
- **Risk found:** the user's home directory (`C:\Users\Omar`) is itself a git repository (no commits).
  A stray `git add .` anywhere under it could stage `.ssh/`, `.claude.json`, cloud credentials.
  Mitigation applied: this project has its own repository (`git init` inside `footballanalyzer/`).
  Resolved 2026-10-23: it was empty and is renamed to `C:\Users\Omar\.git.disabled-2026-10-23`.
- Related prior work: `Desktop/sports-ai` (BJJ analyzer, Replit pnpm monorepo, Express + Clerk +
  Drizzle + GCS). Different sport and stack shape; **lessons reused, code not reused**:
  verify object size after ambiguous multipart completion; strict tenant isolation; Clerk for identity.
- Dev machine: Windows 11, Node 24.22 LTS with npm 11 (upgraded from end-of-life Node 20 on 2026-10-23),
  Python 3.13 with CUDA PyTorch, GTX 1660 Ti 6 GB (no tensor cores → run fp32), Docker Desktop.
- MinIO no longer publishes community Docker images; local object storage uses SeaweedFS.

## B. Architecture and reasoning

```
Browser ──HTTPS──▶ Next.js app (web/)  ──SQL──▶ PostgreSQL
   │                 │  • marketing site (static)        ▲
   │                 │  • authenticated app (RSC)         │ jobs table (lease + SKIP LOCKED)
   │                 │  • API route handlers              │
   │                 │  • authz + entitlements + billing  │
   │                 └─presign─▶ Object storage (S3/R2) ◀─┤
   └──── direct multipart upload (presigned, size-signed) ─┘
                                                          │
                       Python analysis worker (worker/) ──┘
                         decode → calibrate → detect → track → teams → metrics → evidence
```

| Concern | Choice | Why | Rejected alternative |
|---|---|---|---|
| Web + API | **Next.js 16 (App Router) + TypeScript**, one deployable | SEO marketing pages + app + API in one codebase; no premature microservices | Separate Express API (more infra, no benefit yet) |
| Identity | **Clerk** (keyless in dev) | Managed MFA, recovery, bot protection, session revocation; you already know it | Better Auth (self-hosted; we'd own email delivery, abuse protection) |
| Authorization | **Our own Postgres tables** (orgs, memberships, roles) checked on the server | Testable, portable, not tied to a vendor's org model | Clerk Organizations as source of truth (harder to test, vendor lock-in) |
| Database | **PostgreSQL 17 + Drizzle ORM** with SQL migrations | Relational tenant model, transactions, constraints; Drizzle is typed and you know it | Prisma (heavier runtime), Mongo (weak for relational tenancy) |
| Queue | **Postgres jobs table** with leases, heartbeats, `FOR UPDATE SKIP LOCKED` | Durable, transactional with app data (no dual-write), consumable from Python; no Redis to run | BullMQ/Redis (extra infra, Node-centric), SQS (later, if volume demands) |
| Video storage | **Private S3-compatible bucket**; prod **Cloudflare R2** recommended | R2 has no egress fees — video playback egress is the main storage cost trap on S3 | Public buckets (never) |
| Uploads | **Presigned multipart**, per-part `Content-Length` signed, server-side completion + HEAD size check + magic-byte check | Large files never pass through the web server; client cannot exceed declared size | Single PUT (no resume, 5 GB cap) |
| AI worker | **Python 3.13 service**, polls jobs, GPU optional | CV ecosystem is Python; isolates heavy, risky media parsing from the web tier | Node CV (immature) |
| Detection | **RF-DETR (Apache-2.0)** behind `Detector` interface | Commercially safe, strong accuracy | Ultralytics YOLO (AGPL) |
| Tracking | **ByteTrack** (`supervision`, MIT) behind `Tracker` interface | Robust, cheap; BoT-SORT later if ReID needed | — |
| LLM (Phase 4) | Claude via API, retrieval over **our** structured evidence only | Grounded answers; model never sees raw DB or tools with privileges | Letting the model query SQL (unsafe) |

Boundaries inside `web/src/server/`: `auth/` (identity → actor), `authz/` (permissions),
`orgs/`, `matches/`, `uploads/` + `storage/`, `jobs/`, `billing/` (plans, entitlements, usage),
`http/` (route wrapper, errors, validation). The worker owns `pipeline/` stages and never decides
authorization: it only processes jobs the web tier already authorized and enqueued.

Caching rule: tenant data is **never** placed in `use cache` / `use cache: remote`. Only public
marketing content is cached.

## C. Initial database entities

```
users (id, auth_subject UNIQUE, email, display_name, created_at, deleted_at)
organizations (id, name, slug UNIQUE, kind: personal|club|academy, created_at, deleted_at)
memberships (id, org_id→organizations, user_id→users, role, status, UNIQUE(org_id,user_id))
teams (id, org_id, name, UNIQUE(org_id,name))
matches (id, org_id, team_id?, title, opponent_name?, played_on?, camera_type, status, created_by, ...)
videos (id, org_id, match_id, storage_key UNIQUE, multipart_upload_id, declared_size_bytes,
        size_bytes, status, container/codec/duration/width/height/fps (from worker probe), ...)
analysis_jobs (id, org_id, match_id, video_id, status, stage, progress, attempts, max_attempts,
        lease_owner, lease_expires_at, heartbeat_at, run_after, cancel_requested,
        error_code, error_message, config, model_versions, usage_period_start,
        idempotency_key UNIQUE, ...)
plans (id, name, limits JSONB, active)                ← configurable without a deploy
subscriptions (org_id UNIQUE, plan_id, status, period start/end, provider, provider_ref,
               limit_overrides JSONB)
usage_periods (org_id, period_start, analyses_used, analyses_reserved, UNIQUE(org_id,period_start))
audit_events (id, org_id, actor_user_id, action, target_type, target_id, metadata, created_at)
rate_limit_buckets (key, window_start, count)        ← shared across web instances
```
Later phases: `players`, `player_track_links`, `calibrations`, `tracks` (summary rows; raw
per-frame tracks live in object storage as compressed Parquet/JSONL), `events`, `findings`
(evidence-linked), `reports`, `share_links`, `invitations`, `billing_events` (webhook idempotency).

Every tenant-owned row carries `org_id`. Every object lookup is `WHERE id = $1 AND org_id = $2`.
IDs are random UUIDs (not guessable sequences).

## D. Authentication & authorization model

- **Authentication:** Clerk session → `auth()` gives a Clerk user id. We map it to our `users`
  row (created on first sight). A personal workspace (`kind=personal`) is created for new users.
- **Authorization:** every protected server operation resolves an **Actor**
  `{userId, orgId, role}` from the *membership table*, never from client input, then calls
  `assertCan(actor, permission)`. Services receive the Actor and scope every query by
  `actor.orgId`. Resources in another org return **404** (no existence leak).
- **Roles → permissions** (least privilege, defined in one file `authz/permissions.ts`):

| Permission | owner | admin | coach | analyst | scout | player |
|---|---|---|---|---|---|---|
| org.manage, members.manage | ✓ | ✓ | | | | |
| org.delete | ✓ | | | | | |
| billing.manage | ✓ | ✓ | | | | |
| match.create / match.update / video.upload / analysis.run | ✓ | ✓ | ✓ | ✓ | | |
| match.delete | ✓ | ✓ | ✓ | | | |
| match.read / report.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| report.share | ✓ | ✓ | ✓ | ✓ | | |

  Known gap: `player` currently reads all org matches; per-team scoping comes with the
  players module (Phase 4).
- **No path-based gating:** the Clerk proxy only provides the session and CSP. Every page
  (`server/auth/page.ts`) and API route (`server/http/route.ts`) authenticates and authorizes
  itself, so access never depends on URL pattern matching.
- **CSRF:** state-changing API routes require a same-origin `Origin` header and a JSON body; the
  route wrapper checks origin → authenticates → only then parses and validates the body.
- **Sensitive actions** (org deletion, role changes, billing): Clerk reverification (Phase 2b).

## E. Threat model — top risks

| # | Threat | Impact | Mitigations |
|---|---|---|---|
| 1 | Cross-tenant access / IDOR | Club sees another club's footage | Actor from DB membership; org-scoped queries; 404 on mismatch; cross-tenant tests for every resource; Postgres RLS as later defense-in-depth |
| 2 | Malicious video exploiting decoder (FFmpeg CVEs) | Worker RCE | Decoding only in the worker; container non-root, no inbound network, CPU/mem/time limits, egress restricted to DB+storage; patched PyAV/FFmpeg; container allowlist + magic-byte check |
| 3 | Storage / GPU cost abuse | Bills, DoS | Server-chosen part count & size, signed `Content-Length`, HEAD verification, plan limits, **atomic quota reservation**, max duration, rate limits |
| 4 | Presigned URL leakage | Footage exposure | Private bucket, ≤15 min expiry, issued only after authz, server-generated keys (no user filenames) |
| 5 | Forged payment webhooks / replay | Free paid plans | Provider signature verification, idempotency table, entitlements only from server state, never from redirects |
| 6 | Prompt injection in "Ask your match" | Data exfiltration, false claims | LLM gets only server-retrieved, org-scoped, structured evidence; no privileged tools; schema-validated output; "insufficient evidence" path |
| 7 | Fabricated/overconfident AI output | Coaching decisions on false data | Metric provenance (measured / estimated / inferred / unavailable), quality gates, failed jobs never produce reports, model versions recorded |
| 8 | Account takeover | Data theft | Clerk MFA, bot protection, reverification, session revocation |
| 9 | Minors' data (academies) | Legal & ethical harm | Data minimization, guardian-consent workflow before launching to youth academies, retention limits, no biometric identification |
| 10 | Worker/DB credential compromise | Broad access | Separate least-privilege DB role for the worker, scoped storage keys, secret manager, rotation runbook |

## F. MVP vs later

**MVP (Phases 1–3):** marketing site (honest sample data), Clerk auth, personal + club
workspaces, roles, match CRUD, secure resumable upload, job queue + worker, video validation,
pitch calibration (manual 4+ points), person detection + tracking + team clustering on fixed-camera
footage, positional metrics (heatmaps, average positions, team width/depth/compactness) with
quality indicators, evidence links to timestamps, plan limits enforced server-side.

**Later:** event detection (passes, shots — needs fine-tuned/validated models and licensed
training data), jersey-number recognition, broadcast-footage support, passing networks,
"Ask your match" (Phase 4), PDF reports & share links, payments, scouting, development plans,
Postgres RLS, SSO for enterprise.

**Not claimable without new models/data:** passes/tackles/shots/xG from video, real-world player
identity, sprint speeds from uncalibrated footage. SoccerNet data is research-licensed, so it is
not usable for a commercial model without a separate agreement. SoccerTrack v2 (CC BY 4.0,
fixed full-pitch panoramic cameras, metric ground truth) is the chosen evaluation set.

## G. Phases and acceptance criteria

| Phase | Scope | Accepted when |
|---|---|---|
| 1 Foundation | repo, infra, schema, authz, design tokens, app shell | Migrations apply cleanly; permission matrix unit-tested; build passes |
| 2 Core SaaS | Clerk, workspaces, matches, multipart upload, jobs, worker validation, status UI | User A cannot read/modify org B's matches/videos/jobs (tests); oversized parts rejected by storage; quota cannot be exceeded under concurrency (test); invalid video ends `failed` with a safe message and no results |
| 3 AI slice | calibration UI, detect+track+team, metrics, evidence timeline | On ≥3 manually reviewed clips: documented detection recall, ID-switch rate, calibration error; metrics labelled with provenance |
| 4 Analytics | player/team pages, heatmaps, comparisons, grounded Q&A | Every finding links to timestamps; Q&A refuses when evidence is missing; cross-tenant retrieval test |
| 5 Commercial | provider adapter, webhooks, usage dashboard, reports & share links | Forged/replayed webhooks rejected (tests); share links expire/revoke |
| 6 Production | security review, load tests, backups+restore drill, monitoring, runbooks | Restore drill done; alerts fire; ASVS L2 checklist reviewed |

## H. External services & cost drivers

| Service | Needed for | Credentials | Cost driver |
|---|---|---|---|
| Clerk | auth | publishable + secret key (keyless in dev) | free tier, then per MAU; MFA is a paid add-on |
| PostgreSQL (Neon / RDS / Supabase) | data | connection string | ~$20–50/mo to start |
| Object storage (R2 recommended) | videos | access key/secret, bucket | ~2–6 GB per 90-min match; R2 ≈ $0.015/GB-month, no egress |
| GPU workers (Modal / RunPod / AWS g6) | analysis | API key / IAM | **largest variable cost** — to be measured per match in Phase 3; scale-to-zero |
| Hosting (Vercel or container platform) | web | deploy token | modest |
| Email (Resend/Postmark) | invitations, notifications | API key | low |
| Error tracking (Sentry) | observability | DSN | free tier |
| Anthropic API | Phase 4 Q&A, report text | API key | per token; capped per plan |
| Stripe and/or Paymob | Phase 5 | merchant account + webhook secret | % per transaction |

## I. Initial implementation task

Vertical slice "upload a match and see it validated":
signed-in user → workspace → create match → resumable upload to private storage → job enqueued
with quota reservation → Python worker claims job with a lease → validates the video → status
visible in the UI — with cross-tenant, quota, upload-size and job-idempotency tests.
