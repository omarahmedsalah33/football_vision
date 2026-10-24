import { auth } from "@clerk/nextjs/server";
import type { ReactNode } from "react";
import { ButtonLink } from "../ui";

/** Whether the visitor has a session. Display only: every app page and API checks identity itself. */
export async function isSignedIn() {
  const { userId } = await auth();
  return !!userId;
}

/** "Start free" for visitors, "Open your workspace" for people already signed in. */
export async function StartButton({ className = "", children = "Start free" }: { className?: string; children?: ReactNode }) {
  return (await isSignedIn()) ? (
    <ButtonLink href="/app" className={className}>
      Open your workspace
    </ButtonLink>
  ) : (
    <ButtonLink href="/sign-up" className={className}>
      {children}
    </ButtonLink>
  );
}
