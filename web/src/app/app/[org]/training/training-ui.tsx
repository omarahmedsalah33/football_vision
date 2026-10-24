"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/app-ui";
import { Button } from "@/components/ui";
import { CATEGORY_LABEL, DIMENSIONS, type Category } from "@/lib/development/framework";
import { DIFFICULTIES, DIFFICULTY_LABEL, type Difficulty } from "@/lib/development/drills";
import { apiPost, apiRequest, ApiError } from "@/lib/api-client";
import { Dialog } from "../players/player-dialogs";

const field = "mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2 text-fg";
const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function CreateDrillButton({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ title: "", summary: "", difficulty: "beginner" as Difficulty, durationMinutes: "20", players: "", space: "", equipment: "", steps: "", coachingPoints: "", successCriteria: "", safety: "" });
  const [dims, setDims] = useState<string[]>([]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/orgs/${orgId}/drills`, {
        title: f.title,
        summary: f.summary,
        dimensions: dims,
        difficulty: f.difficulty,
        durationMinutes: Number(f.durationMinutes),
        players: f.players || "1 or more",
        space: f.space || "Any",
        equipment: f.equipment
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        steps: lines(f.steps),
        coachingPoints: lines(f.coachingPoints),
        successCriteria: f.successCriteria,
        safety: f.safety.trim() || null,
      });
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the drill.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Icon name="plus" className="h-4 w-4" />
        Add a drill
      </Button>
      <Dialog title="Add a drill" open={open} onClose={() => setOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block text-sm font-medium">
            Title
            <input className={field} value={f.title} onChange={set("title")} required minLength={3} maxLength={80} />
          </label>
          <label className="block text-sm font-medium">
            What it&apos;s for
            <textarea className={field} rows={2} value={f.summary} onChange={set("summary")} required minLength={10} maxLength={300} />
          </label>
          <fieldset>
            <legend className="text-sm font-medium">
              Areas it trains <span className="font-normal text-muted">(1 to 4; the first is the main one)</span>
            </legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                <div key={c}>
                  <p className="text-xs uppercase tracking-wider text-muted">{CATEGORY_LABEL[c]}</p>
                  {DIMENSIONS.filter((d) => d.category === c).map((d) => (
                    <label key={d.key} className="mt-1 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="accent-[var(--mindaro)]"
                        checked={dims.includes(d.key)}
                        disabled={!dims.includes(d.key) && dims.length >= 4}
                        onChange={() => setDims(dims.includes(d.key) ? dims.filter((x) => x !== d.key) : [...dims, d.key])}
                      />
                      {d.label}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block text-sm font-medium">
              Level
              <select className={field} value={f.difficulty} onChange={set("difficulty")}>
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {DIFFICULTY_LABEL[d]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium">
              Minutes
              <input className={`font-data ${field}`} inputMode="numeric" value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: e.target.value.replace(/\D/g, "").slice(0, 3) })} required />
            </label>
            <label className="block text-sm font-medium">
              Players
              <input className={field} value={f.players} onChange={set("players")} maxLength={40} placeholder="e.g. 2 or more" />
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              Space
              <input className={field} value={f.space} onChange={set("space")} maxLength={80} placeholder="e.g. 20 × 15 m" />
            </label>
            <label className="block text-sm font-medium">
              Equipment <span className="font-normal text-muted">(comma-separated)</span>
              <input className={field} value={f.equipment} onChange={set("equipment")} placeholder="Balls, 6 cones" />
            </label>
          </div>
          <label className="block text-sm font-medium">
            Steps <span className="font-normal text-muted">(one per line)</span>
            <textarea className={field} rows={4} value={f.steps} onChange={set("steps")} required />
          </label>
          <label className="block text-sm font-medium">
            Coaching points <span className="font-normal text-muted">(optional, one per line)</span>
            <textarea className={field} rows={2} value={f.coachingPoints} onChange={set("coachingPoints")} />
          </label>
          <label className="block text-sm font-medium">
            Success looks like
            <input className={field} value={f.successCriteria} onChange={set("successCriteria")} required minLength={5} maxLength={240} placeholder="e.g. 8 of 10 clean receptions" />
          </label>
          <label className="block text-sm font-medium">
            Safety note <span className="font-normal text-muted">(optional)</span>
            <input className={field} value={f.safety} onChange={set("safety")} maxLength={240} />
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || dims.length === 0}>
            {busy ? "Saving…" : "Save drill"}
          </Button>
        </form>
      </Dialog>
    </>
  );
}

export function ArchiveDrillButton({ orgId, drillId }: { orgId: string; drillId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="danger"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await apiRequest("DELETE", `/api/orgs/${orgId}/drills/${drillId}`);
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      Remove from library
    </Button>
  );
}
