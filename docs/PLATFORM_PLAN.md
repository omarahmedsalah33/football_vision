# Platform plan: player development and academy intelligence

Last updated: 2026-10-24.

The product's defining loop:

> Analyse the player → understand the evidence → set development priorities → prescribe training →
> track the work → measure the change → improve the next performance.

This document gives an assessment of what exists, the architecture and security boundaries for the
full platform (independent players and academies), the main risks, and the milestones in order.

## 1. Where the repository stands

| Area from the brief | State |
|---|---|
| Accounts, personal and club workspaces, roles, invitations, audit log | Built and tested |
| Video upload, private storage, background jobs, failure handling | Built and tested |
| Computer vision: detection, tracking, teams, fixed and moving cameras | Built; accuracy on real footage only partly measured (teams 91 % on 170 hand-labelled tracks) |
| Player reports and profiles (physical score, form, strengths/weaknesses across matches) | Built (beta) |
| **Development loop: framework, ratings, priorities, plans, drills, training log, progress** | **Built in this milestone (beta)** |
| Player ownership and consent between independent players and academies | Not started (milestone 2) |
| Academy intelligence dashboards, teams and age groups, attendance | Partly (squad list with plan status); milestone 3 |
| Scouting workspace | Not started (milestone 4) |
| AI match analyst ("Ask your match") | Not started (milestone 5) |
| Payments | Plans, limits and quotas enforced on the server; no payment provider connected (milestone 6) |
| Technical and tactical metrics from video (passes, shots, pressing) | Not possible yet: needs ball tracking and event detection (milestone 7) |

## 2. The development loop (milestone 1, built)

**Performance framework** (`web/src/lib/development/framework.ts`). 22 dimensions in four categories.
Each has a meaning, a method, its limitations and possible reasons it can be low. Two kinds of
evidence, never mixed:

- **Measured** (5 physical dimensions): computed from tracked movement and compared with the players
  in the same match. Always labelled "estimated".
- **Observed** (17 technical, tactical and defensive dimensions): 1–5 ratings by a coach or by the
  player, with fixed anchors ("2 = below what the role needs"). The video can't judge these yet, and
  the product says so. A player's own rating is always shown as a self rating.

**Priorities** (`recommend.ts`). Rule-based and reproducible, no generated text. A priority needs:
- a measured weakness ranked ≤ 35/100 across two or more matches ("strong" evidence from three), or
  ≤ 25 in a single match ("limited"); or
- a coach rating of 1–2 (a low self rating alone counts as "limited").

Each priority lists:
- the evidence, match by match, with numbers;
- possible reasons, phrased as things to check;
- drills from the library that train that dimension, simplest first;
- a measurable goal (baseline → target) and a review period.

At most three priorities of each kind are kept, so coach ratings are never crowded out by running
numbers that move together.

**Training library** (`drills.ts`). 23 starter drills covering every dimension: steps, coaching
points, three-level progressions, success criteria and safety notes. They are common coaching
exercises written up by us, not certified by a coaching body, and the UI says so. Coaches can add
their own drills. Recommendations only ever pick from this library.

**Plans.**
- **Shape:** one active plan per player, 1–3 objectives and up to 8 drills, each with sessions per
  week.
- **Built on the server:**
  - baselines come from the player's matches up to the start day, or from the latest rating;
  - drill content is copied into the plan, so a plan never changes underneath the player;
  - the client only names dimensions and drills.

**Measuring change** (`progress.ts`). Two questions, never merged:
- **Training done:** sessions logged against sessions planned, per week and in total.
- **Measured change:** follow-up evidence against the baseline.
  - Matches only count if they were played after the plan's start day; ratings only if they were made
    after the plan was created. No piece of evidence counts as both baseline and follow-up.
  - One match is "too early to judge". Changes inside measurement noise are "no clear change".
  - If minutes on camera differ a lot from the baseline matches, a warning is shown.

**Access.**

| Who | Can do |
|---|---|
| Owner, admin, coach | Prescribe and close plans; add drills (`plan.manage`, `drill.manage`) |
| Analyst | Read plans and rate players, but not prescribe training |
| Scout | No access to development plans |
| The player (profile linked to their account) | See and log their own plan, rate themselves and write reflections, whatever their role |
| Everyone else | 404 |

Active plans per workspace are limited by subscription tier (`maxActivePlans`). The limit is checked
under an advisory lock, so two simultaneous requests can't both take the last slot.

## 3. Architecture

The current stack stays: it works, it is tested, and nothing in the brief needs microservices.

