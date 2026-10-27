"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import type { VideoEvents } from "@/lib/analysis/video-events";
import { buildGameRatings } from "@/lib/game-ratings";
import { RATING_ORDER } from "./game-ratings-view";
import { GoldPlayerCard } from "./gold-player-card";
import { loadPhotoForCard, renderStatCardPng, shareOrDownloadPng } from "./stat-card-png";

type PhotoSelection = {
  policyVersion: 1; faceVisible: boolean; faceClarity: "clear" | "partial" | "not_visible";
  bodyComplete: boolean; sourceSeconds?: number; note: string;
};
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const selectionOf = (c: object): PhotoSelection | null => (c as { photoSelection?: PhotoSelection }).photoSelection ?? null;

/** Gold cards for AI reference players that are not linked to a named line-up slot for this job. */
export function ProvisionalPlayerCards({ data, linkedIds, photoUrls, sourceUrl, onSeek, share }: {
  data: VideoEvents; linkedIds: Set<string>; photoUrls: Record<string, string | null>;
  sourceUrl: string | null; onSeek: (s: number) => void;
  share: { orgId: string; matchId: string; jobId: string; matchTitle: string; canShare: boolean } | null;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const eventById = useMemo(() => new Map(data.events.map(e => [e.id, e])), [data.events]);
  const cards = useMemo(() => data.catalog.filter(c => !linkedIds.has(c.id)).map(c => {
    const mine = data.events.filter(e => e.actorId === c.id);
    const counted = mine.filter(e => e.included && e.matchIncluded !== false && !e.duplicateOf);
    return {
      c, ratings: buildGameRatings(mine, data.durationSeconds), selection: selectionOf(c),
      counts: { goals: counted.filter(e => e.goalAccepted).length, shots: counted.filter(e => e.type === "shot").length,
        passes: counted.filter(e => e.type === "pass").length, carries: counted.filter(e => e.type === "carry").length },
    };
  }), [data, linkedIds]);
  const canShare = share?.canShare ?? false;

  if (cards.length === 0) return null;

  async function exportCard(card: (typeof cards)[number]) {
    if (!share || !share.canShare) return;
    setNote(null); setError(null); setBusy(card.c.id);
    try {
      const hasPhoto = !!photoUrls[card.c.id];
      const photo = hasPhoto ? await loadPhotoForCard(`/api/orgs/${share.orgId}/matches/${share.matchId}/analysis/${share.jobId}/players/${encodeURIComponent(card.c.id)}/photo`) : null;
      const blob = await renderStatCardPng({ matchTitle: share.matchTitle, teamAName: "Unnamed player", teamBName: "line-up not linked",
        playerName: card.c.id, shirtNumber: null, teamName: "Provisional AI player", counts: card.counts, awards: [],
        ratings: card.ratings, photo });
      const how = await shareOrDownloadPng(blob, `${card.c.id.toLowerCase()}-card.png`, `${card.c.id} · ${share.matchTitle}`);
      setNote(how === "cancelled" ? "Sharing cancelled." : `${how === "shared" ? "Card shared." : "Card downloaded."}${hasPhoto && !photo ? " Photo omitted: it could not be loaded for export." : ""}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create the card."); }
    finally { setBusy(null); }
  }

  return (
    <Card className="p-6" corners="gold">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">Detected players</h3>
        <Badge tone="info">Game-style estimates</Badge><Badge>Provisional</Badge>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Every AI reference player not yet linked to a named line-up player. Labels are AI references, not identities, and the same person may appear under more than one label.
        Scores are game-style estimates from counted AI events; attributes marked baseline 50 had no usable evidence.
      </p>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {note && <p role="status" className="mt-3 text-sm text-mindaro">{note}</p>}
      <ul className="mt-5 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {cards.map(card => {
          const { c, ratings: r, selection: sel } = card;
          return (
            <li key={c.id} className="rounded-lg border border-border p-3">
              <GoldPlayerCard name={c.id} shirtNumber={null} teamName="Provisional AI player" photoUrl={photoUrls[c.id] ?? null} ratings={r} />
              <p className="mt-2 text-xs text-muted">{c.description}{c.jerseyNumber ? ` · shirt hint ${c.jerseyNumber}` : ""}</p>
              {!photoUrls[c.id] && <p className="mt-1 text-xs text-muted">No reference photo available.</p>}
              {photoUrls[c.id] && sel && (
                <p className="mt-1 text-xs text-muted">
                  Photo{sel.sourceSeconds !== undefined && <> from <button disabled={!sourceUrl} onClick={() => onSeek(sel.sourceSeconds!)} className="font-data text-mindaro underline underline-offset-2 disabled:no-underline disabled:opacity-60">{fmt(sel.sourceSeconds)}</button></>}
                  {" · "}face {sel.faceClarity.replace("_", " ")} · {sel.bodyComplete ? "full body" : "partial body"}{sel.note ? ` · ${sel.note}` : ""}
                </p>
              )}
              <dl className="mt-2 grid grid-cols-4 gap-1 text-center text-xs">
                {(["goals", "shots", "passes", "carries"] as const).map(k => <div key={k}><dt className="capitalize text-muted">{k}</dt><dd className="font-data text-base">{card.counts[k]}</dd></div>)}
              </dl>
              <p className="mt-1 text-xs text-muted">{r.evidenceCount} counted events · confidence {r.confidence}</p>
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-mindaro">Scoring details</summary>
                <ul className="mt-2 space-y-2">
                  {RATING_ORDER.map(k => r.attributes.find(a => a.key === k)).filter(a => !!a).map(a => (
                    <li key={a.key} className="rounded border border-border p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-data font-bold">{a.key} {a.score}</span>
                        {a.baseline ? <Badge>Baseline 50</Badge> : <span className="text-muted">{a.observations} observations</span>}
                      </div>
                      <p className="mt-1 text-muted">{a.explanation}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {a.eventIds.slice(0, 10).map(id => { const e = eventById.get(id); return e ? (
                          <button key={id} disabled={!sourceUrl} onClick={() => onSeek(e.start)} className="font-data rounded border border-border px-1.5 py-0.5 hover:border-mindaro disabled:opacity-50">{fmt(e.start)} {e.type.replace("_", " ")}</button>
                        ) : null; })}
                        {a.eventIds.length > 10 && <span className="text-muted">+{a.eventIds.length - 10} more</span>}
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-muted">{r.disclaimer}</p>
              </details>
              <Button variant="secondary" className="mt-3 w-full" disabled={!canShare || busy === c.id} onClick={() => void exportCard(card)}>
                {!canShare ? "Sharing off" : busy === c.id ? "Preparing…" : "Share card (PNG)"}
              </Button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
