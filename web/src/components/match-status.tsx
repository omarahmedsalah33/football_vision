import type { MatchStatus } from "@/server/matches/service";
import { Badge } from "./ui";

export const STATUS: Record<MatchStatus, { label: string; tone: "neutral" | "accent" | "info" | "warning" | "danger"; help: string }> = {
  awaiting_upload: { label: "Awaiting video", tone: "neutral", help: "Upload the match footage to start." },
  uploading: { label: "Uploading", tone: "info", help: "An upload was started but has not finished." },
  upload_rejected: { label: "Upload rejected", tone: "danger", help: "The file could not be accepted. Upload a supported video." },
  ready: { label: "Ready", tone: "neutral", help: "The video is stored. Start an analysis when you are ready." },
  queued: { label: "Queued", tone: "info", help: "Waiting for an analysis worker." },
  processing: { label: "Processing", tone: "info", help: "The video is being analysed." },
  analyzed: { label: "Analysed", tone: "accent", help: "Processing finished." },
  failed: { label: "Failed", tone: "danger", help: "Processing did not complete. No results were produced." },
  cancelled: { label: "Cancelled", tone: "warning", help: "The analysis was cancelled; no allowance was used." },
};

export function MatchStatusBadge({ status }: { status: MatchStatus }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
