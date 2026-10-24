"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/app-ui";
import { PlayerForm, type PlayerFormValues } from "@/components/player-form";
import { Button } from "@/components/ui";
import { apiPost, apiRequest, ApiError } from "@/lib/api-client";

export function Dialog({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title} className="m-auto w-[min(640px,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-0 text-fg backdrop:bg-black/70">
      {open && (
        <div className="relative max-h-[85vh] overflow-y-auto p-6">
          <button type="button" onClick={onClose} autoFocus aria-label="Close" className="absolute right-3 top-3 rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg">
            <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true">
              <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <h2 className="pr-10 font-display text-3xl font-bold uppercase">{title}</h2>
          <div className="mt-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function AddPlayerButton({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create(values: PlayerFormValues) {
    setBusy(true);
    setError(null);
    try {
      const p = await apiPost<{ id: string }>(`/api/orgs/${orgId}/players`, values);
      setOpen(false);
      router.push(`/app/${orgSlug}/players/${p.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the player.");
      setBusy(false);
    }
  }
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Icon name="plus" className="h-4 w-4" />
        Add player
      </Button>
      <Dialog title="Add a player" open={open} onClose={() => setOpen(false)}>
        <PlayerForm submitLabel="Add player" busy={busy} error={error} onSubmit={create} />
      </Dialog>
    </>
  );
}

export function EditPlayerButton({ orgId, orgSlug, player, canArchive }: { orgId: string; orgSlug: string; player: PlayerFormValues & { id: string }; canArchive: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  async function save(values: PlayerFormValues) {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("PATCH", `/api/orgs/${orgId}/players/${player.id}`, values);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    setBusy(true);
    try {
      await apiRequest("DELETE", `/api/orgs/${orgId}/players/${player.id}`);
      router.push(`/app/${orgSlug}/players`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove the player.");
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Icon name="edit" className="h-4 w-4" />
        Edit profile
      </Button>
      <Dialog title="Edit profile" open={open} onClose={() => setOpen(false)}>
        <PlayerForm initial={player} submitLabel="Save changes" busy={busy} error={error} onSubmit={save} />
        {canArchive && (
          <div className="mt-6 border-t border-border pt-4 text-sm">
            {!confirmArchive ? (
              <button type="button" className="text-danger underline underline-offset-4" onClick={() => setConfirmArchive(true)}>
                Remove from squad
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <span>Remove {player.name}? Past match links are kept for the record.</span>
                <Button variant="danger" disabled={busy} onClick={() => void archive()}>
                  Yes, remove
                </Button>
                <Button variant="ghost" onClick={() => setConfirmArchive(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
