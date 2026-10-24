/**
 * Player development: observations, the training library, plans, training logs and comments.
 *
 * Access is decided per player profile, on the server:
 * - staff with `plan.read` see every plan in their workspace; `plan.manage` creates and closes them;
 * - the player themself (profile linked to their account) sees and logs their own plan, rates
 *   themself ("self" ratings) and writes reflections, whatever their role;
 * - anyone else gets 404, so a plan's existence is never revealed.
 * Baselines, evidence and drill content are always computed or copied on the server; the client
 * only says which dimensions and drills to use.
 */
import { and, asc, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { PlayerProfileStats } from "@/lib/analysis/player-profile";
import { DIMENSION_KEYS, dimensionByKey, type MetricKey } from "@/lib/development/framework";
import { drillSchema, STARTER_DRILLS, type Drill, type DrillContent } from "@/lib/development/drills";
import { defaultTarget, formatMetric, measuredBaseline, objectiveProgress, sessionsPlanned, weekStart, type Progress } from "@/lib/development/progress";
import { recommend, type Observation, type Priority } from "@/lib/development/recommend";
import { recordAudit } from "../audit";
import { assertCan, can, type Actor } from "../authz/permissions";
import { getEntitlements } from "../billing/entitlements";
import type { DbOrTx } from "../db/client";
import { developmentPlans, drills, matches, planComments, planExercises, planObjectives, playerObservations, players, trainingLogs } from "../db/schema";
import { conflict, forbidden, invalidInput, notFound, quotaExceeded } from "../http/errors";
import { profileStats } from "../players/service";

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-24.");

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw invalidInput(r.error.issues[0]?.message ?? "Check the details.");
  return r.data;
}

// ---------------------------------------------------------------------------------------------
// Access

export type PlayerAccess = {
  player: typeof players.$inferSelect;
  /** The signed-in user is this player. */
  self: boolean;
  staff: boolean;
  canManage: boolean;
  canLog: boolean;
  canRateAsCoach: boolean;
};

export async function playerAccess(db: DbOrTx, actor: Actor, playerId: string): Promise<PlayerAccess> {
  const [player] = await db.select().from(players).where(and(eq(players.id, playerId), eq(players.orgId, actor.orgId), isNull(players.archivedAt)));
  if (!player) throw notFound("Player");
  const self = player.userId === actor.userId;
  const staff = can(actor.role, "plan.read");
  if (!self && !staff) throw notFound("Player");
  const canManage = can(actor.role, "plan.manage");
  return { player, self, staff, canManage, canLog: canManage || self, canRateAsCoach: !self && can(actor.role, "observation.write") };
}

async function planAccess(db: DbOrTx, actor: Actor, planId: string) {
  const [plan] = await db.select().from(developmentPlans).where(and(eq(developmentPlans.id, planId), eq(developmentPlans.orgId, actor.orgId)));
  if (!plan) throw notFound("Plan");
  try {
    return { plan, access: await playerAccess(db, actor, plan.playerId) };
  } catch {
    throw notFound("Plan");
  }
}

// ---------------------------------------------------------------------------------------------
// Training library

export async function library(db: DbOrTx, actor: Actor): Promise<Drill[]> {
  const rows = await db
    .select({ id: drills.id, content: drills.content })
    .from(drills)
    .where(and(eq(drills.orgId, actor.orgId), isNull(drills.archivedAt)))
    .orderBy(desc(drills.createdAt));
  const custom = rows.flatMap((r) => {
    const c = drillSchema.safeParse(r.content);
    return c.success ? [{ ...c.data, key: r.id, source: "custom" as const }] : [];
  });
  return [...custom, ...STARTER_DRILLS];
}

const MAX_CUSTOM_DRILLS = 500;

