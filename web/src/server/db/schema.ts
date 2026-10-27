import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Every tenant-owned table carries org_id. Every lookup of a tenant-owned row must filter by it.

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const orgKind = pgEnum("org_kind", ["personal", "club", "academy"]);
export const memberRole = pgEnum("member_role", ["owner", "admin", "coach", "analyst", "scout", "player"]);
export const membershipStatus = pgEnum("membership_status", ["active", "suspended"]);
export const cameraType = pgEnum("camera_type", ["fixed_wide", "broadcast", "handheld"]);
export const videoStatus = pgEnum("video_status", ["uploading", "uploaded", "validated", "rejected", "aborted", "purged"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "cancelled"]);
// prepare: validate the upload and extract reference frames (free). analyze: computer vision (counted).
export const jobKind = pgEnum("job_kind", ["prepare", "analyze"]);
export const subscriptionStatus = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "expired",
]);

// How someone uses the product, chosen at onboarding; shapes their home and navigation only.
export const persona = pgEnum("persona", ["player", "coach", "club", "scout", "parent"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Subject identifier from the identity provider (Clerk user id). Never trusted from the client.
  authSubject: text("auth_subject").notNull().unique(),
  email: text("email"),
  displayName: text("display_name"),
  persona: persona("persona"),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  kind: orgKind("kind").notNull(),
  // Set only for personal workspaces; the unique constraint guarantees one per user even under
  // concurrent first sign-ins.
  personalOwnerId: uuid("personal_owner_id")
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    status: membershipStatus("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId), index("memberships_user_idx").on(t.userId)],
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("teams_org_name_uq").on(t.orgId, t.name)],
);

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    opponentName: text("opponent_name"),
    sevenAside: jsonb("seven_a_side").$type<import("../../lib/seven-a-side").SevenAsideExperience>(),
    playedOn: date("played_on"),
    cameraType: cameraType("camera_type").notNull().default("fixed_wide"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("matches_org_created_idx").on(t.orgId, t.createdAt)],
);

export const videos = pgTable(
  "videos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    // Server-generated; never derived from the client filename.
    storageKey: text("storage_key").notNull().unique(),
    multipartUploadId: text("multipart_upload_id"),
    // Display only. Sanitized; never used for paths or content-type decisions.
    originalFilename: text("original_filename"),
    declaredSizeBytes: bigint("declared_size_bytes", { mode: "number" }).notNull(),
    partSizeBytes: integer("part_size_bytes").notNull(),
    partCount: integer("part_count").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    status: videoStatus("status").notNull().default("uploading"),
    // Filled by the worker's probe, not by the client.
    container: text("container"),
    videoCodec: text("video_codec"),
    durationSeconds: real("duration_seconds"),
    width: integer("width"),
    height: integer("height"),
    fps: real("fps"),
    rejectionReason: text("rejection_reason"),
    // Reference frames extracted by the prepare job: [{ key, timeSeconds, width, height }].
    frames: jsonb("frames").notNull().default([]),
    // Set by the prepare job: "fixed", "moving" (pans/zooms: auto-tracking or broadcast) or "unknown".
    cameraMotion: text("camera_motion"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
  },
  (t) => [
    index("videos_org_match_idx").on(t.orgId, t.matchId),
    check("videos_declared_size_positive", sql`${t.declaredSizeBytes} > 0`),
    check("videos_part_count_range", sql`${t.partCount} between 1 and 10000`),
    check("videos_camera_motion_values", sql`${t.cameraMotion} is null or ${t.cameraMotion} in ('fixed', 'moving', 'unknown')`),
  ],
);

export const analysisJobs = pgTable(
  "analysis_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    kind: jobKind("kind").notNull(),
    // One analysis per video unless explicitly re-run with a new key.
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: jobStatus("status").notNull().default("queued"),
    stage: text("stage"),
    progress: real("progress").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    // Stable machine-readable code plus a message that is safe to show to users.
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    config: jsonb("config").notNull().default({}),
    modelVersions: jsonb("model_versions").notNull().default({}),
    // The usage period whose reservation this job holds; settled exactly once on completion.
    // Null for prepare jobs, which are not counted.
    usagePeriodStart: date("usage_period_start"),
    usageSettled: boolean("usage_settled").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("analysis_jobs_claim_idx").on(t.status, t.runAfter),
    index("analysis_jobs_org_match_idx").on(t.orgId, t.matchId),
    // At most one active analysis per video, enforced by the database under concurrency.
    uniqueIndex("analysis_jobs_one_active_per_video_kind")
      .on(t.videoId, t.kind)
      .where(sql`${t.status} in ('queued', 'running')`),
    check(
      "analysis_jobs_usage_period_for_analyze",
      sql`${t.kind} = 'prepare' or ${t.usagePeriodStart} is not null`,
    ),
    check("analysis_jobs_progress_range", sql`${t.progress} between 0 and 1`),
  ],
);

