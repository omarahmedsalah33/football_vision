"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { ApiError, apiRequest } from "@/lib/api-client";
import type { VideoEvents } from "@/lib/analysis/video-events";
import { buildSevenAsideStats, type SevenAsideExperience } from "@/lib/seven-a-side";
import { ratingsOf, RATING_ORDER } from "./game-ratings-view";
import { GoldPlayerCard } from "./gold-player-card";
import { loadPhotoForCard, renderStatCardPng, shareOrDownloadPng } from "./stat-card-png";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const KEYS = ["goals", "shots", "passes", "carries"] as const;
const LABEL = { goals: "Goals", shots: "Shots", passes: "Passes", carries: "Carries" };

export function SevenAsideResults({ data, orgId, matchId, jobId, matchTitle, initialExperience, canEdit, canShare, sourceUrl, photoUrls, onSeek }: {
  data: VideoEvents; orgId: string; matchId: string; jobId: string; matchTitle: string;
  initialExperience: SevenAsideExperience | null; canEdit: boolean; canShare: boolean;
  sourceUrl: string | null; photoUrls: Record<string, string | null>; onSeek: (s: number) => void;
}) {
  const router = useRouter();
  const [exp, setExp] = useState(initialExperience);
  const lastInitial = useRef(initialExperience);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const onFocus = () => { if (!pending) router.refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [router, pending]);
  useEffect(() => {
    if (lastInitial.current === initialExperience || pending) return;
    lastInitial.current = initialExperience;
    setExp(initialExperience);
  }, [initialExperience, pending]);
  const eventById = useMemo(() => new Map(data.events.map(e => [e.id, e])), [data.events]);
  const stats = useMemo(() => (exp ? buildSevenAsideStats(data, exp, jobId) : []), [data, exp, jobId]);
  const links = exp?.assignmentJobId === jobId ? exp.assignments : {};

  const awards = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const k of KEYS) {
      const max = Math.max(0, ...stats.map(s => s[k]));
      if (max <= 0) continue;
      const leaders = stats.filter(s => s[k] === max);
      for (const l of leaders) out.set(l.id, [...(out.get(l.id) ?? []),
        `${leaders.length > 1 ? "Joint most" : "Most"} ${LABEL[k].toLowerCase()} recorded (${max})`]);
    }
    return out;
  }, [stats]);

  if (!exp || exp.players.length === 0) return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold">Player fun stats</h3>
      <p className="mt-3 text-sm text-muted">Add the 7-a-side line-ups on this page to link AI reference players to named players.</p>
    </Card>
  );

  async function assign(canonicalId: string, playerId: string | null) {
    setError(null); setPending(canonicalId);
    try {
      const res = await apiRequest<{ experience: SevenAsideExperience }>("PATCH", `/api/orgs/${orgId}/matches/${matchId}/seven-a-side`,
        { op: "assignment", jobId, canonicalId, playerId });
      setExp(res.experience); router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the link. Try again.");
    } finally { setPending(null); }
  }

  const photoFor = (ids: string[]) => ids.map(id => photoUrls[id]).find((u): u is string => !!u) ?? null;

  async function exportCard(s: (typeof stats)[number]) {
    if (!exp) return;
    setNote(null); setError(null);
    try {
      const ratings = ratingsOf(s);
      const photoId = ratings ? s.canonicalIds.find(id => !!photoUrls[id]) : null;
      const url = photoId ? `/api/orgs/${orgId}/matches/${matchId}/analysis/${jobId}/players/${encodeURIComponent(photoId)}/photo` : null;
      const photo = url ? await loadPhotoForCard(url) : null;
      const photoNote = url && !photo ? " Photo omitted: the private photo could not be loaded for export." : "";
      const blob = await renderStatCardPng({ ratings, photo, matchTitle, teamAName: exp.teamAName, teamBName: exp.teamBName, playerName: s.name,
        shirtNumber: s.shirtNumber, teamName: s.team === "a" ? exp.teamAName : exp.teamBName,
        counts: { goals: s.goals, shots: s.shots, passes: s.passes, carries: s.carries }, awards: awards.get(s.id) ?? [] });
      const slug = s.name.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40) || "player";
      const how = await shareOrDownloadPng(blob, `${slug}-stat-card.png`, `${s.name} · ${matchTitle}`);
      setNote(how === "cancelled" ? "Sharing cancelled." : (how === "shared" ? "Card shared." : "Card downloaded.") + photoNote);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create the card."); }
  }

  return (
    <Card className="p-6" corners="pitchline">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">Player fun stats</h3><Badge tone="info">AI estimates</Badge>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Counts are recorded actions from AI reference players that a person linked to a named player. Excluded or uncertain AI events are never added.
        Awards go to the highest recorded count only; they are for fun, not a rating.
      </p>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {note && <p role="status" className="mt-3 text-sm text-mindaro">{note}</p>}

      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        {(["a", "b"] as const).map(t => (
          <div key={t}>
            <h4 className="font-semibold">{t === "a" ? exp.teamAName : exp.teamBName}</h4>
            <ul className="mt-3 space-y-3">
              {stats.filter(s => s.team === t).map(s => (
                <li key={s.id} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">{s.shirtNumber !== null && <span className="font-data mr-2 text-muted">#{s.shirtNumber}</span>}{s.name}</div>
                    {s.linked && <Button variant="secondary" disabled={!canShare} onClick={() => void exportCard(s)}>{canShare ? "Share card (PNG)" : "Sharing off"}</Button>}
                  </div>
                  {!s.linked ? <p className="mt-2 text-sm text-muted">Not linked yet</p> : (
                    <>
                      {(() => {
                        const r = ratingsOf(s);
                        if (!r) return null;
                        return (
                          <div className="mt-3 grid gap-4 sm:grid-cols-[16rem_1fr]">
                            <GoldPlayerCard name={s.name} shirtNumber={s.shirtNumber} teamName={t === "a" ? exp.teamAName : exp.teamBName}
                              photoUrl={photoFor(s.canonicalIds)} ratings={r} />
                            <div className="text-xs">
                              <p className="font-semibold uppercase tracking-wider text-gold">Game-style estimates</p>
                              <p className="mt-1 text-muted">{r.disclaimer} Based on {r.evidenceCount} counted AI events · confidence {r.confidence}. Not an official game rating; PAC reflects carrying activity, not speed, and PHY reflects duel involvement, not strength.</p>
                              <details className="mt-2">
                                <summary className="cursor-pointer text-mindaro">Scoring details</summary>
                                <ul className="mt-2 space-y-2">
                                  {RATING_ORDER.map(k => r.attributes.find(a => a.key === k)).filter(a => !!a).map(a => (
                                    <li key={a.key} className="rounded border border-border p-2">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-data font-bold">{a.key} {a.score}</span><span>{a.label}</span>
                                        {a.baseline ? <Badge>Baseline 50 · no usable evidence</Badge> : <span className="text-muted">{a.observations} observations</span>}
                                      </div>
                                      <p className="mt-1 text-muted">{a.explanation}</p>
                                      {a.eventIds.length > 0 && (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                          {a.eventIds.slice(0, 12).map(id => {
                                            const e = eventById.get(id);
                                            return e ? (
                                              <button key={id} disabled={!sourceUrl} onClick={() => onSeek(e.start)}
                                                className="font-data rounded border border-border px-1.5 py-0.5 hover:border-mindaro disabled:opacity-50">
                                                {fmt(e.start)} {e.type.replace("_", " ")}
                                              </button>
                                            ) : null;
                                          })}
                                          {a.eventIds.length > 12 && <span className="text-muted">+{a.eventIds.length - 12} more</span>}
                                        </div>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            </div>
                          </div>
                        );
                      })()}
                      <dl className="mt-2 grid grid-cols-4 gap-2 text-center">
                        {KEYS.map(k => <div key={k}><dt className="text-xs text-muted">{LABEL[k]}</dt><dd className="font-data text-xl">{s[k]}</dd></div>)}
                      </dl>
                      <p className="mt-2 text-xs text-muted">Linked: {s.canonicalIds.join(", ")}</p>
                      {(awards.get(s.id) ?? []).length > 0 && <div className="mt-2 flex flex-wrap gap-1">{awards.get(s.id)!.map(a => <Badge key={a} tone="gold">{a}</Badge>)}</div>}
                      {s.highlights.length > 0 && (
                        <div className="mt-3">
                          <p className="text-xs text-muted">Moments{!sourceUrl && " (video unavailable)"}</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {s.highlights.map(h => (
                              <button key={h.id} disabled={!sourceUrl} onClick={() => onSeek(h.start)}
                                className="rounded border border-border px-2 py-1 text-xs hover:border-mindaro disabled:opacity-50">
                                <span className="font-data">{fmt(h.start)}</span> {h.goalAccepted ? "goal" : h.type.replace("_", " ")}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
              {stats.every(s => s.team !== t) && <li className="text-sm text-muted">No players named.</li>}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-8">
        <h4 className="font-semibold">Link AI reference players</h4>
        <p className="mt-1 text-xs text-muted">{canEdit ? "Several references can belong to one named player." : "Only editors can change links."}</p>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {data.catalog.map(c => {
            const ph = photoUrls[c.id];
            return (
              <li key={c.id} className="flex gap-3 rounded-lg border border-border p-3">
                {ph ? <img src={ph} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover" />
                  : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-bg text-xs text-muted">{c.id.slice(0, 3)}</span>}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{c.id}{c.jerseyNumber ? <span className="font-data ml-2 text-xs text-muted">shirt hint {c.jerseyNumber}</span> : null}</div>
                  <p className="text-xs text-muted">{c.description}</p>
                  <label className="mt-2 block text-xs text-muted">
                    <span className="sr-only">Link {c.id} to</span>
                    <select value={links[c.id] ?? ""} disabled={!canEdit || pending === c.id}
                      onChange={e => void assign(c.id, e.target.value || null)}
                      className="w-full rounded-lg border border-border bg-bg px-2 py-1 text-sm text-fg">
                      <option value="">Not linked</option>
                      {exp.players.map(p => <option key={p.id} value={p.id}>{p.name} ({p.team === "a" ? exp.teamAName : exp.teamBName})</option>)}
                    </select>
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