export async function createDrill(db: DbOrTx, actor: Actor, raw: unknown) {
  assertCan(actor, "drill.manage");
  const content: DrillContent = parse(drillSchema, raw);
  return db.transaction(async (tx) => {
    const [{ n }] = await tx.select({ n: count() }).from(drills).where(and(eq(drills.orgId, actor.orgId), isNull(drills.archivedAt)));
    if (n >= MAX_CUSTOM_DRILLS) throw conflict(`A workspace can keep up to ${MAX_CUSTOM_DRILLS} of its own drills.`);
    const [row] = await tx.insert(drills).values({ orgId: actor.orgId, content, createdBy: actor.userId }).returning({ id: drills.id });
    await recordAudit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "drill.created", targetType: "drill", targetId: row.id });
    return { key: row.id };
  });
}

export async function archiveDrill(db: DbOrTx, actor: Actor, drillId: string) {
  assertCan(actor, "drill.manage");
  await db.transaction(async (tx) => {
    const done = await tx
      .update(drills)
      .set({ archivedAt: new Date() })
      .where(and(eq(drills.id, drillId), eq(drills.orgId, actor.orgId), isNull(drills.archivedAt)))
      .returning({ id: drills.id });
    if (!done.length) throw notFound("Drill");
    await recordAudit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "drill.archived", targetType: "drill", targetId: drillId });
  });
}

// ---------------------------------------------------------------------------------------------
// Observations (1–5 ratings)

const OBSERVED_KEYS = DIMENSION_KEYS.filter((k) => dimensionByKey.get(k)?.source === "observed") as [string, ...string[]];

export const observationInput = z.object({
  dimension: z.enum(OBSERVED_KEYS, "Pick something that is rated, not measured from video."),
  rating: z.number().int().min(1).max(5),
  note: z.string().trim().max(500).nullable().default(null).transform((v) => v || null),
  matchId: z.uuid().nullable().default(null),
  observedOn: isoDate.optional(),
});

export async function addObservation(db: DbOrTx, actor: Actor, playerId: string, raw: unknown, now = new Date()) {
  const input = parse(observationInput, raw);
  const access = await playerAccess(db, actor, playerId);
  if (!access.self && !access.canRateAsCoach) throw forbidden();
  const today = todayUtc(now);
  const observedOn = input.observedOn ?? today;
  if (observedOn > today || observedOn < "2000-01-01") throw invalidInput("Check the date.");
  if (input.matchId) {
    const [m] = await db.select({ id: matches.id }).from(matches).where(and(eq(matches.id, input.matchId), eq(matches.orgId, actor.orgId), isNull(matches.deletedAt)));
    if (!m) throw notFound("Match");
  }
  const [row] = await db
    .insert(playerObservations)
    .values({ orgId: actor.orgId, playerId, dimension: input.dimension, rating: input.rating, note: input.note, source: access.self ? "self" : "coach", matchId: input.matchId, observedOn, authorId: actor.userId })
    .returning();
  return row;
}

async function observationsOf(db: DbOrTx, actor: Actor, playerId: string): Promise<Observation[]> {
  const rows = await db
    .select()
    .from(playerObservations)
    .where(and(eq(playerObservations.orgId, actor.orgId), eq(playerObservations.playerId, playerId)))
    .orderBy(asc(playerObservations.observedOn), asc(playerObservations.createdAt));
  return rows.map((r) => ({ dimension: r.dimension, rating: r.rating, source: r.source, on: r.observedOn, at: r.createdAt.toISOString(), note: r.note }));
}

// ---------------------------------------------------------------------------------------------
// Plans

export const planInput = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    reviewOn: isoDate,
    objectives: z
      .array(z.object({ dimension: z.enum(DIMENSION_KEYS), target: z.number().finite().positive().nullable().default(null) }))
      .min(1, "Pick at least one thing to work on.")
      .max(3, "Keep it to three priorities at most."),
    exercises: z
      .array(z.object({ drillKey: z.string().min(1).max(80), dimension: z.enum(DIMENSION_KEYS), sessionsPerWeek: z.number().int().min(1).max(7) }))
      .min(1, "Add at least one drill.")
      .max(8, "Up to eight drills per plan."),
  })
  .refine((v) => new Set(v.objectives.map((o) => o.dimension)).size === v.objectives.length, "Each priority can only be picked once.")
  .refine((v) => v.exercises.every((e) => v.objectives.some((o) => o.dimension === e.dimension)), "Every drill must belong to one of the priorities.");
