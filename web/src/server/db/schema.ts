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

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Subject identifier from the identity provider (Clerk user id). Never trusted from the client.
  authSubject: text("auth_subject").notNull().unique(),
  email: text("email"),
  displayName: text("display_name"),
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
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
  },
  (t) => [
    index("videos_org_match_idx").on(t.orgId, t.matchId),
    check("videos_declared_size_positive", sql`${t.declaredSizeBytes} > 0`),
    check("videos_part_count_range", sql`${t.partCount} between 1 and 10000`),
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
  },
  (t) => [uniqueIndex("analysis_tracks_job_track_uq").on(t.jobId, t.trackNo), index("analysis_tracks_org_idx").on(t.orgId)],
);
