import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { AppShell, NavLink } from "@/components/app-shell";
import { Logo } from "@/components/ui";

/** Shell for user-level pages that don't belong to one workspace (account, new workspace). */
export default function UserLayout({ children }: LayoutProps<"/app">) {
  return (
    <AppShell
      sidebar={
        <div className="flex h-full flex-col gap-6 p-4">
          <Link href="/app" aria-label="Your workspace">
            <Logo className="text-lg" />
          </Link>
          <nav aria-label="Account" className="space-y-1">
            <NavLink href="/app">Back to my workspace</NavLink>
            <NavLink href="/app/new">New club workspace</NavLink>
            <NavLink href="/app/account">Account</NavLink>
          </nav>
        </div>
      }
      topbar={<UserButton />}
    >
      {children}
    </AppShell>
  );
}
