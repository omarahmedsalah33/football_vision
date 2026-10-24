import type { Metadata } from "next";
import { Suspense } from "react";
import { pageUser } from "@/server/auth/page";
import { WelcomeFlow } from "./welcome-flow";

export const metadata: Metadata = { title: "Welcome" };

export default function WelcomePage() {
  return (
    <div className="mx-auto max-w-4xl">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface" />}>
        <Welcome />
      </Suspense>
    </div>
  );
}

async function Welcome() {
  const user = await pageUser();
  return <WelcomeFlow name={user.displayName ?? ""} />;
}
