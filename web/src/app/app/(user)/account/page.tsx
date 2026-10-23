import { UserProfile } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Suspense } from "react";
import { Card } from "@/components/ui";
import { DeleteAccount } from "./delete-account";

export const metadata: Metadata = { title: "Account" };

export default function AccountPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <h1 className="font-display text-3xl font-bold uppercase tracking-tight">Account</h1>
      <p className="text-sm text-muted">
        Manage your profile, email, password, two-step verification and active sessions (you can sign out other
        devices here).
      </p>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-surface" />}>
        <UserProfile routing="hash" />
      </Suspense>
      <Card className="border-danger/40 p-6">
        <h2 className="text-lg font-semibold text-danger">Delete account</h2>
        <DeleteAccount />
      </Card>
    </div>
  );
}