export const plans = pgTable("plans", {
  id: text("id").primaryKey(), // e.g. "free", "player_pro"
  name: text("name").notNull(),
  limits: jsonb("limits").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: "cascade" }),
  planId: text("plan_id")
    .notNull()
    .references(() => plans.id),
  status: subscriptionStatus("status").notNull(),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  provider: text("provider"), // null until a payment provider is connected
  providerRef: text("provider_ref"),
  // Negotiated enterprise limits; merged over plan limits.
  limitOverrides: jsonb("limit_overrides").notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const usagePeriods = pgTable(
  "usage_periods",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    analysesUsed: integer("analyses_used").notNull().default(0),
    analysesReserved: integer("analyses_reserved").notNull().default(0),
  },
  (t) => [
    uniqueIndex("usage_periods_org_period_uq").on(t.orgId, t.periodStart),
    check("usage_periods_non_negative", sql`${t.analysesUsed} >= 0 and ${t.analysesReserved} >= 0`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_org_created_idx").on(t.orgId, t.createdAt)],
);

// Fixed-window counters shared by all web instances (unlike in-memory limiters).
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});

export const contactTopic = pgEnum("contact_topic", ["sales", "support", "partnership", "privacy", "other"]);

// Messages from the public contact form. Deliberately no IP address or user agent (minimisation).
export const contactMessages = pgTable(
  "contact_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    organization: text("organization"),
    topic: contactTopic("topic").notNull(),
    message: text("message").notNull(),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("contact_messages_created_idx").on(t.createdAt)],
);

// Invitations to join a workspace. Only a SHA-256 hash of the token is stored; the token itself
// is shown once to the inviter and travels only in the invitation link.
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRole("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_org_idx").on(t.orgId, t.createdAt)],
);

