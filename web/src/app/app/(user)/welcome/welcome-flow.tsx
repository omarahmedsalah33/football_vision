"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon, type IconName } from "@/components/app-ui";
import { PlayerForm, type PlayerFormValues } from "@/components/player-form";
import { CornerMarks } from "@/components/ui";
import { apiPost, ApiError } from "@/lib/api-client";

type Persona = "player" | "coach" | "club" | "scout" | "parent";

const CHOICES: { persona: Persona; title: string; text: string; icon: IconName }[] = [
  { persona: "player", title: "I'm a player", text: "Build my own profile from my matches: score, speed, sprints, strengths.", icon: "user" },
  { persona: "coach", title: "I coach a team", text: "Analyse my team's matches and every player in the squad.", icon: "members" },
  { persona: "club", title: "Club or academy", text: "One workspace for the whole club, with staff roles.", icon: "club" },
  { persona: "scout", title: "I'm a scout", text: "Compare players on evidence, not highlight reels.", icon: "analyse" },
  { persona: "parent", title: "I'm a parent", text: "Follow my child's progress, match after match.", icon: "home" },
];

export function WelcomeFlow({ name }: { name: string }) {
  const router = useRouter();
  const [persona, setPersona] = useState<Persona | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish(body: object) {
    setBusy(true);
    setError(null);
    try {
      const { next } = await apiPost<{ next: string }>("/api/onboarding", body);
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="fv-stripes relative overflow-hidden rounded-2xl border border-border bg-surface px-6 py-10 sm:px-10">
        <CornerMarks tone="mindaro" size={22} />
        <p className="font-data text-xs uppercase tracking-[0.22em] text-mindaro">Train. Measure. Perform. Discover.</p>
        <h1 className="mt-3 font-display text-5xl font-extrabold uppercase italic leading-[0.9] tracking-tight sm:text-6xl">
          Welcome{name ? `, ${name.split(" ")[0]}` : ""}
        </h1>
        <p className="mt-3 max-w-xl text-muted">How will you use Football Vision? We&apos;ll set things up for you. You can change this later.</p>
        <button type="button" disabled={busy} onClick={() => void finish({ persona: "skip" })} className="mt-4 text-sm text-muted underline underline-offset-4 hover:text-fg">
          Skip for now
        </button>
      </section>

      {persona !== "player" ? (
        <div role="radiogroup" aria-label="How will you use Football Vision?" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CHOICES.map((c) => (
            <button
              key={c.persona}
              type="button"
              role="radio"
              aria-checked={persona === c.persona}
              disabled={busy}
              onClick={() => (c.persona === "player" ? setPersona("player") : (setPersona(c.persona), void finish({ persona: c.persona })))}
              className="group flex h-full flex-col items-start gap-3 rounded-2xl border border-border bg-surface p-6 text-left transition-colors hover:border-mindaro/60 aria-checked:border-mindaro aria-checked:bg-accent-soft"
            >
              <span className="grid h-12 w-12 place-items-center rounded-xl border border-mindaro/40 bg-accent-soft text-mindaro">
                <Icon name={c.icon} className="h-6 w-6" />
              </span>
              <span className="font-display text-2xl font-bold uppercase group-hover:text-mindaro">{c.title}</span>
              <span className="text-sm text-muted">{c.text}</span>
            </button>
          ))}
        </div>
      ) : (
        <section aria-labelledby="profile-h" className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="rounded-2xl border border-border bg-surface p-6">
            <h2 id="profile-h" className="font-display text-3xl font-bold uppercase">Your player profile</h2>
            <p className="mt-1 text-sm text-muted">Tell us a little about you. After each match you upload, tap &ldquo;This is me&rdquo; on your player card and your profile fills in.</p>
            <div className="mt-6">
              <PlayerForm
                initial={{ name }}
                submitLabel="Create my profile"
                busy={busy}
                error={error}
                onSubmit={(profile: PlayerFormValues) => void finish({ persona: "player", profile })}
              />
            </div>
          </div>
          <aside className="h-fit rounded-2xl border border-border bg-surface p-6 text-sm">
            <h3 className="font-semibold">What you&apos;ll get</h3>
            <ul className="mt-3 space-y-2 text-muted">
              {[
                "A score out of 100 for every match",
                "Your form over time",
                "Top speed, sprints and distance",
                "Strengths that hold across matches",
                "Where you play: your heatmap",
              ].map((t) => (
                <li key={t} className="flex gap-2">
                  <Icon name="check" className="mt-0.5 h-4 w-4 text-mindaro" />
                  {t}
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setPersona(null)} className="mt-5 text-mindaro underline underline-offset-4">
              Back
            </button>
          </aside>
        </section>
      )}
      {error && persona !== "player" && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
