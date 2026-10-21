/**
 * Pallio sidebar — role-aware navigation shell.
 *
 * The Server Component (PlatformLayout) passes a serializable item
 * list to this client component. Icons are referenced by string name
 * and resolved here at render time, avoiding the Server→Client
 * function-serialization error.
 *
 * Sources:
 *   - pallio_ui_playbook §4.1 (manifest pattern)
 *   - pallio_ui_playbook §7.1 (composition)
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  BadgeCheck,
  BookOpen,
  Building2,
  Calendar,
  ClipboardList,
  FileStack,
  FileText,
  HeartPulse,
  HelpCircle,
  Inbox,
  LineChart,
  LogOut,
  type LucideIcon,
  Receipt,
  ScrollText,
  SearchCheck,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";

import { AmaLicenseBadge } from "@/components/AmaLicenseBadge";
import { cn } from "@/lib/utils";

/**
 * Icon registry — keep in sync with `lib/manifests.ts`.
 *
 * Adding an icon? Import it above and add the mapping. Manifests
 * reference icons by string name only.
 */
const ICONS: Record<string, LucideIcon> = {
  AlertTriangle,
  BadgeCheck,
  BookOpen,
  Building2,
  Calendar,
  ClipboardList,
  FileStack,
  FileText,
  HeartPulse,
  Inbox,
  LineChart,
  Receipt,
  ScrollText,
  SearchCheck,
  Settings,
  ShieldCheck,
  Users,
};

export type SerializableNavItem = {
  label: string;
  href: string;
  icon: keyof typeof ICONS | string;
  badge?: number;
};

type Props = {
  items: SerializableNavItem[];
  badges?: Record<string, number>;
  orgName?: string;
  userEmail?: string;
};

export function Sidebar({ items, badges = {}, orgName, userEmail }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // The drawer closes on the tap that navigates (see the nav links below)
  // rather than in an effect watching pathname — same result, no cascading
  // render, and it also closes when the tapped link is the current page.

  return (
    <>
      {/*
        Below md the sidebar becomes a drawer and this bar carries the toggle.

        A fixed 256px `w-64` left 119px of usable width on a 375px screen —
        measured, not estimated, and flagged in globals.css as needing a design
        change rather than a stylesheet one. That matters because the client
        told us what the device is, 20 Aug 2026 [12:30]: "most nurse
        practitioners actually see the patients with an iPad and touchscreen."
      */}
      <div className="md:hidden fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 border-b border-slate-800 bg-[var(--color-sidebar-bg)] px-3 text-[var(--color-sidebar-fg)]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="primary-nav"
          aria-label={open ? "Close navigation" : "Open navigation"}
          className="grid h-11 w-11 place-items-center rounded-md text-2xl leading-none text-white hover:bg-white/10"
        >
          {open ? "×" : "☰"}
        </button>
        <span className="font-display text-lg tracking-tight text-white">Pallio</span>
      </div>

      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
          className="md:hidden fixed inset-0 z-40 bg-black/50"
        />
      )}

      <aside
        id="primary-nav"
        className={cn(
          "flex flex-col w-64 shrink-0 border-r border-slate-800",
          "bg-[var(--color-sidebar-bg)] text-[var(--color-sidebar-fg)]",
          "h-screen sticky top-0",
          // Off-canvas drawer under md; unchanged sticky column at md and up.
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50",
          "max-md:transition-transform max-md:duration-200 motion-reduce:max-md:transition-none",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
        )}
        aria-label="Primary navigation"
        aria-hidden={undefined}
      >
      {/* Brand */}
      <div className="px-5 py-5 border-b border-slate-800">
        <div className="font-display text-xl tracking-tight text-white">
          Pallio
        </div>
        {orgName && (
          <div className="text-xs text-slate-400 mt-0.5 truncate">{orgName}</div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2" aria-label="Main">
        <ul className="space-y-0.5">
          {items.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== "/" && pathname.startsWith(item.href + "/"));
            const Icon = ICONS[item.icon] ?? ClipboardList;
            const badge = badges[item.href] ?? item.badge;

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm",
                    "transition-colors",
                    active
                      ? "bg-[var(--color-sidebar-accent)] text-white font-medium"
                      : "hover:bg-slate-800 hover:text-white",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="flex-1 truncate">{item.label}</span>
                  {badge !== undefined && badge > 0 && (
                    <span
                      className={cn(
                        "rounded-md px-1.5 text-xs font-medium tabular",
                        active
                          ? "bg-white/20 text-white"
                          : "bg-slate-700 text-slate-200",
                      )}
                    >
                      {badge}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User */}
      {userEmail && (
        <div className="px-3 py-3 border-t border-slate-800">
          <Link
            href="/settings/account"
            className="block px-3 py-2 rounded-md bg-slate-800/40 hover:bg-slate-800/70 text-xs text-slate-300 hover:text-white truncate transition-colors"
            title="Your account"
          >
            {userEmail}
          </Link>
          <div className="px-3 mt-2 flex items-center justify-between gap-2">
            <AmaLicenseBadge />
            <div className="flex items-center gap-2">
              <a
                href="mailto:support@pallio.io?subject=Pallio%20support%20request"
                className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white transition-colors"
                title="Email support"
              >
                <HelpCircle className="h-3 w-3" aria-hidden />
                Help
              </a>
              <LogoutButton />
            </div>
          </div>
        </div>
      )}
    </aside>
    </>
  );
}

function LogoutButton() {
  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Hard redirect so any cached client state is dropped.
      window.location.href = "/login";
    }
  }
  return (
    <button
      type="button"
      onClick={logout}
      className="inline-flex items-center gap-1 text-[11px] text-slate-300 hover:text-white hover:bg-slate-800/60 rounded px-2 py-1 transition-colors"
      title="Sign out"
    >
      <LogOut className="h-3 w-3" aria-hidden />
      Sign out
    </button>
  );
}
