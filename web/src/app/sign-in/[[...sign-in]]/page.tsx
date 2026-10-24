import { SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { isSignedIn } from "@/components/marketing/account-actions";
import { Suspense } from "react";

export default async function SignInPage() {
  // Already signed in: go straight to the workspace instead of showing the form again.
  if (await isSignedIn()) redirect("/app");
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <Suspense fallback={<div className="h-96 w-full max-w-sm animate-pulse rounded-xl bg-surface" />}>
        <SignIn fallbackRedirectUrl="/app" />
      </Suspense>
    </main>
  );
}