export type PlanInput = z.input<typeof planInput>;

async function evidenceFor(db: DbOrTx, actor: Actor, access: PlayerAccess) {
  const stats = (await profileStats(db, actor, [access.player.id])).get(access.player.id)!.stats;
  const observations = await observationsOf(db, actor, access.player.id);
  const lib = await library(db, actor);
  const priorities = recommend(stats, observations, lib, { goalkeeper: access.player.position === "goalkeeper" });
  return { stats, observations, lib, priorities };
}

export async function createPlan(db: DbOrTx, actor: Actor, playerId: string, raw: unknown, now = new Date()) {
  assertCan(actor, "plan.manage");
  const input = parse(planInput, raw);
  const access = await playerAccess(db, actor, playerId);
  const today = todayUtc(now);
  if (input.reviewOn < addDays(today, 7) || input.reviewOn > addDays(today, 120)) throw invalidInput("Set the review between one week and four months from today.");
  const { stats, observations, lib, priorities } = await evidenceFor(db, actor, access);
  const libByKey = new Map(lib.map((d) => [d.key, d]));

  const objectives = input.objectives.map((o, position) => {
    const d = dimensionByKey.get(o.dimension)!;
    const p = priorities.find((x) => x.dimension === o.dimension);
    if (d.source === "measured") {
      const metric = d.metric as MetricKey;
      const base = measuredBaseline(stats.matches, metric, today);
      if (!base) throw invalidInput(`No analysed match measures ${d.label.toLowerCase()} yet, so there is no baseline to improve on.`);
      const target = o.target ?? defaultTarget(metric, base.value);
      if (target <= base.value) throw invalidInput(`Set the ${d.label.toLowerCase()} target above the baseline (${formatMetric(metric, base.value)}).`);
      return {
        position,
        dimension: d.key,
        kind: "measured" as const,
        metric,
        baseline: base.value,
        baselineMatches: base.matches,
        baselineMinutes: base.minutes,
        target,
        finding: p?.finding ?? `${d.label}: baseline ${formatMetric(metric, base.value)} over ${base.matches} ${base.matches === 1 ? "match" : "matches"}.`,
        evidence: p?.evidence ?? [],
      };
    }
    const mine = observations.filter((x) => x.dimension === d.key);
    const latest = [...mine].reverse().find((x) => x.source === "coach") ?? mine.at(-1);
    const baseline = latest?.rating ?? null;
    const target = o.target ?? Math.min(5, (baseline ?? 2) + 1);
    if (!Number.isInteger(target) || target < 1 || target > 5 || (baseline != null && target <= baseline)) throw invalidInput(`Set the ${d.label.toLowerCase()} target as a rating above ${baseline ?? 0}, up to 5.`);
    return {
      position,
      dimension: d.key,
      kind: "observed" as const,
      metric: null,
      baseline,
      baselineMatches: null,
      baselineMinutes: null,
      target,
      finding: p?.finding ?? (latest ? `${d.label} rated ${latest.rating}/5 (${latest.source === "coach" ? "coach" : "self"}) on ${latest.on}.` : `${d.label}: not rated yet; rate it now so progress can be judged.`),
      evidence: p?.evidence ?? [],
    };
  });
  const exercises = input.exercises.map((e, position) => {
    const drill = libByKey.get(e.drillKey);
    if (!drill) throw notFound("Drill");
    if (!drill.dimensions.includes(e.dimension)) throw invalidInput(`“${drill.title}” doesn't train ${dimensionByKey.get(e.dimension)!.label.toLowerCase()}.`);
    const { key, source, ...content } = drill;
    return { position, dimension: e.dimension, drillKey: key, drill: { ...content, source }, sessionsPerWeek: e.sessionsPerWeek };
  });
  const title = input.title ?? `${objectives.map((o) => dimensionByKey.get(o.dimension)!.label).join(", ")}`.slice(0, 80);

  return db.transaction(async (tx) => {
    // Serialise plan creation per workspace so two requests can't both take the last slot.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plans:${actor.orgId}`}))`);
    const { limits } = await getEntitlements(tx, actor.orgId);
    const [{ n }] = await tx.select({ n: count() }).from(developmentPlans).where(and(eq(developmentPlans.orgId, actor.orgId), eq(developmentPlans.status, "active")));
    if (n >= limits.maxActivePlans) throw quotaExceeded(`Your plan allows ${limits.maxActivePlans} active development ${limits.maxActivePlans === 1 ? "plan" : "plans"}. Complete one or upgrade.`);
    const [active] = await tx.select({ id: developmentPlans.id }).from(developmentPlans).where(and(eq(developmentPlans.playerId, playerId), eq(developmentPlans.status, "active")));
    if (active) throw conflict("This player already has an active plan. Complete it before starting a new one.");

    const [plan] = await tx.insert(developmentPlans).values({ orgId: actor.orgId, playerId, title, startsOn: today, reviewOn: input.reviewOn, createdBy: actor.userId }).returning();
    const objRows = await tx
      .insert(planObjectives)
      .values(objectives.map((o) => ({ orgId: actor.orgId, planId: plan.id, ...o })))
      .returning({ id: planObjectives.id, dimension: planObjectives.dimension });
    const objId = new Map(objRows.map((o) => [o.dimension, o.id]));
    await tx.insert(planExercises).values(exercises.map(({ dimension, ...e }) => ({ orgId: actor.orgId, planId: plan.id, objectiveId: objId.get(dimension)!, ...e })));
    await recordAudit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "plan.created", targetType: "plan", targetId: plan.id, metadata: { playerId } });
    return plan;
  });
}

