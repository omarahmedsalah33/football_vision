"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui";
import { apiPost, ApiError } from "@/lib/api-client";

const field = "mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 text-fg placeholder:text-muted/70";

export function ContactForm() {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setState("sending");
    const f = new FormData(e.currentTarget);
    const text = (k: string) => (f.get(k) as string | null)?.trim() || undefined;
    try {
      await apiPost("/api/contact", {
        name: text("name"),
        email: text("email"),
        organization: text("organization"),
        topic: text("topic"),
        message: text("message"),
        website: text("website"),
      });
      setState("sent");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send your message. Check your connection.");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <div role="status" className="rounded-2xl border border-mindaro/40 bg-accent-soft p-8">
        <p className="font-display text-3xl font-bold uppercase text-mindaro">Message received</p>
        <p className="mt-2 text-muted">Thanks for reaching out. We&apos;ll reply to the email you gave us.</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 rounded-2xl border border-border bg-surface p-6 sm:p-8">
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Your name
          <input name="name" required minLength={2} maxLength={100} autoComplete="name" className={field} />
        </label>
        <label className="block text-sm font-medium">
          Email
          <input name="email" type="email" required maxLength={200} autoComplete="email" className={field} />
        </label>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Club or academy <span className="font-normal text-muted">(optional)</span>
          <input name="organization" maxLength={120} autoComplete="organization" className={field} />
        </label>
        <label className="block text-sm font-medium">
          Topic
          <select name="topic" required defaultValue="sales" className={field}>
            <option value="sales">Plans and pricing</option>
            <option value="support">Help with the product</option>
            <option value="partnership">Partnership</option>
            <option value="privacy">Privacy or data request</option>
            <option value="other">Something else</option>
          </select>
        </label>
      </div>
      <label className="block text-sm font-medium">
        Message
        <textarea name="message" required minLength={10} maxLength={4000} rows={6} className={field} />
      </label>
      {/* Honeypot: invisible to people and screen readers. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={state === "sending"}>
        {state === "sending" ? "Sending…" : "Send message"}
      </Button>
      <p className="text-xs text-muted">
        We only use these details to answer you. See our{" "}
        <Link href="/legal/privacy" className="text-mindaro underline underline-offset-4">
          privacy policy
        </Link>
        .
      </p>
    </form>
  );
}