// Idempotency for inbound webhooks (identity provider now, payment provider later): a delivery
// whose id is already recorded is acknowledged without being processed again.
export const processedWebhooks = pgTable("processed_webhooks", {
  id: text("id").primaryKey(), // provider-namespaced delivery id, e.g. "clerk:msg_..."
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Pitch calibration: landmarks clicked on a reference frame, mapped to pitch metres (105 × 68).
export const calibrations = pgTable(
  "calibrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),
    // [{ landmark, image: [x, y], pitch: [x, y] }], image coordinates in source-video pixels.
    points: jsonb("points").notNull(),
    // Row-major 3 × 3 matrix mapping image pixels to pitch metres.
    homography: jsonb("homography").notNull(),
    imageWidth: integer("image_width").notNull(),
    imageHeight: integer("image_height").notNull(),
    // Root-mean-square distance (metres) between clicked landmarks and where the homography puts them.
    rmsErrorM: real("rms_error_m").notNull(),
    // Leave-one-out error: how far each landmark lands when it is not used to fit. Null below 5 points.
    looErrorM: real("loo_error_m"),
    // The reference frame the points were clicked on. A moving camera needs all points on one frame,
    // and the worker starts following the camera from it.
    frameTimeSeconds: real("frame_time_seconds"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("calibrations_video_idx").on(t.orgId, t.videoId, t.createdAt)],
);

// Results of a succeeded analyze job. Written in the same transaction that marks the job
// succeeded, so a failed or cancelled job never leaves results behind.
export const analysisResults = pgTable("analysis_results", {
  jobId: uuid("job_id")
    .primaryKey()
    .references(() => analysisJobs.id, { onDelete: "cascade" }),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  matchId: uuid("match_id")
    .notNull()
    .references(() => matches.id, { onDelete: "cascade" }),
  calibrationId: uuid("calibration_id").references(() => calibrations.id, { onDelete: "set null" }),
  // Quality indicators, team-shape timeline and metric provenance (see worker/fa_worker/analysis).
  summary: jsonb("summary").notNull(),
  // Object-storage key of the full per-frame tracks (gzip JSON lines).
  tracksKey: text("tracks_key"),
  createdAt: createdAt(),
});

// "a" defends the left goal (x = 0) when first seen, "b" the right; "other" = referees and unclear
// tracks. Which team is "yours" is a user decision, never guessed from video.
export const trackTeam = pgEnum("track_team", ["a", "b", "other"]);

// One row per tracked person in an analysis run.
export const analysisTracks = pgTable(
  "analysis_tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => analysisJobs.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    trackNo: integer("track_no").notNull(),
    team: trackTeam("team").notNull(),
    firstSeconds: real("first_seconds").notNull(),
    lastSeconds: real("last_seconds").notNull(),
    // Share of sampled frames between first and last sighting where the track was observed.
    coverage: real("coverage").notNull(),
    avgX: real("avg_x"),
    avgY: real("avg_y"),
    // Estimated: sum of smoothed displacements; affected by tracking gaps and calibration error.
    distanceM: real("distance_m"),
    // Occupancy counts on a 21 × 14 grid of 5 m cells (row-major, y then x).
    heatmap: jsonb("heatmap").notNull(),
    // Running profile (estimated): minutes, distance, high-intensity distance, sprints, top speed,
    // late-vs-early work rate, and how many track fragments were joined into this player.
    metrics: jsonb("metrics").notNull().default({}),
    // Private photo of the player for staff to recognise them; deleted with the footage.
    cropKey: text("crop_key"),
  },
  (t) => [uniqueIndex("analysis_tracks_job_track_uq").on(t.jobId, t.trackNo), index("analysis_tracks_org_idx").on(t.orgId)],
);

export const playerPosition = pgEnum("player_position", ["goalkeeper", "defender", "midfielder", "forward"]);
export const preferredFoot = pgEnum("preferred_foot", ["left", "right", "both"]);

// A player profile: a squad member in a club, or the user themself in a personal workspace. Stats
// come from analyses where a tracked player was linked to the profile. Data is kept minimal
// (birth year, not date of birth): many players are minors.
export const players = pgTable(
  "players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // The account this profile belongs to ("me"), if any.
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    position: playerPosition("position"),
    preferredFoot: preferredFoot("preferred_foot"),
    shirtNumber: integer("shirt_number"),
    birthYear: integer("birth_year"),
    clubName: text("club_name"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("players_org_idx").on(t.orgId),
    uniqueIndex("players_org_user_uq").on(t.orgId, t.userId).where(sql`${t.userId} is not null`),
    check("players_name_length", sql`char_length(${t.name}) between 1 and 60`),
    check("players_shirt_range", sql`${t.shirtNumber} is null or ${t.shirtNumber} between 0 and 99`),
    check("players_birth_year_range", sql`${t.birthYear} is null or ${t.birthYear} between 1940 and 2030`),
    check("players_club_length", sql`${t.clubName} is null or char_length(${t.clubName}) between 1 and 80`),
  ],
);

// Names and shirt numbers staff give to tracked players in one analysis, and the player profile
// a tracked player is linked to.
export const playerLabels = pgTable(
  "player_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => analysisJobs.id, { onDelete: "cascade" }),
    trackNo: integer("track_no").notNull(),
    name: text("name"),
    shirtNumber: integer("shirt_number"),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("player_labels_job_track_uq").on(t.jobId, t.trackNo),
    index("player_labels_org_idx").on(t.orgId),
    index("player_labels_player_idx").on(t.playerId),
    check("player_labels_shirt_range", sql`${t.shirtNumber} is null or ${t.shirtNumber} between 0 and 99`),
    check("player_labels_name_length", sql`${t.name} is null or char_length(${t.name}) between 1 and 60`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Player development: observations, the training library, development plans and training logs.
// Dimension keys and drill content are validated in code (lib/development); the database keeps
// them as text and jsonb so the framework can grow without a migration.

export const observationSource = pgEnum("observation_source", ["coach", "self"]);

// A 1–5 rating of one dimension by a coach or by the player, kept apart from anything measured.
export const playerObservations = pgTable(
  "player_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    rating: integer("rating").notNull(),
    note: text("note"),
    source: observationSource("source").notNull(),
    matchId: uuid("match_id").references(() => matches.id, { onDelete: "set null" }),
    observedOn: date("observed_on").notNull(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("player_observations_player_idx").on(t.playerId, t.observedOn),
    index("player_observations_org_idx").on(t.orgId),
    check("player_observations_rating_range", sql`${t.rating} between 1 and 5`),
    check("player_observations_note_length", sql`${t.note} is null or char_length(${t.note}) <= 500`),
  ],
);

// Drills a workspace's coaches wrote. The starter library lives in code.
export const drills = pgTable(
  "drills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    content: jsonb("content").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("drills_org_idx").on(t.orgId)],
);

export const planStatus = pgEnum("plan_status", ["active", "completed", "archived"]);
export const objectiveKind = pgEnum("objective_kind", ["measured", "observed"]);

export const developmentPlans = pgTable(
  "development_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: planStatus("status").notNull().default("active"),
    startsOn: date("starts_on").notNull(),
    reviewOn: date("review_on").notNull(),
    closingNote: text("closing_note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("development_plans_org_status_idx").on(t.orgId, t.status),
    index("development_plans_player_idx").on(t.playerId),
    // One plan at a time per player: a short list of priorities works better than several plans.
    uniqueIndex("development_plans_one_active_uq").on(t.playerId).where(sql`${t.status} = 'active'`),
    check("development_plans_title_length", sql`char_length(${t.title}) between 1 and 80`),
    check("development_plans_note_length", sql`${t.closingNote} is null or char_length(${t.closingNote}) <= 1000`),
    check("development_plans_dates", sql`${t.reviewOn} >= ${t.startsOn}`),
  ],
);

// What the plan should change, with the baseline captured when the plan was made.
export const planObjectives = pgTable(
  "plan_objectives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => developmentPlans.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    dimension: text("dimension").notNull(),
    kind: objectiveKind("kind").notNull(),
    metric: text("metric"),
    baseline: real("baseline"),
    baselineMatches: integer("baseline_matches"),
    baselineMinutes: real("baseline_minutes"),
    target: real("target"),
    finding: text("finding").notNull(),
    evidence: jsonb("evidence").notNull().default([]),
  },
  (t) => [index("plan_objectives_plan_idx").on(t.planId), check("plan_objectives_metric_kind", sql`(${t.kind} = 'measured') = (${t.metric} is not null)`)],
);

// A drill in a plan, copied at the time it was prescribed so the plan never changes underneath.
export const planExercises = pgTable(
  "plan_exercises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => developmentPlans.id, { onDelete: "cascade" }),
    objectiveId: uuid("objective_id").references(() => planObjectives.id, { onDelete: "set null" }),
    position: integer("position").notNull(),
    drillKey: text("drill_key").notNull(),
    drill: jsonb("drill").notNull(),
    sessionsPerWeek: integer("sessions_per_week").notNull(),
  },
  (t) => [index("plan_exercises_plan_idx").on(t.planId), check("plan_exercises_per_week_range", sql`${t.sessionsPerWeek} between 1 and 7`)],
);

export const trainingLogs = pgTable(
  "training_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => developmentPlans.id, { onDelete: "cascade" }),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => planExercises.id, { onDelete: "cascade" }),
    doneOn: date("done_on").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    effort: integer("effort"),
    note: text("note"),
    loggedBy: uuid("logged_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("training_logs_plan_idx").on(t.planId, t.doneOn),
    check("training_logs_duration_range", sql`${t.durationMinutes} between 1 and 240`),
    check("training_logs_effort_range", sql`${t.effort} is null or ${t.effort} between 1 and 10`),
    check("training_logs_note_length", sql`${t.note} is null or char_length(${t.note}) <= 500`),
  ],
);

export const commentAuthorKind = pgEnum("comment_author_kind", ["coach", "player"]);

// Coach feedback and player reflections on a plan.
export const planComments = pgTable(
  "plan_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => developmentPlans.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    authorKind: commentAuthorKind("author_kind").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("plan_comments_plan_idx").on(t.planId, t.createdAt), check("plan_comments_body_length", sql`char_length(${t.body}) between 1 and 1000`)],
);