export const closeInput = z.object({
  status: z.enum(["completed", "archived"]),
  closingNote: z.string().trim().max(1000).nullable().default(null).transform((v) => v || null),
});

export async function closePlan(db: DbOrTx, actor: Actor, planId: string, raw: unknown) {
  assertCan(actor, "plan.manage");
  const input = parse(closeInput, raw);
  const { plan } = await planAccess(db, actor, planId);
  if (plan.status !== "active") throw conflict("This plan is already closed.");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(developmentPlans)
      .set({ status: input.status, closingNote: input.closingNote, closedAt: new Date() })
      .where(and(eq(developmentPlans.id, planId), eq(developmentPlans.orgId, actor.orgId), eq(developmentPlans.status, "active")))
      .returning();
    if (!row) throw conflict("This plan is already closed.");
    await recordAudit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "plan.closed", targetType: "plan", targetId: planId, metadata: { status: input.status } });
    return row;
  });
}

// ---------------------------------------------------------------------------------------------
// Training logs and comments

export const logInput = z.object({
  exerciseId: z.uuid(),
  doneOn: isoDate,
  durationMinutes: z.number().int().min(1).max(240),
  effort: z.number().int().min(1).max(10).nullable().default(null),
  note: z.string().trim().max(500).nullable().default(null).transform((v) => v || null),
});

const MAX_LOGS_PER_DAY = 20;