- **Web:** Next.js 16 (App Router) + TypeScript. Server components read through domain services
  (`web/src/server/*/service.ts`); every change goes through `route()` (same-origin check, JSON only,
  size limits, Zod validation, safe errors) and a service that checks permissions itself.
- **Data:** PostgreSQL with Drizzle migrations. Every tenant row carries `org_id`, and every query
  filters by it.
- **Video:** private S3-compatible storage with short-lived signed links. A Python worker with leased
  jobs runs analysis in an isolated child process.
- **Entitlements:** `billing/entitlements.ts` is the only place limits are read; limits live in the
  `plans` table, so pricing can change without a deploy.
- **AI analyst (milestone 5):** a separate inference module. The model calls a fixed set of read
  functions that run under the requesting user's actor. It never runs raw SQL and never sees secrets.
  Every answer cites stored metrics and timestamps.

### Key data relationships, now and next

```
users ─< memberships >─ organizations (personal | club | academy)
organizations ─< players ─< player_labels >─ analysis_tracks (per match analysis)
players ─< player_observations          (coach / self ratings)
players ─< development_plans ─< plan_objectives
                              ─< plan_exercises ─< training_logs
                              ─< plan_comments
organizations ─< drills                  (club's own; starter library in code)

next (milestone 2):
players (personal, owned by the player) ─< player_links >─ players (academy record)
player_links: status (invited | active | revoked), scopes (profile, reports, plans), granted_by,
              guardian_consent_by (for minors), expires_at
shared_reports: token hash, scope, expiry, revoked_at
```

## 4. Security boundaries

1. **Tenant:** an organization's data is reachable only through a membership in that organization.
   Other tenants get 404, never 403, so existence isn't revealed. This is tested for every new
   service.
2. **Role:** one permission matrix (`authz/permissions.ts`). Anything not listed is denied.
3. **Object:** player-level checks on top of roles, for example a player-role member reaches only
   the plan of the profile linked to their own account.
4. **Ownership (milestone 2):** an academy never acquires a player's independent account. Sharing
   is a revocable grant made by the player (or their guardian), limited to named scopes. Revoking it
   cuts access at once, because every read checks the live grant.
5. **AI (milestone 5):** retrieval runs through the same services and actor. Stored text (notes,
   comments, drill text) is passed to the model as data, never as instructions. Answers are checked
   against the facts that were retrieved. Each workspace has a cost limit.

## 5. Main risks

| Risk | Mitigation |
|---|---|
| Measured numbers trusted beyond their accuracy | "Estimated" labels, provenance on every metric, match-relative scores, no technical metrics until measured; publish accuracy only after a SoccerTrack-style evaluation |
| Advice that harms young players (training load) | Curated drills only, safety notes, a default load of 2+1 sessions per priority, a warning above 8 sessions a week, "check with a qualified coach" wording |
| Minors' data | Birth year only; guardian consent and retention rules in milestone 2. The applicable law (e.g. Egypt's PDPL, GDPR for EU users) must be confirmed before launch |
| Academies seeing private player data | Ownership model and explicit, revocable grants (milestone 2) |
| Payment provider availability in Egypt | Decide between Paymob and Stripe (Stripe requires a supported business country). Entitlements are already provider-independent |
| AI inventing answers | Answers only from retrieved facts, with "not enough data" as a first-class answer |

## 6. Milestones

1. **Development loop**: done (this document, section 2).
2. **Player ownership and consent:** link an independent player to an academy by invitation, choose
   what is shared, revoke, leave or transfer. Guardian approval for minors, secure share links for
   reports with expiry, data export.
3. **Academy intelligence:**
   - teams and age groups, players assigned to squads and coaches;
   - "needs attention" (review due, training not done, falling form, priorities without a plan);
   - squad-wide weakness distribution and plan effectiveness (how often objectives are reached);
   - attendance and bulk assignment.
4. **Scouting:** position-specific criteria, scouting reports that separate measured, rated and
   written judgement, shortlists, authorised exports.
5. **AI match analyst:** questions answered from stored metrics with clickable timestamps; video
   playback synced to the timeline is a prerequisite.
6. **Payments:** provider integration, verified webhooks, idempotency, billing history, failed
   payments and cancellation.
7. **Computer vision:** learned pitch detection (waiting on a Roboflow API key and a dataset licence
   check), then ball tracking and event detection, so technical metrics can move from "observed" to
   "measured".
8. **Operational readiness:** run CI on GitHub, dependency and container scanning, backups and
   restore drills, monitoring and alerting, load tests.
