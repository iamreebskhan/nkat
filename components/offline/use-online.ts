/**
 * Whether Pallio's server can be reached (doc:33: the app must be "as
 * transparent as they can of the fact that they're offline").
 *
 * navigator.onLine says only that the device has a network; an iPad on a
 * home's Wi-Fi with no internet still reports true. So the answer is the
 * ping's (/api/offline/ping), asked on load, when the device's network comes
 * or goes, and every 30 seconds. null until the first answer.
 */
"use client";

import { useEffect, useState } from "react";

const EVERY_MS = 30_000;

export async function serverReachable(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8_000);
    const r = await fetch("/api/offline/ping", { cache: "no-store", signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export function useOnline(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let abandoned = false;
    const check = () => {
      void (async () => {
        const ok = await serverReachable();
        if (!abandoned) setOnline(ok);
      })();
    };
    check();
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    const t = setInterval(check, EVERY_MS);
    return () => {
      abandoned = true;
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
      clearInterval(t);
    };
  }, []);
  return online;
}