export async function logSession(db: DbOrTx, actor: Actor, planId: string, raw: unknown, now = new Date()) {
  const input = parse(logInput, raw);
  const { plan, access } = await planAccess(db, actor, planId);
  if (!access.canLog) throw forbidden();
  if (plan.status !== "active") throw conflict("This plan is closed.");
  const today = todayUtc(now);
  if (input.doneOn > today || input.doneOn < plan.startsOn) throw invalidInput("Pick a day between the plan's start and today.");
  const [ex] = await db.select({ id: planExercises.id }).from(planExercises).where(and(eq(planExercises.id, input.exerciseId), eq(planExercises.planId, planId), eq(planExercises.orgId, actor.orgId)));
  if (!ex) throw notFound("Drill");
  const [{ n }] = await db.select({ n: count() }).from(trainingLogs).where(and(eq(trainingLogs.planId, planId), eq(trainingLogs.doneOn, input.doneOn)));
  if (n >= MAX_LOGS_PER_DAY) throw conflict("That's a lot of sessions for one day. Check the date.");
  const [row] = await db.insert(trainingLogs).values({ orgId: actor.orgId, planId, ...input, loggedBy: actor.userId }).returning();
  return row;
}

export async function deleteLog(db: DbOrTx, actor: Actor, planId: string, logId: string) {
  const { plan, access } = await planAccess(db, actor, planId);
  if (plan.status !== "active") throw conflict("This plan is closed.");
  const [log] = await db.select().from(trainingLogs).where(and(eq(trainingLogs.id, logId), eq(trainingLogs.planId, planId), eq(trainingLogs.orgId, actor.orgId)));
  if (!log) throw notFound("Session");
  if (log.loggedBy !== actor.userId && !access.canManage) throw forbidden();
  await db.delete(trainingLogs).where(and(eq(trainingLogs.id, logId), eq(trainingLogs.orgId, actor.orgId)));
}

export const commentInput = z.object({ body: z.string().trim().min(1, "Write something first.").max(1000) });

export async function addComment(db: DbOrTx, actor: Actor, planId: string, raw: unknown) {
  const input = parse(commentInput, raw);
  const { access } = await planAccess(db, actor, planId);
  const [row] = await db
    .insert(planComments)
    .values({ orgId: actor.orgId, planId, authorId: actor.userId, authorKind: access.self ? "player" : "coach", body: input.body })
    .returning();
  return row;
}

// ---------------------------------------------------------------------------------------------
// Views

type Snapshot = DrillContent & { source: "starter" | "custom" };

export type ObjectiveView = {
  id: string;
  dimension: string;
  label: string;
  kind: "measured" | "observed";
  metric: MetricKey | null;
  baseline: number | null;
  baselineText: string;
  target: number | null;
  targetText: string;
  finding: string;
  evidence: string[];
  progress: Progress;
};

export type ExerciseView = { id: string; objectiveId: string | null; drillKey: string; drill: Snapshot; sessionsPerWeek: number; done: number; planned: number; thisWeek: number };

export type PlanView = {
  id: string;
  title: string;
  status: "active" | "completed" | "archived";
  startsOn: string;
  reviewOn: string;
  reviewDue: boolean;
  closingNote: string | null;
  objectives: ObjectiveView[];
  exercises: ExerciseView[];
  training: { done: number; planned: number; minutes: number; thisWeekDone: number; thisWeekPlanned: number };
  logs: { id: string; exerciseId: string; doneOn: string; durationMinutes: number; effort: number | null; note: string | null; mine: boolean }[];
  comments: { id: string; authorKind: "coach" | "player"; body: string; createdAt: string; mine: boolean }[];
};

function valueText(kind: "measured" | "observed", metric: MetricKey | null, v: number | null) {
  if (v == null) return "not rated yet";
  return kind === "measured" && metric ? formatMetric(metric, v) : `${v}/5`;
}

