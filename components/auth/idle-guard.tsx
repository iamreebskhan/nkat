"use client";

/**
 * Automatic logoff in the browser (0121; HIPAA 164.312(a)(2)(iii), ONC (d)(5)).
 *
 * The server is what ends a session: past its idle limit, getSession() refuses
 * it on every route and page. This is the half a person sees:
 *
 *   - real input (a key, a click, a touch, the wheel) tells the server the
 *     session is in use, at most once a minute. Background refreshes — the
 *     notification bell, the offline ping — never do, so an open tab nobody
 *     touches still runs out.
 *   - in the last stretch before the limit it warns, with a button to stay;
 *   - at the limit it leaves the page for /login, so a screen left open in a
 *     patient's home stops showing the chart;
 *   - when that report says the practice now requires a second factor of this
 *     person, it asks them to go and set one up.
 *
 * Several tabs share one session. Before warning or signing out, a tab asks the
 * server when the session was last used, so a tab left in the background does
 * not sign out someone working in another.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { MFA_SETUP_PATH } from "@/components/auth/mfa-gate";
import { Button } from "@/components/ui/button";

/** At most this often does input refresh the session. */
const BEAT_EVERY_MS = 60_000;
/** How often the countdown is looked at. */
const TICK_MS = 5_000;

type Check =
  | { state: "alive"; act: number; idleMinutes: number; mfaPending: boolean }
  | { state: "expired" }
  | { state: "unreachable" };

async function askServer(method: "GET" | "POST"): Promise<Check> {
  try {
    const res = await fetch("/api/auth/activity", { method, cache: "no-store" });
    if (res.status === 401) return { state: "expired" };
    const d = await res.json();
    if (!d.success) return { state: "unreachable" };
    return {
      state: "alive",
      act: Number(d.data.act),
      idleMinutes: Number(d.data.idleMinutes),
      mfaPending: d.data.mfaPending === true,
    };
  } catch {
    return { state: "unreachable" };
  }
}

export function IdleGuard({ idleMinutes, act }: { idleMinutes: number; act: number }) {
  const idleMs = useRef(idleMinutes * 60_000);
  const deadline = useRef(act * 1000 + idleMinutes * 60_000);
  const lastInput = useRef(0);
  // Counted from the session's own last activity, not from when this page
  // loaded: a page opened late in a quiet stretch reports its first input at
  // once, instead of up to a minute later, into the warning.
  const lastBeat = useRef(act * 1000);
  const leaving = useRef(false);
  const warning = useRef(false);
  const stayedAt = useRef(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [limitMinutes, setLimitMinutes] = useState(idleMinutes);
  const [mfaOwed, setMfaOwed] = useState(false);

  const adopt = useCallback((c: Extract<Check, { state: "alive" }>) => {
    idleMs.current = c.idleMinutes * 60_000;
    deadline.current = c.act * 1000 + idleMs.current;
    setLimitMinutes(c.idleMinutes);
  }, []);

  const signOut = useCallback(async () => {
    if (leaving.current) return;
    leaving.current = true;
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "idle" }),
      });
    } catch {
      /* the server already refuses the session; leaving the page is what matters */
    }
    // Offline copies stay on the device (they are locked separately); only the
    // screen is left.
    window.location.href = "/login?reason=idle";
  }, []);

  const beat = useCallback(async () => {
    const reportedAt = Date.now();
    lastBeat.current = reportedAt;
    const c = await askServer("POST");
    if (c.state === "alive") {
      adopt(c);
      warning.current = false;
      setSecondsLeft(null);
      const owed = c.mfaPending && !window.location.pathname.startsWith(MFA_SETUP_PATH);
      // The press on "Stay" is itself input, so this report can land just after
      // it: the answer stands until the next one.
      if (!owed || stayedAt.current < reportedAt) setMfaOwed(owed);
    } else if (c.state === "expired") {
      await signOut();
    }
  }, [adopt, signOut]);

  const stay = useCallback(() => {
    stayedAt.current = Date.now();
    setMfaOwed(false);
  }, []);

  useEffect(() => {
    // A device clock behind the server's must not hold the first report back.
    lastBeat.current = Math.min(lastBeat.current, Date.now());
    const onInput = () => {
      lastInput.current = Date.now();
      // Input while the warning shows keeps the session at once; otherwise at
      // most once a minute.
      if (warning.current || Date.now() - lastBeat.current >= BEAT_EVERY_MS) void beat();
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, onInput, { passive: true, capture: true });

    const tick = window.setInterval(async () => {
      if (leaving.current) return;
      const now = Date.now();
      // Input in the last minute that has not been reported yet.
      if (lastInput.current > lastBeat.current && now - lastBeat.current >= BEAT_EVERY_MS) {
        await beat();
        return;
      }
      const warnFor = Math.min(120_000, idleMs.current / 5);
      if (deadline.current - now > warnFor) return;
      // Near the limit: another tab may have used the session since.
      const c = await askServer("GET");
      if (c.state === "alive") adopt(c);
      const left = deadline.current - Date.now();
      if (c.state === "expired" || left <= 0) {
        await signOut();
        return;
      }
      if (left <= warnFor) {
        warning.current = true;
        setSecondsLeft(Math.ceil(left / 1000));
      } else {
        warning.current = false;
        setSecondsLeft(null);
      }
    }, TICK_MS);

    return () => {
      for (const e of events) window.removeEventListener(e, onInput, { capture: true });
      window.clearInterval(tick);
    };
  }, [adopt, beat, signOut]);

  if (secondsLeft === null) return mfaOwed ? <MfaOwed onStay={stay} /> : null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 px-4" role="presentation">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="idle-title"
        aria-describedby="idle-body"
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 id="idle-title" className="font-display text-lg">Still there?</h2>
        <p id="idle-body" className="mt-2 text-sm text-slate-700">
          To protect patient information, Pallio signs you out after {limitMinutes} minutes with nothing done.
          Signing out in <span className="tabular font-semibold">{secondsLeft}</span> seconds.
        </p>
        <div className="mt-4 flex justify-end">
          <Button autoFocus onClick={() => void beat()}>
            Stay signed in
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The practice has started requiring a second factor of this person, and every
 * API route now refuses them until they set one up. Asked, not sent: a note
 * section saves when the cursor leaves it, so what is being typed exists only
 * on this screen, and a page load would take it without a word. "Stay" leaves
 * it there to copy, and has the focus so a keystroke cannot leave the page. The
 * question comes back at the next report.
 */
function MfaOwed({ onStay }: { onStay: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 px-4" role="presentation">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mfa-owed-title"
        aria-describedby="mfa-owed-body"
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 id="mfa-owed-title" className="font-display text-lg">Set up two-step sign-in to go on</h2>
        <p id="mfa-owed-body" className="mt-2 text-sm text-slate-700">
          Your practice now asks for an authenticator app at sign-in. Nothing can be opened or saved until it is set
          up. If you have typed anything that is not saved yet, copy it first.
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" autoFocus onClick={onStay}>
            Stay on this page
          </Button>
          <Button onClick={() => (window.location.href = `${MFA_SETUP_PATH}?required=1`)}>Set it up now</Button>
        </div>
      </div>
    </div>
  );
}
