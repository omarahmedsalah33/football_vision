import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { pageActor } from "@/server/auth/page";
import { can } from "@/server/authz/permissions";
import { calibrationContext } from "@/server/calibration/service";
import { getDb } from "@/server/db/client";
import { AppError, uuidParam } from "@/server/http/errors";
import { getStorage } from "@/server/storage/s3";
import { Calibrator } from "./calibrator";

export const metadata: Metadata = { title: "Calibrate pitch" };

export default function CalibratePage({ params }: PageProps<"/app/[org]/matches/[matchId]/calibrate">) {
  return (
    <div className="mx-auto max-w-7xl">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-surface" aria-label="Loading calibration" />}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function Content({ params }: { params: PageProps<"/app/[org]/matches/[matchId]/calibrate">["params"] }) {
  const { org, matchId } = await params;
  const actor = await pageActor(org);
  let ctx;
  try {
    ctx = await calibrationContext(getDb(), getStorage(), actor, uuidParam(matchId, "Match"));
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
  const back = `/app/${actor.orgSlug}/matches/${matchId}`;

  if (ctx.videoStatus !== "validated" || !ctx.width || !ctx.height || ctx.frames.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8">
        <h1 className="font-display text-3xl font-bold uppercase">Calibrate pitch</h1>
        <p className="mt-3 text-muted">The video needs to finish its checks before it can be calibrated.</p>
        <Link href={back} className="mt-4 inline-block text-mindaro underline underline-offset-4">
          Back to the match
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold uppercase tracking-tight">Calibrate pitch</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Show us where the pitch is: pick your pitch type, then click the points we ask for, one at a time. It takes
            about a minute, and you only need to do it once per camera spot.
          </p>
        </div>
        <Link href={back} className="text-sm text-mindaro underline underline-offset-4">
          Back to the match
        </Link>
      </div>
      <Calibrator
        orgId={actor.orgId}
        matchId={matchId}
        backHref={back}
        canEdit={can(actor.role, "match.update")}
        width={ctx.width}
        height={ctx.height}
        frames={ctx.frames}
        initial={ctx.latest}
        reusable={ctx.reusable}
      />
    </>
  );
}
