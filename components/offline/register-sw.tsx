/**
 * Registers the service worker (public/sw.js) that lets the offline copy open
 * with no signal. Renders nothing.
 */
"use client";

import { useEffect } from "react";

export function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // An unsupported or private browser: everything online still works.
    });
  }, []);
  return null;
}
