"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { ApiError, apiRequest } from "@/lib/api-client";
import type { LineupInput, SevenAsideExperience } from "@/lib/seven-a-side";

type Slot = { name: string; shirt: string };
const blank = (): Slot => ({ name: "", shirt: "" });
const slotsFor = (exp: SevenAsideExperience | null, team: "a" | "b"): Slot[] =>
  Array.from({ length: 7 }, (_, i) => {
    const p = exp?.players.find(x => x.id === `${team}${i + 1}`);
    return p ? { name: p.name, shirt: p.shirtNumber === null ? "" : String(p.shirtNumber) } : blank();
  });

export function SevenAsideLineup({ orgId, matchId, initial, canEdit }: {
  orgId: string; matchId: string; initial: SevenAsideExperience | null; canEdit: boolean;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const lastInitial = useRef(initial);
  const [editing, setEditing] = useState(canEdit && !initial);
  const [names, setNames] = useState({ a: initial?.teamAName ?? "Team A", b: initial?.teamBName ?? "Team B" });
  const [slots, setSlots] = useState({ a: slotsFor(initial, "a"), b: slotsFor(initial, "b") });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const onFocus = () => { if (!editing && !busy) router.refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [router, editing, busy]);
  useEffect(() => {
    if (lastInitial.current === initial || editing || busy || dirty) return;
    lastInitial.current = initial;
    setSaved(initial);
    setNames({ a: initial?.teamAName ?? "Team A", b: initial?.teamBName ?? "Team B" });
    setSlots({ a: slotsFor(initial, "a"), b: slotsFor(initial, "b") });
  }, [initial, editing, busy, dirty]);

  const setSlot = (t: "a" | "b", i: number, patch: Partial<Slot>) => {
    setDirty(true); setSlots(s => ({ ...s, [t]: s[t].map((x, j) => (j === i ? { ...x, ...patch } : x)) })); };

  async function save() {
    setError(null);
    const players: LineupInput["players"] = [];
    for (const t of ["a", "b"] as const) {
      const seen = new Set<number>();
      for (let i = 0; i < 7; i++) {
        const s = slots[t][i], name = s.name.trim();
        if (!name) { if (s.shirt.trim()) { setError(`${names[t] || "Team"}: slot ${i + 1} has a shirt number but no name.`); return; } continue; }
        let shirtNumber: number | null = null;
        if (s.shirt.trim()) {
          shirtNumber = Number(s.shirt);
          if (!Number.isInteger(shirtNumber) || shirtNumber < 0 || shirtNumber > 99) { setError("Shirt numbers must be whole numbers from 0 to 99."); return; }
          if (seen.has(shirtNumber)) { setError("Shirt numbers must be different within each team."); return; }
          seen.add(shirtNumber);
        }
        players.push({ id: `${t}${i + 1}`, team: t, name, shirtNumber });
      }
    }
    if (!names.a.trim() || !names.b.trim()) { setError("Both teams need a name."); return; }
    setBusy(true);
    try {
      const res = await apiRequest<{ experience: SevenAsideExperience }>("PATCH", `/api/orgs/${orgId}/matches/${matchId}/seven-a-side`,
        { op: "lineup", lineup: { teamAName: names.a.trim(), teamBName: names.b.trim(), players } });
      setSaved(res.experience); setDirty(false); setEditing(false); router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the line-up. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  function cancel() {
    setNames({ a: saved?.teamAName ?? "Team A", b: saved?.teamBName ?? "Team B" });
    setSlots({ a: slotsFor(saved, "a"), b: slotsFor(saved, "b") });
    setError(null); setDirty(false); setEditing(false);
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">7-a-side line-ups</h2>
          <p className="mt-1 text-sm text-muted">Up to seven named players per team. Empty slots are left out.</p>
        </div>
        {canEdit && !editing && <Button variant="secondary" onClick={() => setEditing(true)}>{saved ? "Edit line-ups" : "Add line-ups"}</Button>}
        {!canEdit && <Badge>Read only</Badge>}
      </div>
      {!editing && !saved && <p className="mt-4 text-sm text-muted">No line-ups yet.{canEdit ? " Add names to get player stat cards after analysis." : ""}</p>}
      {!editing && saved && (
        <div className="mt-4 grid gap-6 sm:grid-cols-2">
          {(["a", "b"] as const).map(t => (
            <div key={t}>
              <h3 className="font-semibold">{t === "a" ? saved.teamAName : saved.teamBName}</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {saved.players.filter(p => p.team === t).map(p => (
                  <li key={p.id}><span className="font-data inline-block w-8 text-muted">{p.shirtNumber ?? "–"}</span>{p.name}</li>
                ))}
                {saved.players.every(p => p.team !== t) && <li className="text-muted">No players named.</li>}
              </ul>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <form className="mt-4 space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}>
          <div className="grid gap-6 sm:grid-cols-2">
            {(["a", "b"] as const).map(t => (
              <fieldset key={t} className="space-y-2">
                <legend className="sr-only">Team {t.toUpperCase()}</legend>
                <label className="block text-xs text-muted">Team name
                  <input value={names[t]} maxLength={40} onChange={e => { setDirty(true); setNames(n => ({ ...n, [t]: e.target.value })); }}
                    className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg" />
                </label>
                {slots[t].map((s, i) => (
                  <div key={i} className="flex gap-2">
                    <input aria-label={`${names[t]} player ${i + 1} name`} placeholder={`Player ${i + 1}`} value={s.name} maxLength={60}
                      onChange={e => setSlot(t, i, { name: e.target.value })}
                      className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg" />
                    <input aria-label={`${names[t]} player ${i + 1} shirt number`} placeholder="No." inputMode="numeric" value={s.shirt} maxLength={2}
                      onChange={e => setSlot(t, i, { shirt: e.target.value.replace(/\D/g, "") })}
                      className="font-data w-16 rounded-lg border border-border bg-bg px-2 py-2 text-sm text-fg" />
                  </div>
                ))}
              </fieldset>
            ))}
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save line-ups"}</Button>
            {saved && <Button type="button" variant="secondary" disabled={busy} onClick={cancel}>Cancel</Button>}
          </div>
        </form>
      )}
    </Card>
  );
}
