"use client";

import { useMemo, useRef, useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import type { VideoEvents } from "@/lib/analysis/video-events";
import { linksForJob, type SevenAsideExperience } from "@/lib/seven-a-side";
import { ProvisionalPlayerCards } from "./provisional-player-cards";
import { SevenAsideResults } from "./seven-a-side-results";

export type SevenAsideProps = { orgId: string; matchId: string; jobId: string; matchTitle: string; initialExperience: SevenAsideExperience | null; canEdit: boolean; canShare: boolean };

const PAGE = 50;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const csvCell = (v: unknown) => {
  const text=String(v ?? "");
  const safe=typeof v==="string" && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g,'""')}"`;
};

function download(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function VideoStatistics({ data, sourceUrl, photoUrls, sevenAside }: { data: VideoEvents; sourceUrl: string | null; photoUrls: Record<string, string | null>; sevenAside?: SevenAsideProps }) {
  const video = useRef<HTMLVideoElement>(null);
  const [videoError,setVideoError] = useState(false);
  const [player, setPlayer] = useState("all");
  const [page, setPage] = useState(0);
  const desc = useMemo(() => new Map(data.catalog.map((c) => [c.id, c.description])), [data.catalog]);
  const names = useMemo(() => {
    const m = new Map<string, string>();
    if (!sevenAside?.initialExperience) return m;
    const exp = sevenAside.initialExperience;
    for (const [cid, slot] of Object.entries(linksForJob(exp, sevenAside.jobId))) {
      const p = exp.players.find((x) => x.id === slot);
      if (p) m.set(cid, p.name);
    }
    return m;
  }, [sevenAside]);
  const linkedIds = useMemo(() => {
    const exp = sevenAside?.initialExperience;
    if (!exp || !sevenAside) return new Set<string>();
    const slots = new Set(exp.players.map((p) => p.id));
    return new Set(Object.entries(linksForJob(exp, sevenAside.jobId)).filter(([, slot]) => slots.has(slot)).map(([cid]) => cid));
  }, [sevenAside]);
  const who = (id: string | null) => (id ? `${id}${names.has(id) ? ` (${names.get(id)})` : ""} · ${desc.get(id) ?? ""}` : "Unassigned");
  const filtered = useMemo(
    () => data.events.filter((e) => player === "all" || (player === "none" ? e.actorId === null : e.actorId === player)).sort((a, b) => a.start - b.start),
    [data.events, player],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const rows = filtered.slice(cur * PAGE, cur * PAGE + PAGE);
  const minutes = useMemo(() => {
    const m = new Map<number, { passes: number; carries: number; shots: number; goals: number }>();
    if (player === "all" || player === "none") {
      for (let i=0;i<Math.ceil(data.durationSeconds/60);i++) m.set(i,{passes:0,carries:0,shots:0,goals:0});
      for (const e of data.events) if ((e.matchIncluded ?? e.included) && (player==="all" || e.actorId===null)) {
        const c=m.get(Math.floor(e.key/60));
        if (!c) continue;
        if (e.type==="pass") c.passes++;
        if (e.type==="carry") c.carries++;
        if (e.type==="shot") c.shots++;
        if (e.goalAccepted) c.goals++;
      }
      return [...m.entries()];
    }
    for (const p of data.players) if (player === "all" || p.id === player)
      for (const r of p.perMinute) {
        const c = m.get(r.minute) ?? { passes: 0, carries: 0, shots: 0, goals: 0 };
        c.passes += r.passes; c.carries += r.carries; c.shots += r.shots; c.goals += r.goals;
        m.set(r.minute, c);
      }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [data.players, data.events, data.durationSeconds, player]);
  const unassigned = data.events.filter((e) => e.actorId === null).length;
  const excluded = data.events.filter((e) => !e.included).length;
  const goals = data.events.filter((e) => e.goalAccepted).length;
  const disagreements = data.events.filter((e) => e.review && (e.review.action === "contradicted" || e.review.identity === "contradicted" || e.review.outcome === "contradicted"));

  function seek(t: number) {
    if (!video.current) return;
    video.current.currentTime = t;
    void video.current.play().catch(() => {});
    video.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  const exportJson = () => download("video-events.json", "application/json", JSON.stringify(data, null, 2));
  const exportCsv = () => {
    const head = ["id", "actor", "type", "start_s", "end_s", "key_s", "outcome", "player_included", "match_included", "goal_accepted", "identity_confidence", "event_confidence", "evidence_level", "exclusion_reasons", "review_action", "review_identity", "review_outcome", "review_comment", "evidence", "uncertainty", "track_id", "tracking_status", "gemini_actor", "canonical_event", "duplicate_of", "actor_check_status", "actor_check_evidence"];
    const lines = data.events.map((e) => [e.id, e.actorId ?? "", e.type, e.start, e.end, e.key, e.outcome, e.included, e.matchIncluded ?? e.included, e.goalAccepted, e.identityConfidence, e.eventConfidence, e.evidenceLevel, e.exclusionReasons.join("; "), e.review?.action ?? "", e.review?.identity ?? "", e.review?.outcome ?? "", e.review?.comment ?? "", e.evidence, e.uncertainty, e.tracking?.trackId ?? "", e.tracking?.status ?? "", e.geminiActorId ?? "", e.canonicalEventId ?? e.id, e.duplicateOf ?? "", e.actorAssignment?.status ?? "", e.actorAssignment?.evidence ?? ""].map(csvCell).join(","));
    download("video-events.csv", "text/csv", [head.join(","), ...lines].join("\n"));
  };
  const verdictTone = (v: string) => (v === "supported" ? "accent" : v === "contradicted" ? "warning" : "neutral");
  const verdictText = (v: string) => (v === "inconclusive" ? "neutral" : v);

  return (
    <section aria-labelledby="results-heading" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="results-heading" className="font-display text-3xl font-bold uppercase tracking-tight">AI match statistics</h2>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={exportJson}>Download JSON</Button>
          <Button variant="secondary" onClick={exportCsv}>Download CSV</Button>
        </div>
      </div>

      <Card className="p-6" corners="pitchline">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">AI estimate</Badge>
          <span className="text-sm text-muted">{data.policy}</span>
        </div>
        <p className="mt-3 max-w-3xl text-sm text-muted">
          These counts are AI estimates from the full video. Match totals can include events whose player is unknown; those events are not added to player totals. Player labels use kit, readable numbers, shoes and short-term movement—not faces. Every event below links to its moment in the video.
        </p>
        <dl className="mt-4 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
          {([["Video length", fmt(data.durationSeconds)], ["Windows analysed", `${data.completedWindows} / ${data.totalWindows}`], ["Events found", String(data.events.length)], ["Goals accepted", String(goals)], ["Unassigned / not in player totals", `${unassigned} / ${excluded}`]] as const).map(([k, v]) => (
            <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="font-data mt-1 text-xl">{v}</dd></div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-muted">Astra reviewed {data.audit.reviewed} of {data.audit.candidates} candidate events{data.audit.reviewAllCanonicalActions ? " · all canonical actions checked" : ` (review limit ${data.audit.limit})`}.</p>
        {data.audit.actionFirst && (
          <p className="mt-2 text-xs text-muted">
            Actions were detected before player identification. The player list covers actors in detected actions, not every person on the pitch.
            Unresolved actors stay in match statistics, not player totals. Duplicate proposals are excluded from totals.
          </p>
        )}
        {data.tracking && <div className="mt-4 rounded border border-line p-3 text-sm">
          <p className="font-semibold">Experimental tracking-assisted analysis</p>
          <p className="mt-1 text-muted">
            {data.tracking.trackCount} temporary tracks · {data.tracking.anchoredTracks} linked to player references · {data.tracking.duplicateReferencesRemoved} duplicate references removed.
            {" "}{data.tracking.supportedEvents} event assignments supported by tracking; {data.tracking.unresolvedEvents} unresolved.
          </p>
          <p className="mt-2 text-xs text-muted">{data.tracking.limitations}</p>
        </div>}
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer">Models</summary>
          <ul className="font-data mt-2 space-y-1">{Object.entries(data.models).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul>
        </details>
      </Card>

      <Card className="p-6">
        <h3 className="text-lg font-semibold">Source video</h3>
        {sourceUrl ? (
          <>
            <video ref={video} src={sourceUrl} controls preload="metadata" onError={() => setVideoError(true)}
              onLoadedMetadata={() => setVideoError(false)} className="mt-4 w-full rounded-lg bg-bg" />
            {videoError && <p role="status" className="mt-3 text-sm text-muted">
              This browser could not play the video format, or the private link has expired.
              Reload to refresh the link, or open it in a browser that supports this format.{" "}
              <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">Open private video</a>
            </p>}
          </>
        ) : (
          <p className="mt-3 text-sm text-muted">The source video is no longer available, so timestamps cannot be played.</p>
        )}
      </Card>

      <ProvisionalPlayerCards data={data} linkedIds={linkedIds} photoUrls={photoUrls} sourceUrl={sourceUrl} onSeek={seek}
        share={sevenAside ? { orgId: sevenAside.orgId, matchId: sevenAside.matchId, jobId: sevenAside.jobId, matchTitle: sevenAside.matchTitle, canShare: sevenAside.canShare } : null} />
      {sevenAside && <SevenAsideResults data={data} sourceUrl={sourceUrl} photoUrls={photoUrls} onSeek={seek} {...sevenAside} />}

      <Card className="p-6">
        <h3 className="text-lg font-semibold">Players</h3>
        {data.players.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No players were identified in this video.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted"><tr><th className="py-2">Player</th><th>Passes</th><th>Carries</th><th>Shots</th><th>Goals</th><th>Pending</th><th /></tr></thead>
              <tbody>
                {data.players.map((p) => {
                  const ph = photoUrls[p.id];
                  return (
                    <tr key={p.id} className="border-t border-border">
                      <td className="py-2">
                        <div className="flex items-center gap-3">
                          {ph ? <img src={ph} alt="" className="h-10 w-10 rounded-full object-cover" /> : <span className="flex h-10 w-10 items-center justify-center rounded-full bg-bg text-xs text-muted">{p.id.slice(0, 3)}</span>}
                          <div><div className="font-medium">{p.id}</div><div className="max-w-xs text-xs text-muted">{desc.get(p.id)}</div></div>
                        </div>
                      </td>
                      <td className="font-data">{p.passes}</td><td className="font-data">{p.carries}</td><td className="font-data">{p.shots}</td><td className="font-data">{p.goals}</td><td className="font-data">{p.pending}</td>
                      <td><button className="text-mindaro underline underline-offset-4" onClick={() => { setPlayer(p.id); setPage(0); }}>Filter</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">Per minute{player !== "all" && ` · ${player === "none" ? "unassigned" : player}`}</h3>
          <label className="flex items-center gap-2 text-sm text-muted">
            Player
            <select value={player} onChange={(e) => { setPlayer(e.target.value); setPage(0); }} className="rounded-lg border border-border bg-bg px-2 py-1 text-fg">
              <option value="all">All players</option>
              {data.catalog.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
              <option value="none">Unassigned events</option>
            </select>
          </label>
        </div>
        {minutes.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No counted events for this selection.</p>
        ) : (
          <div className="mt-4 max-h-72 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-surface text-xs text-muted"><tr><th className="py-2">Minute</th><th>Passes</th><th>Carries</th><th>Shots</th><th>Goals</th></tr></thead>
              <tbody>{minutes.map(([m, c]) => <tr key={m} className="border-t border-border"><td className="font-data py-1.5">{m}</td><td className="font-data">{c.passes}</td><td className="font-data">{c.carries}</td><td className="font-data">{c.shots}</td><td className="font-data">{c.goals}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <h3 className="text-lg font-semibold">Evidence · all events</h3>
        <p className="mt-1 text-xs text-muted">Includes excluded and unassigned events. {filtered.length} shown.</p>
        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No events for this selection.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted"><tr><th className="py-2">Time</th><th>Player</th><th>Event</th><th>Status</th><th>Evidence</th><th>Astra review</th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-t border-border align-top">
                    <td className="py-2"><button className="font-data text-mindaro underline underline-offset-4" onClick={() => seek(e.start)} disabled={!sourceUrl}>{fmt(e.start)}</button><div className="font-data text-xs text-muted">to {fmt(e.end)}</div></td>
                    <td className="max-w-[10rem] text-xs">{who(e.actorId)}
                      {e.tracking && <div className="mt-1 text-muted">Track {e.tracking.trackId ?? "not visible"} · {e.tracking.status.replace("_", " ")}</div>}
                    </td>
                    <td><div className="capitalize">{e.type.replace("_", " ")}</div><div className="text-xs text-muted">{e.outcome}</div></td>
                    <td><div className="flex flex-wrap gap-1">
                      <Badge tone={e.included ? "accent" : "warning"}>{e.included ? "Player + match counted" : e.matchIncluded ? "Match counted · player pending" : "Not counted"}</Badge>
                      {e.goalAccepted && <Badge tone="gold">Goal</Badge>}
                      {e.actorId === null && <Badge>Unassigned</Badge>}
                    </div>
                    {e.exclusionReasons.length > 0 && <div className="mt-1 text-xs text-muted">{e.exclusionReasons.join("; ")}</div>}
                    {e.duplicateOf && <div className="mt-1 text-xs text-muted">Duplicate of {e.duplicateOf} · counted only once</div>}
                    {e.actorAssignment && (
                      <div className="mt-1 text-xs text-muted">
                        Actor check: {e.actorAssignment.status}
                        {e.actorAssignment.referenceSeconds !== undefined && ` · reference ${fmt(e.actorAssignment.referenceSeconds)}`}
                        {e.actorAssignment.evidence && <p>{e.actorAssignment.evidence}</p>}
                        {e.actorAssignment.reason && <p>{e.actorAssignment.reason}</p>}
                      </div>
                    )}
                    <div className="mt-1 text-xs text-muted">id {e.identityConfidence} · event {e.eventConfidence} · {e.evidenceLevel}</div></td>
                    <td className="max-w-xs text-xs"><p>{e.evidence}</p>{e.uncertainty && <p className="mt-1 text-muted">Uncertain: {e.uncertainty}</p>}</td>
                    <td className="max-w-xs text-xs">
                      {e.review ? (<div className="space-y-1"><div className="flex flex-wrap gap-1"><Badge tone={verdictTone(e.review.action)}>action {verdictText(e.review.action)}</Badge><Badge tone={verdictTone(e.review.identity)}>identity {verdictText(e.review.identity)}</Badge><Badge tone={verdictTone(e.review.outcome)}>outcome {verdictText(e.review.outcome)}</Badge></div>{e.review.comment && <p className="text-muted">{e.review.comment}</p>}</div>) : <span className="text-muted">Not reviewed</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm">
            <Button variant="secondary" disabled={cur === 0} onClick={() => setPage(cur - 1)}>Previous</Button>
            <span className="font-data text-muted">Page {cur + 1} of {pages}</span>
            <Button variant="secondary" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Next</Button>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <h3 className="text-lg font-semibold">Where Astra disagreed</h3>
        {disagreements.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Astra contradicted no reviewed event. Neutral (inconclusive) reviews keep Gemini&apos;s decision.</p>
        ) : (
          <ul className="mt-3 space-y-3 text-sm">
            {disagreements.map((e) => (
              <li key={e.id} className="rounded-lg border border-border p-3">
                <button className="font-data text-mindaro underline underline-offset-4" onClick={() => seek(e.start)} disabled={!sourceUrl}>{fmt(e.start)}</button>
                <span className="ml-2 capitalize">{e.type.replace("_", " ")}</span>
                <span className="ml-2 text-xs text-muted">{e.included ? "Gemini decision retained if counted" : "excluded"}</span>
                <p className="mt-1 text-xs text-muted">{e.review?.comment || "No comment given."}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
