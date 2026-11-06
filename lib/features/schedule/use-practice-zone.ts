/**
 * The practice's clock for the schedule's screens. A visit happens where the
 * practice is, so the schedule, its booking form and the route sheet all read
 * and write that clock, wherever the person using them is. `differs` says the
 * browser is on another one, so the page can say which clock it shows.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import { orgDate, orgDateTime } from "@/lib/features/org/org-date";

export interface PracticeZone {
  timeZone: string;
  /** The practice's today, 'YYYY-MM-DD'. */
  today: string;
  /** 'ET' */
  zoneName: string;
  differs: boolean;
}

let asked: Promise<PracticeZone | null> | null = null;

function loadZone(): Promise<PracticeZone | null> {
  asked ??= fetch("/api/schedule/time-zone")
    .then((r) => r.json())
    .then((d) => {
      if (!d.success) {
        asked = null;
        return null;
      }
      const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return { ...d.data, differs: here !== d.data.timeZone } as PracticeZone;
    })
    .catch(() => {
      asked = null;
      return null;
    });
  return asked;
}

/**
 * The practice's clock, and whether asking for it failed: null with `failed`
 * false is still loading. A page that lists a day's visits needs the
 * difference, or a clock it could not read leaves it "Loading…" for good.
 */
export function usePracticeZoneStatus(): { zone: PracticeZone | null; failed: boolean } {
  const [state, setState] = useState<{ zone: PracticeZone | null; failed: boolean }>({ zone: null, failed: false });
  useEffect(() => {
    let abandoned = false;
    void loadZone().then((z) => {
      if (!abandoned) setState({ zone: z, failed: z === null });
    });
    return () => {
      abandoned = true;
    };
  }, []);
  return state;
}

export function usePracticeZone(): PracticeZone | null {
  return usePracticeZoneStatus().zone;
}

/**
 * A time a record carries, on the practice's clock: "Nov 5, 2026, 10:00 AM
 * EST". "…" while the clock is asked for. If it cannot be had, UTC, saying so:
 * never the browser's clock, which is what every one of these used to show.
 */
export function usePracticeTime(): (at: string | Date) => string {
  const { zone, failed } = usePracticeZoneStatus();
  const timeZone = zone?.timeZone ?? (failed ? "UTC" : null);
  return useCallback((at: string | Date) => (timeZone === null ? "…" : orgDateTime(at, timeZone)), [timeZone]);
}

/**
 * The day a record carries, on the practice's calendar: "Mar 12, 2026". "…"
 * while the clock is asked for; if it cannot be had, the day in UTC.
 */
export function usePracticeDate(): (at: string | Date) => string {
  const { zone, failed } = usePracticeZoneStatus();
  const timeZone = zone?.timeZone ?? (failed ? "UTC" : null);
  return useCallback((at: string | Date) => (timeZone === null ? "…" : orgDate(at, timeZone)), [timeZone]);
}
