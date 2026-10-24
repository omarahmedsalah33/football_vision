import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { MatchStatusBadge, STATUS } from "@/components/match-status";
import { Badge, ButtonLink, Card } from "@/components/ui";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { AppError, uuidParam } from "@/server/http/errors";
import { getMatch, type MatchDetail } from "@/server/matches/service";
import { AnalysisActions, LiveRefresh } from "./analysis-controls";
import { DeleteMatch } from "./delete-match";
import { Uploader } from "./uploader";
import { AnalysisResults } from "./results";

export const metadata: Metadata = { title: "Match" };

const REJECTION: Record<string, string> = {
  size_mismatch: "The uploaded file was incomplete or a different size than expected.",
  unrecognized_container: "The file is not a supported video format.",
};

const STAGE_LABEL: Record<string, string> = {
  download: "Fetching video",
  validate: "Checking video",
  frames: "Extracting reference frames",
  detect: "Detecting players",
  track: "Tracking players",
  teams: "Separating teams",
  metrics: "Measuring",
  finalize: "Saving results",
};

function formatDuration(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

function JobProgress({ job }: { job: NonNullable<MatchDetail["prepareJob"]> }) {
  return (
    <div className="space-y-2">
      <div
        role="progressbar"
        aria-label={job.kind === "prepare" ? "Video check progress" : "Analysis progress"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(job.progress * 100)}
        className="h-2 overflow-hidden rounded-full bg-bg"
      >
        <div className="h-full bg-mindaro transition-[width]" style={{ width: `${Math.max(job.progress * 100, 3)}%` }} />
      </div>
      <p className="text-sm text-muted" aria-live="polite">
        {job.status === "queued" ? "Waiting for a worker…" : (STAGE_LABEL[job.stage ?? ""] ?? "Working…")}
        {job.cancelRequested && " Cancelling…"}
      </p>
    </div>
  );
}

export default function MatchPage({ params }: PageProps<"/app/[org]/matches/[matchId]">) {
  return (
    <div className="mx-auto max-w-6xl">
      <Suspense fallback={<div className="h-64 animate-pulse rounded-xl bg-surface" aria-label="Loading match" />}>
        <MatchDetailView params={params} />
      </Suspense>
    </div>
  );
}

async function MatchDetailView({ params }: { params: PageProps<"/app/[org]/matches/[matchId]">["params"] }) {
  const { org, matchId } = await params;
  const actor = await pageActor(org);
  let match: MatchDetail;
  try {
    match = await getMatch(getDb(), actor, uuidParam(matchId, "Match"));
  } catch (err) {
    // Unknown, malformed or other-tenant ids all look the same to the user.
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }

  const { video, prepareJob, analysisJob, calibration } = match;
  const canUpload = can(actor.role, "video.upload");
  const canRun = can(actor.role, "analysis.run");
  const needsVideo = ["awaiting_upload", "upload_rejected", "uploading"].includes(match.status);
  const active = (j: typeof prepareJob) => j?.status === "queued" || j?.status === "running";
  const base = `/app/${actor.orgSlug}/matches/${match.id}`;

  return (
    <article className="space-y-6">
      <LiveRefresh active={active(prepareJob) || active(analysisJob)} />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold uppercase tracking-tight">{match.title}</h1>
          <p className="mt-1 text-sm text-muted">
            {[match.opponentName && `vs ${match.opponentName}`, match.playedOn, "Fixed wide camera"].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="text-right">
          <MatchStatusBadge status={match.status} />
          <p className="mt-2 max-w-xs text-sm text-muted">{STATUS[match.status].help}</p>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-6">
          <h2 className="text-lg font-semibold">1 · Video</h2>
          {video && !needsVideo && (
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted">File</dt>
              <dd className="truncate">{video.originalFilename}</dd>
              <dt className="text-muted">Size</dt>
              <dd className="font-data">{(video.sizeBytes / 1024 ** 2).toFixed(0)} MB</dd>
              {video.durationSeconds != null && (
                <>
                  <dt className="text-muted">Duration</dt>
                  <dd className="font-data">{formatDuration(video.durationSeconds)}</dd>
                  <dt className="text-muted">Resolution</dt>
                  <dd className="font-data">
                    {video.width}×{video.height} @ {video.fps?.toFixed(1)} fps
                  </dd>
                </>
              )}
              {video.deleteAfter && (
                <>
                  <dt className="text-muted">Footage kept until</dt>
                  <dd className="font-data">{video.deleteAfter.toISOString().slice(0, 10)}</dd>
                </>
              )}
            </dl>
          )}
          {active(prepareJob) && prepareJob && (
            <div className="mt-4">
              <JobProgress job={prepareJob} />
            </div>
          )}
          {prepareJob?.status === "failed" && video?.status !== "rejected" && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {prepareJob.errorMessage ?? "The video check failed."}
            </p>
          )}
          {video?.status === "rejected" && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {REJECTION[video.rejectionReason ?? ""] ?? prepareJob?.errorMessage ?? "The video could not be accepted."}
            </p>
          )}
          {needsVideo && (
            <div className="mt-4">
              {canUpload ? <Uploader orgId={actor.orgId} matchId={match.id} /> : <p className="text-sm text-muted">No video has been uploaded yet.</p>}
            </div>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-semibold">2 · Pitch calibration</h2>
          {calibration ? (
            <div className="mt-4 space-y-3 text-sm">
              <p className="flex items-center gap-2">
                <Badge tone={(calibration.looErrorM ?? calibration.rmsErrorM) <= 1 ? "accent" : "warning"}>
                  {(calibration.looErrorM ?? calibration.rmsErrorM) <= 1 ? "Good" : "Usable"}
                </Badge>
                <span className="text-muted">{calibration.points} landmarks</span>
              </p>
              <dl className="grid grid-cols-2 gap-y-1">
                <dt className="text-muted">Prediction error</dt>
                <dd className="font-data">{calibration.looErrorM === null ? "n/a (under 5 points)" : `${calibration.looErrorM.toFixed(2)} m`}</dd>
                <dt className="text-muted">Fit error</dt>
                <dd className="font-data">{calibration.rmsErrorM.toFixed(2)} m</dd>
              </dl>
              {video?.status === "validated" && (
                <Link href={`${base}/calibrate`} className="inline-block text-mindaro underline underline-offset-4">
                  Review or redo calibration
                </Link>
              )}
            </div>
          ) : video?.status === "validated" ? (
            <div className="mt-4 space-y-3 text-sm">
              <p className="text-muted">
                Show us where the pitch is by clicking 5 or more points on it, so we can measure in metres. It takes about a minute.
              </p>
              {can(actor.role, "match.update") && <ButtonLink href={`${base}/calibrate`}>Calibrate pitch</ButtonLink>}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">Available once the video has been checked.</p>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-semibold">3 · Analysis</h2>
          {!analysisJob && <p className="mt-3 text-sm text-muted">{calibration ? "Ready to start." : "Calibrate the pitch first."}</p>}
          {analysisJob && active(analysisJob) && (
            <div className="mt-4">
              <JobProgress job={analysisJob} />
            </div>
          )}
          {analysisJob?.status === "failed" && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {analysisJob.errorMessage ?? "Processing failed."} No results were produced and your allowance was not used.
            </p>
          )}
          {analysisJob?.status === "succeeded" && <p className="mt-3 text-sm text-muted">Finished. Results are below.</p>}
          <div className="mt-5">
            <AnalysisActions
              orgId={actor.orgId}
              matchId={match.id}
              jobId={(active(analysisJob) ? analysisJob : active(prepareJob) ? prepareJob : null)?.id}
              canStart={canRun && ["ready", "failed", "cancelled", "analyzed"].includes(match.status) && !!calibration && video?.status === "validated"}
              startLabel={analysisJob?.status === "succeeded" ? "Re-run analysis" : "Start analysis"}
              canCancel={canRun && (active(analysisJob) || active(prepareJob)) && !(analysisJob?.cancelRequested || prepareJob?.cancelRequested)}
            />
          </div>
        </Card>
      </div>

      {analysisJob?.status === "succeeded" && <AnalysisResults orgSlug={actor.orgSlug} matchId={match.id} jobId={analysisJob.id} />}

      {can(actor.role, "match.delete") && <DeleteMatch orgId={actor.orgId} orgSlug={actor.orgSlug} matchId={match.id} title={match.title} />}
    </article>
  );
}
