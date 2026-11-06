/**
 * The notification bell (Level-1 doc:57).
 *
 * @mentions have written `notification` rows since 0046, and the sidebar
 * badge and dropdown they were for were never built, so a mention reached
 * nobody. The bell shows the unread count, the latest twenty, and marks one
 * read when it is opened (or all of them at once). It refreshes every
 * minute and whenever the window comes back into focus.
 *
 * Rendered twice, in the desktop sidebar and in the phone's top bar; only
 * the one on screen polls.
 */
"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { usePracticeDate } from "@/lib/features/schedule/use-practice-zone";
import { cn } from "@/lib/utils";

interface NotificationItem {
  id: string;
  title: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

interface Feed {
  notifications: NotificationItem[];
  unreadCount: number;
}

const DESKTOP = "(min-width: 768px)";

/** "just now", "5 min ago", "3 h ago", else the day as `day` reads it. */
function ago(iso: string, now: number, day: (iso: string) => string): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return day(iso);
}

function markRead(id?: string) {
  // keepalive: opening one navigates away, and the request must outlive the page.
  return fetch("/api/notifications", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(id ? { id } : {}),
    keepalive: true,
  }).catch(() => undefined);
}

export function NotificationBell({ placement }: { placement: "desktop" | "mobile" }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [open, setOpen] = useState(false);
  // The clock "5 min ago" is measured on, set with each load.
  const [now, setNow] = useState(0);
  // Bumped on each opening, so the list opened is fetched then, not up to a
  // minute old.
  const [opened, setOpened] = useState(0);
  // An older notification's day, on the practice's calendar.
  const atPracticeDay = usePracticeDate();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let abandoned = false;
    const media = window.matchMedia(DESKTOP);
    const mine = () => media.matches === (placement === "desktop");
    const load = () => {
      if (!mine()) return;
      fetch("/api/notifications?limit=20")
        .then((r) => r.json())
        .then((d) => {
          if (abandoned || !d.success) return;
          setFeed(d.data);
          setNow(Date.now());
        })
        .catch(() => {
          /* the badge keeps its last count */
        });
    };
    load();
    const timer = setInterval(load, 60_000);
    window.addEventListener("focus", load);
    media.addEventListener("change", load);
    return () => {
      abandoned = true;
      clearInterval(timer);
      window.removeEventListener("focus", load);
      media.removeEventListener("change", load);
    };
  }, [placement, opened]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const unread = feed?.unreadCount ?? 0;
  const items = feed?.notifications ?? [];

  function openOne(n: NotificationItem) {
    setOpen(false);
    if (n.readAt) return;
    void markRead(n.id);
    setFeed((f) =>
      f && {
        unreadCount: Math.max(0, f.unreadCount - 1),
        notifications: f.notifications.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)),
      },
    );
  }

  function readAll() {
    void markRead();
    const at = new Date().toISOString();
    setFeed((f) => f && { unreadCount: 0, notifications: f.notifications.map((x) => ({ ...x, readAt: x.readAt ?? at })) });
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => {
          if (!open) setOpened((n) => n + 1);
          setOpen(!open);
          setNow(Date.now());
        }}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative grid h-9 w-9 place-items-center rounded-md text-slate-300 hover:bg-white/10 hover:text-white"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white tabular">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className={cn(
            "absolute z-50 mt-2 w-80 max-w-[calc(100vw-1.5rem)] rounded-md border border-slate-200 bg-white text-slate-800 shadow-lg",
            placement === "desktop" ? "left-0 top-full" : "right-0 top-full",
          )}
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && (
              <button type="button" onClick={readAll} className="text-xs text-[var(--color-brand-700)] hover:underline">
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-500">
              Nothing yet. When someone @mentions you, it shows here.
            </p>
          ) : (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {items.map((n) => {
                const body = (
                  <span className="flex items-start gap-2">
                    <span
                      aria-hidden
                      className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-[var(--color-brand-600)]")}
                    />
                    <span className="min-w-0">
                      <span className={cn("block text-sm", !n.readAt && "font-medium")}>{n.title}</span>
                      <time dateTime={n.createdAt} className="block text-xs text-slate-500">
                        {ago(n.createdAt, now, atPracticeDay)}
                      </time>
                    </span>
                  </span>
                );
                return (
                  <li key={n.id}>
                    {n.href ? (
                      <Link href={n.href} onClick={() => openOne(n)} className="block px-3 py-2.5 hover:bg-slate-50">
                        {body}
                      </Link>
                    ) : (
                      <button type="button" onClick={() => openOne(n)} className="block w-full px-3 py-2.5 text-left hover:bg-slate-50">
                        {body}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
