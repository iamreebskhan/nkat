/**
 * The practice's clock for the schedule's screens. A visit happens where the
 * practice is, so the schedule, its booking form and the route sheet all read
 * and write that clock, wherever the person using them is. `differs` says the
 * browser is on another one, so the page can say which clock it shows.
 */
"use client";

import { useEffect, useState } from "react";

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

export function usePracticeZone(): PracticeZone | null {
  const [zone, setZone] = useState<PracticeZone | null>(null);
  useEffect(() => {
    let abandoned = false;
    void loadZone().then((z) => {
      if (!abandoned) setZone(z);
    });
    return () => {
      abandoned = true;
    };
  }, []);
  return zone;
}
