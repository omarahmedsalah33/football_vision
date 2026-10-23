import { SignIn } from "@clerk/nextjs";
import { Suspense } from "react";

export default function SignInPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <Suspense fallback={<div className="h-96 w-full max-w-sm animate-pulse rounded-xl bg-surface" />}>
        <SignIn fallbackRedirectUrl="/app" />
      </Suspense>
    </main>
  );
}
