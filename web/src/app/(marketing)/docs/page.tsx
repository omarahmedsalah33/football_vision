import type { Metadata } from "next";
import Link from "next/link";
import { PageHero } from "@/components/marketing/site-chrome";
import { Badge } from "@/components/ui";
import { can, PERMISSION_LABELS, ROLES, type Permission } from "@/server/authz/permissions";

export const metadata: Metadata = {
  title: "Docs",
  description: "How to film a match for analysis, upload it, understand the results and manage your team's access.",
};

const SECTIONS = [
  ["filming", "Film a match"],
  ["upload", "Upload footage"],
  ["results", "Understand results"],
  ["roles", "Roles & permissions"],
] as const;

export default function DocsPage() {
  const permissions = Object.keys(PERMISSION_LABELS) as Permission[];
  return (
    <>
      <PageHero eyebrow="Documentation" title={<>Getting <span className="text-mindaro">started</span></>}>
        Everything you need to go from a camera on a tripod to evidence you can coach with.
      </PageHero>
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[220px_1fr]">
        <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
          <p className="font-data text-xs uppercase tracking-[0.2em] text-muted">On this page</p>
          <ul className="mt-3 space-y-1">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="block rounded-md px-2 py-1.5 text-sm text-muted hover:bg-surface hover:text-fg">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="fv-prose max-w-3xl">
          <h2 id="filming" className="scroll-mt-24">
            1. Film a match
          </h2>
          <p>
            Analysis is built for a <strong>fixed, wide-angle camera</strong>. The better the footage, the more
            metrics can be measured instead of estimated.
          </p>
          <ul>
            <li>
              <strong>Position:</strong> raised (stand, roof, scaffold or tall tripod) and close to the halfway line.
              Higher is better: players overlap less.
            </li>
            <li>
              <strong>Framing:</strong> as much of the pitch as possible, including both penalty areas. Keep at least
              five pitch markings visible (corners, halfway line ends, centre spot; on full-size pitches also box
              corners and penalty spots) for calibration. Small-sided pitches (5- to 9-a-side) work too.
            </li>
            <li>
              <strong>Keep it still:</strong> no zooming, panning or moving the camera during a half. If the camera
              moves, calibrate again.
            </li>
            <li>
              <strong>Quality:</strong> 1080p or higher, 25 fps or more. The minimum accepted is 640×360 at 10 fps.
            </li>
            <li>
              <strong>Light:</strong> avoid filming into the sun; floodlit evening matches work if the whole pitch is
              lit.
            </li>
            <li>
              <strong>Consent:</strong> if you film minors, get their parents&apos; or guardians&apos; consent first.
            </li>
          </ul>

          <h2 id="upload" className="scroll-mt-24">
            2. Upload footage
          </h2>
          <ol>
            <li>Create a match: title, opponent and date.</li>
            <li>Choose the video file. It goes straight to private storage in parts; keep the tab open until it finishes.</li>
            <li>Football Vision checks the file (format, length, resolution, that it can be decoded) and queues the analysis.</li>
            <li>The match page updates by itself as processing moves along.</li>
          </ol>
          <p>
            Accepted formats: MP4, MOV, M4V, MKV, WebM. Maximum size and length depend on your plan (see{" "}
            <Link href="/pricing">pricing</Link>). A failed or cancelled analysis never counts against your monthly
            allowance.
          </p>

          <h2 id="results" className="scroll-mt-24">
            3. Understand results
          </h2>
          <p>Every number carries a label telling you how it was produced:</p>
          <table>
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Meaning</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <Badge tone="accent">Measured</Badge>
                </td>
                <td>Taken directly from calibrated video, in metres.</td>
              </tr>
              <tr>
                <td>
                  <Badge tone="info">Estimated</Badge>
                </td>
                <td>Computed from tracking that can have gaps. Shown with a quality indicator.</td>
              </tr>
              <tr>
                <td>
                  <Badge tone="gold">Inferred</Badge>
                </td>
                <td>An interpretation of the evidence, shown with the clips behind it and possible alternatives.</td>
              </tr>
              <tr>
                <td>
                  <Badge>Not available</Badge>
                </td>
                <td>The footage can&apos;t support this metric reliably, so we don&apos;t show a number.</td>
              </tr>
            </tbody>
          </table>
          <p>
            Before relying on results for important decisions, read the <Link href="/ai-limitations">AI limitations</Link>.
          </p>

          <h2 id="roles" className="scroll-mt-24">
            4. Roles & permissions
          </h2>
          <p>
            Each person in a workspace has one role. This table is generated from the same rules the server
            enforces.
          </p>
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th scope="col">Permission</th>
                  {ROLES.map((r) => (
                    <th key={r} scope="col" className="capitalize">
                      {r}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {permissions.map((p) => (
                  <tr key={p}>
                    <th scope="row" className="font-normal">
                      {PERMISSION_LABELS[p]}
                    </th>
                    {ROLES.map((r) => (
                      <td key={r} className="text-center">
                        {can(r, p) ? (
                          <span className="text-mindaro" aria-label="allowed">
                            ✓
                          </span>
                        ) : (
                          <span className="text-pitchline" aria-label="not allowed">
                            ·
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </div>
    </>
  );
}
