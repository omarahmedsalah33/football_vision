"use client";

import { useState } from "react";
import { Button } from "./ui";

export type PlayerFormValues = {
  name: string;
  position: "goalkeeper" | "defender" | "midfielder" | "forward" | null;
  preferredFoot: "left" | "right" | "both" | null;
  shirtNumber: number | null;
  birthYear: number | null;
  clubName: string | null;
};

const field = "mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2 text-fg";
const POSITIONS = [
  ["goalkeeper", "Goalkeeper"],
  ["defender", "Defender"],
  ["midfielder", "Midfielder"],
  ["forward", "Forward"],
] as const;
const FEET = [
  ["left", "Left"],
  ["right", "Right"],
  ["both", "Both"],
] as const;

function Choice<T extends string>({ legend, options, value, onChange }: { legend: string; options: readonly (readonly [T, string])[]; value: T | null; onChange: (v: T | null) => void }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={legend}>
        {options.map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onChange(value === v ? null : v)}
            className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${value === v ? "border-mindaro bg-accent-soft text-fg" : "border-border text-muted hover:border-border-strong hover:text-fg"}`}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Player details. Only the name is required; birth year (not date of birth) to keep data minimal. */
export function PlayerForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
  showClub = true,
}: {
  initial?: Partial<PlayerFormValues>;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (values: PlayerFormValues) => void;
  showClub?: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [position, setPosition] = useState<PlayerFormValues["position"]>(initial?.position ?? null);
  const [foot, setFoot] = useState<PlayerFormValues["preferredFoot"]>(initial?.preferredFoot ?? null);
  const [number, setNumber] = useState(initial?.shirtNumber?.toString() ?? "");
  const [birthYear, setBirthYear] = useState(initial?.birthYear?.toString() ?? "");
  const [club, setClub] = useState(initial?.clubName ?? "");

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          name: name.trim(),
          position,
          preferredFoot: foot,
          shirtNumber: number === "" ? null : Number(number),
          birthYear: birthYear === "" ? null : Number(birthYear),
          clubName: showClub && club.trim() ? club.trim() : null,
        });
      }}
    >
      <label className="block text-sm font-medium">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} className={field} placeholder="e.g. Omar Hassan" autoComplete="name" />
      </label>
      <Choice legend="Position" options={POSITIONS} value={position} onChange={setPosition} />
      <Choice legend="Stronger foot" options={FEET} value={foot} onChange={setFoot} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Shirt number <span className="font-normal text-muted">(optional)</span>
          <input value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" className={`font-data ${field}`} />
        </label>
        <label className="block text-sm font-medium">
          Birth year <span className="font-normal text-muted">(optional)</span>
          <input value={birthYear} onChange={(e) => setBirthYear(e.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" placeholder="e.g. 2008" className={`font-data ${field}`} />
        </label>
      </div>
      {showClub && (
        <label className="block text-sm font-medium">
          Club or team <span className="font-normal text-muted">(optional)</span>
          <input value={club} onChange={(e) => setClub(e.target.value)} maxLength={80} className={field} placeholder="e.g. Nile Stars Academy" />
        </label>
      )}
      <p className="text-xs text-muted">We only ask for the year of birth, never the full date. Your profile is private to your workspace.</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !name.trim()}>
        {busy ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
