import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink, Card, Logo } from "@/components/ui";
import { getDb } from "@/server/db/client";
import { previewInvitation } from "@/server/members/service";
import { AcceptInvitation } from "./accept";

export const metadata: Metadata = { title: "Invitation", robots: { index: false } };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const invitation = await previewInvitation(getDb(), token);
  const { userId } = await auth();
  const here = `/invite/${encodeURIComponent(token)}`;

  return (
    <main className="fv-stripes flex flex-1 items-center justify-center px-4 py-16">
      <Card className="w-full max-w-md p-8 text-center" corners="mindaro">
        <Link href="/" aria-label="Football Vision home" className="inline-block">
          <Logo />
        </Link>
        {!invitation ? (
          <>
            <h1 className="mt-6 font-display text-3xl font-bold uppercase">Invitation not valid</h1>
            <p className="mt-2 text-muted">
              It may have expired, been used already or been revoked. Ask the person who invited you for a new link.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-6 font-display text-3xl font-bold uppercase">Join {invitation.orgName}</h1>
            <p className="mt-2 text-muted">
              You&apos;ve been invited as <span className="font-semibold capitalize text-fg">{invitation.role}</span>. The
              invitation is for <span className="text-fg">{invitation.email}</span>.
            </p>
            <div className="mt-6">
              {userId ? (
                <AcceptInvitation token={token} />
              ) : (
                <div className="flex flex-col gap-3">
                  <ButtonLink href={`/sign-up?redirect_url=${encodeURIComponent(here)}`}>Create an account to join</ButtonLink>
                  <ButtonLink href={`/sign-in?redirect_url=${encodeURIComponent(here)}`} variant="secondary">
                    I already have an account
                  </ButtonLink>
                </div>
              )}
            </div>
          </>
        )}
      </Card>
    </main>
  );
}
