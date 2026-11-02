/**
 * Offline, said on every page (doc:33: "as transparent as they can of the fact
 * that they're offline"), and what was written offline sent the moment the
 * server can be reached again (Mark Q8 default). Links are plain anchors: a
 * client navigation needs the server, a full one is answered by the service
 * worker with the offline copy.
 */
"use client";

import { useEffect, useRef, useState } from "react";

import {
  countDrafts,
  getVault,
  isUnlocked,
  offlineSupported,
  unlockWithSignIn,
} from "@/lib/features/offline/offline-store";
import { sendDrafts } from "@/lib/features/offline/offline-sync";

import { useOnline } from "./use-online";

export function OfflineBanner() {
  const online = useOnline();
  const [waiting, setWaiting] = useState(0);
  const [sentNote, setSentNote] = useState<string | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    if (online !== true || !offlineSupported()) return;
    let abandoned = false;
    void (async () => {
      // Counted without opening the copy (0121): drafts are sealed on the device.
      const count = await countDrafts().catch(() => 0);
      if (abandoned || count === 0 || sending.current) {
        if (!abandoned) setWaiting(count);
        return;
      }
      // Signed in, the copy opens without its PIN. A sealed copy that won't
      // open stays as it is and is said; plain drafts from before 0121 (no
      // vault yet) can be read and sent as they are.
      if (!isUnlocked() && !(await unlockWithSignIn()) && (await getVault().catch(() => undefined))) {
        if (!abandoned) setWaiting(count);
        return;
      }
      sending.current = true;
      try {
        const r = await sendDrafts();
        if (abandoned) return;
        setWaiting(r.kept);
        if (r.sent > 0) setSentNote(`${r.sent} part${r.sent === 1 ? "" : "s"} of notes written offline sent to the visits.`);
      } catch {
        if (!abandoned) setWaiting(count);
      } finally {
        sending.current = false;
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [online]);

  if (online === false) {
    return (
      <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
        <strong>You&rsquo;re offline.</strong> Pallio can&rsquo;t reach the server, so nothing on this page can be saved.{" "}
        <a href="/offline" className="font-medium underline">
          Open the offline copy
        </a>{" "}
        to read your patients&rsquo; charts and write notes; they&rsquo;re sent when you&rsquo;re back online.
      </div>
    );
  }
  if (waiting > 0) {
    return (
      <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
        {waiting} part{waiting === 1 ? "" : "s"} of notes written offline could not be sent.{" "}
        <a href="/offline" className="font-medium underline">
          See why
        </a>
      </div>
    );
  }
  if (sentNote) {
    return (
      <div role="status" className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900">
        {sentNote} Sign each note on its visit page.
      </div>
    );
  }
  return null;
}
