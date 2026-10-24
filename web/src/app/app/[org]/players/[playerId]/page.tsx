import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Icon, PageHeader, StatTile } from "@/components/app-ui";
import { Pitch } from "@/components/pitch";
import { Chip, FOOT_LABEL, PlayerAvatar, POSITION_LABEL, ScoreDial } from "@/components/player-ui";
import { Badge, ButtonLink, Card, CornerMarks } from "@/components/ui";
import type { MatchPerformance } from "@/lib/analysis/player-profile";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { AppError, uuidParam } from "@/server/http/errors";
import { workspaceOverview } from "@/server/orgs/overview";
import { getPlayerProfile } from "@/server/players/service";
import { getStorage } from "@/server/storage/s3";
import { EditPlayerButton } from "../player-dialogs";

export const metadata: Metadata = { title: "Player profile" };

const COMPONENT_LABEL = { workRate: "Work rate", intensity: "High-intensity running", speed: "Top speed", sprints: "Sprints", stamina: "Stamina" } as const;

export default function PlayerPage({ params }: PageProps<"/app/[org]/players/[playerId]">) {
  return (
    <div className="mx-auto max-w-6xl">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface" aria-label="Loading profile" />}>
        <Profile params={params} />
      </Suspense>
    </div>
  );
}

/** Score per match, oldest to newest, with the match names on hover and in a table for screen readers. */
function FormChart({ matches }: { matches: MatchPerformance[] }) {
  const pts = [...matches].reverse();
  const W = 640;
  const H = 200;
  const pad = { l: 34, r: 12, t: 12, b: 28 };
  const x = (i: number) => (pts.length === 1 ? (W + pad.l - pad.r) / 2 : pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => H - pad.b - (v / 100) * (H - pad.t - pad.b);
  const scored = pts.map((m, i) => ({ m, i })).filter((p) => p.m.score != null);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Score by match: ${scored.map((p) => `${p.m.title} ${p.m.score}`).join(", ")}`}>
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--pitchline)" strokeDasharray={v === 50 ? "4 4" : undefined} />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--cascade)" style={{ fontFamily: "var(--font-jetbrains)" }}>
              {v}
            </text>
          </g>
        ))}
        <polyline points={scored.map((p) => `${x(p.i)},${y(p.m.score!)}`).join(" ")} fill="none" stroke="var(--mindaro)" strokeWidth="2.5" strokeLinejoin="round" />
        {scored.map((p) => (
          <g key={p.m.jobId}>
            <circle cx={x(p.i)} cy={y(p.m.score!)} r="5" fill="var(--bg-brand)" stroke="var(--mindaro)" strokeWidth="2.5">
              <title>{`${p.m.title} (${p.m.date}): ${p.m.score}`}</title>
            </circle>
            <text x={x(p.i)} y={y(p.m.score!) - 10} textAnchor="middle" fontSize="11" fill="var(--white)" style={{ fontFamily: "var(--font-jetbrains)" }}>
              {p.m.score}
            </text>
          </g>
        ))}
        {pts.map((m, i) => (
          <text key={m.jobId} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--cascade)" style={{ fontFamily: "var(--font-jetbrains)" }}>
            {m.date.slice(5)}
          </text>
        ))}
      </svg>
      <figcaption className="mt-1 text-xs text-muted">Score out of 100 in each match (compared with the other players in that match). Dashed line: the match average.</figcaption>
    </figure>
  );
}

async function Profile({ params }: { params: PageProps<"/app/[org]/players/[playerId]">["params"] }) {
  const { org, playerId } = await params;
  const actor = await pageActor(org);
  const db = getDb();
  let data;
  try {
    data = await getPlayerProfile(db, getStorage(), actor, uuidParam(playerId, "Player"));
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
  const { player, stats, photoUrl } = data;
  const overview = await workspaceOverview(db, actor);
  const base = `/app/${actor.orgSlug}`;
  const isMe = player.userId === actor.userId;
  const t = stats.totals;
  const age = player.birthYear ? new Date().getUTCFullYear() - player.birthYear : null;
  const maxHeat = Math.max(1e-9, ...stats.heatmap.flat());
  const canManage = can(actor.role, "player.manage");
  const a = overview.analyses;

  return (
    <div className="space-y-8">
      <PageHeader
        crumbs={[{ label: "Home", href: base }, { label: overview.kind === "personal" ? "Players" : "Squad", href: `${base}/players` }, { label: player.name }]}
        title={isMe ? "My profile" : "Player profile"}
        actions={
          canManage && (
            <EditPlayerButton
              orgId={actor.orgId}
              orgSlug={actor.orgSlug}
              canArchive={!isMe}
              player={{ id: player.id, name: player.name, position: player.position, preferredFoot: player.preferredFoot, shirtNumber: player.shirtNumber, birthYear: player.birthYear, clubName: player.clubName }}
            />
          )
        }
      />

      {/* Player card */}
      <section className="fv-stripes relative overflow-hidden rounded-2xl border border-border bg-surface p-6 sm:p-8">
        <CornerMarks tone="mindaro" size={22} />
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-40 blur-3xl" style={{ background: "radial-gradient(circle, var(--lush), transparent 65%)" }} />
        <div className="relative flex flex-wrap items-center gap-6">
          <PlayerAvatar name={player.name} photoUrl={photoUrl} className="h-40 w-32" />
          <div className="min-w-0 flex-1">
            <p className="font-data text-xs uppercase tracking-[0.22em] text-mindaro">{player.clubName ?? (overview.kind === "personal" ? "Player" : "Squad player")}</p>
            <h2 className="mt-2 font-display text-5xl font-extrabold uppercase italic leading-[0.9] tracking-tight sm:text-6xl">
              {player.shirtNumber != null && <span className="text-mindaro">{player.shirtNumber} </span>}
              {player.name}
            </h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {isMe && <Chip>You</Chip>}
              {player.position && <Chip>{POSITION_LABEL[player.position]}</Chip>}
              {player.preferredFoot && <Chip>{FOOT_LABEL[player.preferredFoot]}</Chip>}
              {age != null && <Chip>{age} years old</Chip>}
              <Chip>
                {t.matches} {t.matches === 1 ? "match" : "matches"} analysed
              </Chip>
            </div>
          </div>
          <ScoreDial score={t.averageScore} size={120} label="Average score" />
        </div>
      </section>

      {t.matches === 0 ? (
        <Card className="p-6 sm:p-8" corners="pitchline">
          <h3 className="font-display text-3xl font-bold uppercase">Build {isMe ? "your" : "this"} profile</h3>
          <ol className="mt-5 grid gap-4 md:grid-cols-3">
            {[
              ["upload", "Upload a match", "Film from a raised spot that sees the pitch, then upload the video."],
              ["calibrate", "Mark the pitch", "Click the points we ask for once. The analysis starts by itself."],
              ["link", isMe ? "Tap “This is me”" : "Link the player", "Open the Players section of the results and pick the right player card."],
            ].map(([icon, title, text], i) => (
              <li key={title} className="rounded-xl border border-border bg-bg/50 p-4">
                <span className="grid h-10 w-10 place-items-center rounded-lg border border-mindaro/40 bg-accent-soft text-mindaro">
                  <Icon name={icon as "upload"} className="h-5 w-5" />
                </span>
                <p className="mt-3 font-data text-xs text-muted">STEP {i + 1}</p>
                <p className="font-semibold">{title}</p>
                <p className="mt-1 text-sm text-muted">{text}</p>
              </li>
            ))}
          </ol>
          <ButtonLink href={`${base}/matches/new`} className="mt-6">
            <Icon name="plus" className="h-4 w-4" />
            New match
          </ButtonLink>
        </Card>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="Top speed" value={`${t.topSpeedKmh} km/h`} note={t.topSpeedMatch ? `in ${t.topSpeedMatch}` : undefined} />
            <StatTile label="Distance per match" value={`${t.distancePerMatchKm} km`} tone="fg" note={`${t.metresPerMinute} m per minute on camera`} />
            <StatTile label="Sprints per match" value={t.sprintsPerMatch} tone="fg" note={`${t.sprints} in total, faster than 25 km/h`} />
            <StatTile label="High-intensity" value={`${t.hiMetresPerMinute} m/min`} tone="fg" note="running faster than 20 km/h" />
          </dl>

          <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
            <Card className="p-6">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold">Form</h3>
                <Badge tone="info">Estimated</Badge>
              </div>
              <div className="mt-4">
                <FormChart matches={stats.matches} />
              </div>
            </Card>
            <Card className="space-y-5 p-6">
              <section aria-labelledby="str-h">
                <h3 id="str-h" className="font-semibold text-mindaro">
                  Strengths
                </h3>
                <ul className="mt-2 space-y-2 text-sm">
                  {stats.strengths.length ? stats.strengths.map((s) => <li key={s.text}>▲ {s.text}</li>) : <li className="text-muted">Nothing stands out across matches yet.</li>}
                </ul>
              </section>
              <section aria-labelledby="wk-h">
                <h3 id="wk-h" className="font-semibold text-gold">
                  To work on
                </h3>
                <ul className="mt-2 space-y-2 text-sm">
                  {stats.weaknesses.length ? stats.weaknesses.map((s) => <li key={s.text}>▼ {s.text}</li>) : <li className="text-muted">Nothing stands out across matches yet.</li>}
                </ul>
              </section>
              <p className="text-xs text-muted">
                {t.matches === 1
                  ? "Based on one match so far. Patterns become reliable after a few matches."
                  : "Only things that hold across matches are listed; one good or bad game isn't a pattern."}
              </p>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-6">
              <h3 className="text-lg font-semibold">How {isMe ? "you compare" : "they compare"}</h3>
              <p className="text-xs text-muted">Average rank among the players in each match (100 = highest).</p>
              <ul className="mt-4 space-y-3">
                {(Object.keys(COMPONENT_LABEL) as (keyof typeof COMPONENT_LABEL)[]).map((k) => {
                  const c = stats.componentAverages[k];
                  return (
                    <li key={k}>
                      <div className="flex items-baseline justify-between text-sm">
                        <span>{COMPONENT_LABEL[k]}</span>
                        <span className="font-data text-muted">{c ? `${c.average} · ${c.matches} ${c.matches === 1 ? "match" : "matches"}` : "n/a"}</span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg" role="meter" aria-label={COMPONENT_LABEL[k]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={c?.average}>
                        {c && <div className="h-full rounded-full bg-mindaro" style={{ width: `${Math.max(3, c.average)}%` }} />}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
            <Card className="p-6">
              <h3 className="text-lg font-semibold">Where {isMe ? "you play" : "they play"}</h3>
              <p className="text-xs text-muted">All analysed matches together, always attacking to the right →</p>
              <Pitch title={`Heatmap of ${player.name} across matches`} className="mt-3 w-full">
                {stats.heatmap.flatMap((row, iy) =>
                  row.map((v, ix) => (v ? <rect key={`${ix}-${iy}`} x={ix * 5} y={iy * (68 / 14)} width={5} height={68 / 14} fill="var(--mindaro)" fillOpacity={0.08 + 0.75 * (v / maxHeat)} /> : null)),
                )}
              </Pitch>
            </Card>
          </div>

          <Card className="p-6">
            <h3 className="text-lg font-semibold">Match log</h3>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    {["Date", "Match", "Minutes", "Score", "Distance", "Top speed", "Sprints", "Where"].map((h) => (
                      <th key={h} scope="col" className="py-2 pr-4 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="font-data">
                  {stats.matches.map((m) => (
                    <tr key={m.jobId} className="border-t border-border">
                      <td className="py-2 pr-4">{m.date}</td>
                      <td className="py-2 pr-4 font-sans">
                        <Link href={`${base}/matches/${m.matchId}#results-heading`} className="text-mindaro underline-offset-4 hover:underline">
                          {m.title}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">{m.minutes.toFixed(0)}</td>
                      <td className="py-2 pr-4">{m.score ?? "–"}</td>
                      <td className="py-2 pr-4">{(m.distanceM / 1000).toFixed(2)} km</td>
                      <td className="py-2 pr-4">{m.topSpeedKmh.toFixed(1)} km/h</td>
                      <td className="py-2 pr-4">{m.sprints}</td>
                      <td className="py-2 pr-4 font-sans text-muted">{m.zone ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-dashed border-border-strong p-5 text-sm">
          <p className="font-medium">
            Not measured yet: <span className="text-muted">goals, assists, shots, passes, tackles.</span>
          </p>
          <p className="mt-1 text-xs text-muted">They need ball tracking, which is still in development. Every number here comes from tracked movement and is an estimate.</p>
        </div>
        {isMe && (
          <div className="rounded-2xl border border-border bg-surface p-5 text-sm">
            <p className="font-medium">
              {overview.planName} · {a.used + a.inProgress} of {a.unlimited ? "unlimited" : a.limit} analyses this month
            </p>
            <p className="mt-1 text-xs text-muted">Player Pro gives 4 analyses a month. Paid plans aren&apos;t on sale yet; we&apos;ll announce prices in Egyptian pounds.</p>
            <Link href="/pricing" className="mt-2 inline-flex items-center gap-1 text-mindaro underline-offset-4 hover:underline">
              See plans <Icon name="arrow" className="h-4 w-4" />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