async function planViews(db: DbOrTx, actor: Actor, plans: (typeof developmentPlans.$inferSelect)[], stats: PlayerProfileStats, observations: Observation[], today: string): Promise<PlanView[]> {
  if (!plans.length) return [];
  const ids = plans.map((p) => p.id);
  const [objs, exs, logs, comments] = await Promise.all([
    db.select().from(planObjectives).where(and(eq(planObjectives.orgId, actor.orgId), inArray(planObjectives.planId, ids))).orderBy(asc(planObjectives.position)),
    db.select().from(planExercises).where(and(eq(planExercises.orgId, actor.orgId), inArray(planExercises.planId, ids))).orderBy(asc(planExercises.position)),
    db.select().from(trainingLogs).where(and(eq(trainingLogs.orgId, actor.orgId), inArray(trainingLogs.planId, ids))).orderBy(desc(trainingLogs.doneOn), desc(trainingLogs.createdAt)),
    db.select().from(planComments).where(and(eq(planComments.orgId, actor.orgId), inArray(planComments.planId, ids))).orderBy(asc(planComments.createdAt)),
  ]);
  const week = weekStart(today);
  return plans.map((p) => {
    const end = p.closedAt ? p.closedAt.toISOString().slice(0, 10) : undefined;
    const planLogs = logs.filter((l) => l.planId === p.id);
    const exercises = exs
      .filter((e) => e.planId === p.id)
      .map((e) => {
        const mine = planLogs.filter((l) => l.exerciseId === e.id);
        return {
          id: e.id,
          objectiveId: e.objectiveId,
          drillKey: e.drillKey,
          drill: e.drill as Snapshot,
          sessionsPerWeek: e.sessionsPerWeek,
          done: mine.length,
          planned: sessionsPlanned(p.startsOn, today, e.sessionsPerWeek, end),
          thisWeek: mine.filter((l) => l.doneOn >= week).length,
        };
      });
    const objectives = objs
      .filter((o) => o.planId === p.id)
      .map((o) => {
        const d = dimensionByKey.get(o.dimension);
        const metric = (o.metric as MetricKey | null) ?? null;
        const label = d?.label ?? o.dimension;
        return {
          id: o.id,
          dimension: o.dimension,
          label,
          kind: o.kind,
          metric,
          baseline: o.baseline,
          baselineText: valueText(o.kind, metric, o.baseline),
          target: o.target,
          targetText: valueText(o.kind, metric, o.target),
          finding: o.finding,
          evidence: o.evidence as string[],
          progress: objectiveProgress(
            { kind: o.kind, metric, dimensionLabel: label, baseline: o.baseline, baselineMinutes: o.baselineMinutes, target: o.target, startsOn: p.startsOn, createdAt: p.createdAt.toISOString() },
            end ? stats.matches.filter((m) => m.date <= end) : stats.matches,
            observations.filter((x) => x.dimension === o.dimension && (!p.closedAt || x.at <= p.closedAt.toISOString())).map((x) => ({ rating: x.rating, source: x.source, on: x.on, at: x.at })),
          ),
        };
      });
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      startsOn: p.startsOn,
      reviewOn: p.reviewOn,
      reviewDue: p.status === "active" && today >= p.reviewOn,
      closingNote: p.closingNote,
      objectives,
      exercises,
      training: {
        done: planLogs.length,
        planned: exercises.reduce((s, e) => s + e.planned, 0),
        minutes: planLogs.reduce((s, l) => s + l.durationMinutes, 0),
        thisWeekDone: planLogs.filter((l) => l.doneOn >= week).length,
        thisWeekPlanned: p.status === "active" ? exercises.reduce((s, e) => s + e.sessionsPerWeek, 0) : 0,
      },
      logs: planLogs.slice(0, 30).map((l) => ({ id: l.id, exerciseId: l.exerciseId, doneOn: l.doneOn, durationMinutes: l.durationMinutes, effort: l.effort, note: l.note, mine: l.loggedBy === actor.userId })),
      comments: comments.filter((c) => c.planId === p.id).map((c) => ({ id: c.id, authorKind: c.authorKind, body: c.body, createdAt: c.createdAt.toISOString(), mine: c.authorId === actor.userId })),
    };
  });
}

export type DevelopmentView = {
  player: { id: string; name: string; position: string | null; shirtNumber: number | null };
  access: Omit<PlayerAccess, "player">;
  priorities: Priority[];
  observations: Observation[];
  activePlan: PlanView | null;
  pastPlans: PlanView[];
  limits: { maxActivePlans: number; activePlans: number };
  matchesAnalysed: number;
};

