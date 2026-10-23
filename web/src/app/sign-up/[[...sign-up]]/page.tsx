import { SignUp } from "@clerk/nextjs";
import { Suspense } from "react";

export default function SignUpPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <Suspense fallback={<div className="h-96 w-full max-w-sm animate-pulse rounded-xl bg-surface" />}>
        <SignUp fallbackRedirectUrl="/app" />
      </Suspense>
    </main>
  );
}
