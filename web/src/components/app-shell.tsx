"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "./app-ui";

/** Authenticated layout: sidebar (drawer on mobile, collapsible on desktop) and a slim top bar. */
export function AppShell({ sidebar, topbar, children }: { sidebar: ReactNode; topbar: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  // The mobile drawer is open for the page it was opened on, so navigating closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const mobileOpen = openOn === pathname;
  const setMobileOpen = (open: boolean) => setOpenOn(open ? pathname : null);

  return (
    <div className="flex min-h-screen flex-1">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg">
        Skip to content
      </a>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" aria-hidden="true" onClick={() => setMobileOpen(false)} />}
      <aside
        id="app-sidebar"
        className={`fixed inset-y-0 left-0 z-40 w-72 shrink-0 border-r border-border bg-surface transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        } ${collapsed ? "lg:hidden" : ""}`}
        aria-label="Workspace navigation"
      >
        <div aria-hidden="true" className="fv-stripes pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative h-full overflow-y-auto">{sidebar}</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-bg/85 px-4 backdrop-blur sm:px-8">
          <button
            type="button"
            className="-ml-2 rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg"
            aria-controls="app-sidebar"
            aria-expanded={mobileOpen || !collapsed}
            aria-label="Toggle navigation"
            onClick={() => {
              if (window.matchMedia("(min-width: 1024px)").matches) setCollapsed((c) => !c);
              else setMobileOpen(!mobileOpen);
            }}
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <div className="ml-auto flex items-center gap-2">{topbar}</div>
        </header>
        <main id="main" className="relative flex-1 px-4 pb-16 pt-8 sm:px-8">
          {/* Soft brand glow behind the page header. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-72 opacity-50"
            style={{ background: "radial-gradient(60% 100% at 85% 0%, color-mix(in srgb, var(--lush) 35%, transparent), transparent)" }}
          />
          <div className="relative">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function NavLink({ href, icon, children, exact = false, count }: { href: string; icon: IconName; children: ReactNode; exact?: boolean; count?: number }) {
  const pathname = usePathname();
  const active = pathname === href || (!exact && pathname.startsWith(`${href}/`));
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
        active ? "bg-accent-soft text-mindaro" : "text-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      {active && <span aria-hidden="true" className="absolute -left-4 top-1.5 bottom-1.5 w-1 rounded-r-full bg-mindaro" />}
      <Icon name={icon} className={`h-5 w-5 ${active ? "text-mindaro" : "text-cascade/70 group-hover:text-fg"}`} />
      <span className="flex-1">{children}</span>
      {count !== undefined && count > 0 && (
        <span className="font-data rounded-full bg-bg px-2 py-0.5 text-[11px] text-muted" aria-hidden="true">
          {count}
        </span>
      )}
    </Link>
  );
}

export function WorkspaceSwitcher({ current, workspaces }: { current: string; workspaces: { slug: string; name: string; kind: string }[] }) {
  const router = useRouter();
  return (
    <label className="block">
      <span className="sr-only">Switch workspace</span>
      <select
        value={current}
        onChange={(e) => router.push(`/app/${e.target.value}`)}
        className="w-full cursor-pointer rounded-lg border border-border bg-bg/70 px-3 py-2 text-sm text-fg hover:border-border-strong"
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