export async function developmentView(db: DbOrTx, actor: Actor, playerId: string, now = new Date()): Promise<DevelopmentView> {
  const access = await playerAccess(db, actor, playerId);
  const today = todayUtc(now);
  const { stats, observations, priorities } = await evidenceFor(db, actor, access);
  const plans = await db
    .select()
    .from(developmentPlans)
    .where(and(eq(developmentPlans.orgId, actor.orgId), eq(developmentPlans.playerId, playerId), inArray(developmentPlans.status, ["active", "completed"])))
    .orderBy(desc(developmentPlans.createdAt))
    .limit(10);
  const views = await planViews(db, actor, plans, stats, observations, today);
  const { limits } = await getEntitlements(db, actor.orgId);
  const [{ n }] = await db.select({ n: count() }).from(developmentPlans).where(and(eq(developmentPlans.orgId, actor.orgId), eq(developmentPlans.status, "active")));
  const { player, ...rest } = access;
  return {
    player: { id: player.id, name: player.name, position: player.position, shirtNumber: player.shirtNumber },
    access: rest,
    priorities,
    observations: [...observations].reverse(),
    activePlan: views.find((v) => v.status === "active") ?? null,
    pastPlans: views.filter((v) => v.status !== "active"),
    limits: { maxActivePlans: limits.maxActivePlans, activePlans: n },
    matchesAnalysed: stats.matches.length,
  };
}

export type PlanSummary = { planId: string; title: string; thisWeekDone: number; thisWeekPlanned: number; reviewDue: boolean };

/**
 * Active-plan status per player: training done this week and whether the review is due. Staff see
 * the whole workspace; anyone else only their own profile (`playerId` linked to their account).
 */
export async function squadDevelopment(db: DbOrTx, actor: Actor, now = new Date(), opts: { playerId?: string } = {}): Promise<Map<string, PlanSummary>> {
  if (!can(actor.role, "plan.read")) {
    if (!opts.playerId) return new Map();
    const [own] = await db.select({ id: players.id }).from(players).where(and(eq(players.id, opts.playerId), eq(players.orgId, actor.orgId), eq(players.userId, actor.userId)));
    if (!own) return new Map();
  }
  const today = todayUtc(now);
  const week = weekStart(today);
  const plans = await db
    .select({ id: developmentPlans.id, playerId: developmentPlans.playerId, title: developmentPlans.title, reviewOn: developmentPlans.reviewOn })
    .from(developmentPlans)
    .where(and(eq(developmentPlans.orgId, actor.orgId), eq(developmentPlans.status, "active"), opts.playerId ? eq(developmentPlans.playerId, opts.playerId) : undefined));
  if (!plans.length) return new Map();
  const ids = plans.map((p) => p.id);
  const [perWeek, done] = await Promise.all([
    db
      .select({ planId: planExercises.planId, n: sql<number>`sum(${planExercises.sessionsPerWeek})::int` })
      .from(planExercises)
      .where(and(eq(planExercises.orgId, actor.orgId), inArray(planExercises.planId, ids)))
      .groupBy(planExercises.planId),
    db
      .select({ planId: trainingLogs.planId, n: count() })
      .from(trainingLogs)
      .where(and(eq(trainingLogs.orgId, actor.orgId), inArray(trainingLogs.planId, ids), gte(trainingLogs.doneOn, week)))
      .groupBy(trainingLogs.planId),
  ]);
  return new Map(
    plans.map((p) => [
      p.playerId,
      {
        planId: p.id,
        title: p.title,
        thisWeekDone: done.find((d) => d.planId === p.id)?.n ?? 0,
        thisWeekPlanned: perWeek.find((d) => d.planId === p.id)?.n ?? 0,
        reviewDue: today >= p.reviewOn,
      },
    ]),
  );
}
