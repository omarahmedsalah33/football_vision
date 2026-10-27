import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-ui";
import { MatchStatusBadge } from "@/components/match-status";
import { Card } from "@/components/ui";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { AppError, uuidParam } from "@/server/http/errors";
import { getMatch, type MatchDetail } from "@/server/matches/service";
import { AnalysisActions, LiveRefresh } from "./analysis-controls";
import { DeleteMatch } from "./delete-match";
import { Uploader } from "./uploader";
import { AnalysisResults } from "./results";
import { SevenAsideLineup } from "./seven-a-side-lineup";

export const metadata: Metadata = { title: "Match" };

const REJECTION: Record<string, string> = {
  size_mismatch: "The uploaded file was incomplete or a different size than expected.",
  unrecognized_container: "The file is not a supported video format.",
};

const CAMERA = {
  fixed: { short: "Fixed camera", help: "" },
  moving: {
    short: "Moving camera",
    help: "This video was filmed with a moving camera (it follows the play). Calibrate one frame that shows plenty of pitch lines; we follow the camera from there and skip replays and close-ups.",
  },
  unknown: { short: "Camera type not detected", help: "" },
} as const;

const STAGE_LABEL: Record<string, string> = {
  download: "Video download: transferring the uploaded video from App Storage to the Modal worker for decoding and analysis.",
  validate: "Video validation: checking the uploaded file and decoding its metadata, including duration, resolution and frame rate.",
  frames: "Frame extraction: decoding still images from the video for visual analysis.",
  detect: "Player detection: locating players in sampled frames and generating bounding boxes. This is detection, not yet consistent player identification.",
  resume: "Checkpoint recovery: checking saved work for this job and restoring compatible, integrity-verified files. Missing checkpoints must be recomputed.",
  checkpoint: "Checkpoint upload: saving intermediate analysis files for retry recovery. This does not mean the final match report is complete.",
  track: "Player tracking: associating player detections across frames to build movement tracks.",
  teams: "Team assignment: grouping detected players into teams using visual appearance.",
  metrics: "Statistics calculation: deriving match and player metrics from the processed analysis.",
  llm_roster: "Gemini player catalog: examining video references and building anonymous player IDs from non-biometric visual evidence. This is not facial recognition.",
  player_tracking: "Modal GPU tracking: running player detection and linking detections across frames to produce movement-track evidence.",
  llm_events: "Gemini action detection: processing video sections to propose timestamped ball actions, outcomes and visual evidence. Proposals still require consolidation, player attribution and review.",
  llm_identity: "Gemini player attribution: reviewing short clips around ball actions and comparing the actor with the existing player reference cards using kit, visible shirt numbers and footwear—not facial recognition. Batches run sequentially so later assignments use the updated player catalog; ambiguous actions can remain unassigned.",
  llm_review_photos: "Parallel verification and photo selection: Astra reviews independent action batches while Gemini matches photo candidates to the fixed player catalog. Up to two batches per model run at once. Each Astra challenge waits for its own independent observation; final statistics wait for all reviews. Frame decoding is limited to these batch workers.",
  llm_review: "Astra verification: inspecting sampled action frames independently, then comparing those observations with Gemini’s claims about the action, outcome and player. Recording support, contradictions or inconclusive evidence; an inconclusive review does not overrule Gemini.",
  llm_photos: "Player photo selection: evaluating candidate frames and matching them to the player catalog, then selecting clear full-body references with face visibility prioritized for presentation—not facial identification.",
  resume_llm: "AI checkpoint recovery: downloading and verifying compatible saved model responses or a completed result archive for this job. A valid completed archive can skip inference; partial checkpoints reuse available work.",
  finalize: "Result persistence: saving the completed analysis and uploading report assets, then committing the report to the database. The report is not complete until the job is marked successful; upload or commit failures may require recovery.",
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
        {job.status === "queued" ? "Worker queue: waiting for a Modal worker to claim this job. A retry may also be waiting for its scheduled delay." : (STAGE_LABEL[job.stage ?? ""] ?? "Processing: waiting for the worker to report its current analysis stage.")}
        {job.cancelRequested && " Cancellation requested: waiting for the worker to stop safely."}
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

  const { video, prepareJob, analysisJob } = match;
  const canUpload = can(actor.role, "video.upload");
  const canRun = can(actor.role, "analysis.run");
  const needsVideo = ["awaiting_upload", "upload_rejected", "uploading"].includes(match.status);
  const active = (j: typeof prepareJob) => j?.status === "queued" || j?.status === "running";
  const base = `/app/${actor.orgSlug}/matches/${match.id}`;

  return (
    <article className="space-y-6">
      <LiveRefresh active={active(prepareJob) || active(analysisJob)} />
      <PageHeader
        crumbs={[{ label: "Home", href: `/app/${actor.orgSlug}` }, { label: "Matches", href: `/app/${actor.orgSlug}/matches` }, { label: match.title }]}
        title={match.title}
        description={[match.opponentName && `vs ${match.opponentName}`, match.playedOn, video?.cameraMotion ? CAMERA[video.cameraMotion].short : null].filter(Boolean).join(" · ")}
        actions={<MatchStatusBadge status={match.status} />}
      />
      <section aria-label="Progress" className="rounded-xl border border-border bg-surface/70 px-4 py-4 sm:px-8">
        <p className="text-center text-sm">
          {[["Upload", !needsVideo], ["AI analysis", analysisJob?.status === "succeeded"], ["Results", analysisJob?.status === "succeeded"]]
            .map(([l, done], i) => (
              <span key={String(l)} className={done ? "text-mindaro" : "text-muted"}>
                {i > 0 && " → "}
                {String(l)}
              </span>
            ))}
        </p>
        <p className="mt-3 text-center text-sm text-muted">
          {needsVideo ? "Upload the match video to begin." : active(analysisJob) ? "AI analysis is running in the background." : analysisJob?.status === "succeeded" ? "Analysis finished. Results are below." : "Video ready. Start the AI analysis."}
        </p>
      </section>

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
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
                  {video.cameraMotion && (
                    <>
                      <dt className="text-muted">Camera</dt>
                      <dd>{CAMERA[video.cameraMotion].short}</dd>
                    </>
                  )}
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
          <h2 className="text-lg font-semibold">2 · AI analysis</h2>
          {!analysisJob && <p className="mt-3 text-sm text-muted">{video?.status === "validated" ? "Ready to start. No pitch calibration needed." : "Available once the video has been checked."}</p>}
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
              canStartAi={canRun && video?.status === "validated" && !active(analysisJob) && !active(prepareJob)}
              startLabel={analysisJob ? "Regenerate analysis" : "Start AI analysis"}
              regenerate={!!analysisJob}
              canCancel={canRun && (active(analysisJob) || active(prepareJob)) && !(analysisJob?.cancelRequested || prepareJob?.cancelRequested)}
            />
          </div>
        </Card>
      </div>

      <SevenAsideLineup orgId={actor.orgId} matchId={match.id} initial={match.sevenAside ?? null} canEdit={can(actor.role, "match.update")} />

      {analysisJob?.status === "succeeded" && <AnalysisResults matchTitle={match.title} orgSlug={actor.orgSlug} matchId={match.id} jobId={analysisJob.id} />}

      {can(actor.role, "match.delete") && <DeleteMatch orgId={actor.orgId} orgSlug={actor.orgSlug} matchId={match.id} title={match.title} />}
    </article>
  );
}
