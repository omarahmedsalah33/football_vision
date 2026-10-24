import { Badge, Card } from "@/components/ui";
import { pageActor } from "@/server/auth/page";
import { getDb } from "@/server/db/client";
import { getAnalysisResults, type Provenance } from "@/server/analysis/results";
import { ResultsView } from "./results-view";

const PROVENANCE_TONE = { measured: "accent", estimated: "info", inferred: "gold", not_available: "neutral" } as const;
const PROVENANCE_LABEL = { measured: "Measured", estimated: "Estimated", inferred: "Inferred", not_available: "Not available" } as const;

export function ProvenanceBadge({ value }: { value: Provenance }) {
  return <Badge tone={PROVENANCE_TONE[value]}>{PROVENANCE_LABEL[value]}</Badge>;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-data mt-1 text-xl">{value}</dd>
      {note && <dd className="text-xs text-muted">{note}</dd>}
    </div>
  );
}

const NOT_AVAILABLE: [string, string][] = [
  ["Formation", "Needs validation on reference matches before we show it."],
  ["Passes, shots, xG", "Needs a ball-event model validated on licensed data."],
  ["Player names", "Never inferred from appearance; staff will link tracks to players."],
];

export async function AnalysisResults({ orgSlug, matchId, jobId }: { orgSlug: string; matchId: string; jobId: string }) {
  const actor = await pageActor(orgSlug);
  const { summary, tracks } = await getAnalysisResults(getDb(), actor, matchId, jobId);
  const q = summary.quality;
  const calError = q.calibration.looErrorM ?? q.calibration.rmsErrorM;
  const shapeShare = q.teamShape.windows ? q.teamShape.windowsWithBothTeams / q.teamShape.windows : 0;
  const nothingFound = q.tracking.tracks === 0 || q.detection.meanPeoplePerFrame < 1;
  const identityNote =
    q.tracking.tracks === 0
      ? "No tracks"
      : q.tracking.tracksPerExpectedPerson > 2
        ? "Identities often break up: per-player figures are rough"
        : "Identities mostly hold";

  return (
    <section aria-labelledby="results-heading" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="results-heading" className="font-display text-3xl font-bold uppercase tracking-tight">
          Results
        </h2>
        <p className="text-xs text-muted">
          Team A defends the left goal when first seen; Team B the right. Every number is labelled with how it was produced.
        </p>
      </div>

      <Card className="p-6" corners="pitchline">
        <h3 className="text-lg font-semibold">How reliable is this?</h3>
        <dl className={`mt-4 grid gap-6 sm:grid-cols-2 ${q.camera.mode === "moving" ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
          {q.camera.mode === "moving" && (
            <Stat
              label="Camera followed"
              value={`${Math.round((q.camera.followedShare ?? 0) * 100)}%`}
              note="of the video; replays, close-ups and moments the pitch lines couldn't confirm are left out"
            />
          )}
          <Stat
            label="Calibration error"
            value={calError != null ? `${calError.toFixed(2)} m` : "n/a"}
            note={q.camera.mode === "moving" ? "On the calibrated frame; positions are estimates" : calError != null && calError <= 1 ? "Good: positions are measured" : "Positions are estimates"}
          />
          <Stat label="People detected per frame" value={q.detection.meanPeoplePerFrame.toFixed(1)} note={`${Math.round(q.detection.shareFramesUnderMinPeople * 100)}% of frames saw fewer than ${q.detection.minPeople}`} />
          <Stat
            label="Tracks per expected person"
            value={q.tracking.tracksPerExpectedPerson.toFixed(1)}
            note={identityNote}
          />
          <Stat label="Time with both team shapes" value={`${Math.round(shapeShare * 100)}%`} note={`${q.teams.a} / ${q.teams.b} tracks in Team A / B, ${q.teams.other} other`} />
        </dl>
        <details className="mt-4 text-xs text-muted">
          <summary className="cursor-pointer">Models and settings</summary>
          <ul className="font-data mt-2 space-y-1">
            {Object.entries(summary.models).map(([k, v]) => (
              <li key={k}>
                {k}: {v}
              </li>
            ))}
            <li>sampled at {summary.settings.sampleFps} frames per second · processing {Math.round(q.processingSeconds)} s</li>
          </ul>
        </details>
      </Card>

      {nothingFound ? (
        <Card className="border-gold/50 p-6">
          <h3 className="text-lg font-semibold text-gold">No players were found in this video</h3>
          <p className="mt-2 max-w-3xl text-sm text-muted">
            The analysis ran, but it couldn&apos;t see players on the calibrated pitch, so there are no metrics to show (and
            we won&apos;t invent any). Check that the video shows a football match from a fixed, wide camera, that the
            calibration lines sit on the real pitch markings, and that players are not too small or too dark to see.
          </p>
        </Card>
      ) : (
        <ResultsView summary={summary} tracks={tracks} />
      )}

      <Card className="p-6">
        <h3 className="text-lg font-semibold">Not available yet</h3>
        <ul className="mt-3 space-y-2 text-sm">
          {NOT_AVAILABLE.map(([what, why]) => (
            <li key={what} className="flex flex-wrap items-center gap-2">
              <ProvenanceBadge value="not_available" />
              <span className="font-medium">{what}</span>
              <span className="text-muted">{why}</span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
