"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

/** Authenticated layout: collapsible sidebar (drawer on mobile) and a contextual top bar. */
export function AppShell({ sidebar, topbar, children }: { sidebar: ReactNode; topbar: ReactNode; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex min-h-screen flex-1">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg">
        Skip to content
      </a>
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" aria-hidden="true" onClick={() => setMobileOpen(false)} />
      )}
      <aside
        id="app-sidebar"
        className={`fixed inset-y-0 left-0 z-40 w-64 shrink-0 border-r border-border bg-surface transition-transform lg:static lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        } ${collapsed ? "lg:hidden" : ""}`}
        aria-label="Workspace navigation"
      >
        {sidebar}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-bg/90 px-4 backdrop-blur">
          <button
            type="button"
            className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg"
            aria-controls="app-sidebar"
            aria-expanded={mobileOpen || !collapsed}
            aria-label="Toggle navigation"
            onClick={() => {
              if (window.matchMedia("(min-width: 1024px)").matches) setCollapsed((c) => !c);
              else setMobileOpen((o) => !o);
            }}
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <div className="ml-auto flex items-center gap-3">{topbar}</div>
        </header>
        <main id="main" className="flex-1 px-4 py-6 sm:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
        active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      {children}
    </Link>
  );
}

export function WorkspaceSwitcher({
  current,
  workspaces,
}: {
  current: string;
  workspaces: { slug: string; name: string; kind: string }[];
}) {
  const router = useRouter();
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">Workspace</span>
      <select
        value={current}
        onChange={(e) => router.push(`/app/${e.target.value}`)}
        className="w-full rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-sm text-fg"
      >
        {workspaces.map((w) => (
          <option key={w.slug} value={w.slug}>
            {w.kind === "personal" ? "Personal workspace" : w.name}
          </option>
        ))}
      </select>
    </label>
  );
}
