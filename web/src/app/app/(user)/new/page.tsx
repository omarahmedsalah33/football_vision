import type { Metadata } from "next";
import { NewWorkspaceForm } from "./new-workspace-form";

export const metadata: Metadata = { title: "New workspace" };

export default function NewWorkspacePage() {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="font-display text-3xl font-bold uppercase tracking-tight">New club workspace</h1>
      <p className="mt-1 text-sm text-muted">
        A shared space for your club or academy: invite staff and players, each with their own role. You will be its
        owner.
      </p>
      <NewWorkspaceForm />
    </div>
  );
}
