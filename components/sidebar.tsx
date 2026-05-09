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
  Inbox,
  LineChart,
  type LucideIcon,
  Receipt,
  ScrollText,
  SearchCheck,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";

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

  return (
    <aside
      className={cn(
        "flex flex-col w-64 shrink-0 border-r border-slate-800",
        "bg-[var(--color-sidebar-bg)] text-[var(--color-sidebar-fg)]",
        "h-screen sticky top-0",
      )}
      aria-label="Primary navigation"
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
          <div className="px-3 py-2 rounded-md bg-slate-800/40 text-xs text-slate-300 truncate">
            {userEmail}
          </div>
        </div>
      )}
    </aside>
  );
}
