/**
 * /offline — the offline copy (Level-1 doc:33; Mark [v1 16:05-16:53]; Mark Q8
 * default: read the chart and draft offline, sign on reconnect).
 *
 * Everything on this page is read from the device (IndexedDB), never from the
 * server, so it opens and works in a home with no signal: the service worker
 * keeps this page and nothing else. Online, it saves a fresh copy of my
 * caseload and my coming visits, and sends what was written offline through
 * the same note and vitals routes a note written online uses. Signing stays on
 * the visit page, online: a note signed on the device would be a signature
 * nobody could check until later.
 *
 * Outside the signed-in layout on purpose: that layout is rendered by the
 * server, which is exactly what cannot be reached here.
 *
 * Sealed on the device (0121; offline-vault.ts): the copy opens with the PIN
 * the clinician set when saving it, or by itself while they are signed in. It
 * locks again after the practice's idle limit with nothing done, and after
 * five wrong PINs only signing in opens it.
 */
"use client";

import { useEffect, useRef, useState } from "react";

import { RegisterServiceWorker } from "@/components/offline/register-sw";
import { useOnline } from "@/components/offline/use-online";
import {
  OFFLINE_MAX_AGE_HOURS,
  draftId,
  snapshotIsFresh,
  type OfflineDraft,
  type OfflinePatient,
  type OfflineSection,
  type OfflineSnapshot,
  type OfflineVisit,
} from "@/lib/features/offline/offline";
import {
  clearOfflineData,
  clearSnapshot,
  createVault,
  deleteDraft,
  getSnapshot,
  getVault,
  isUnlocked,
  listDrafts,
  lockOffline,
  offlineSupported,
  putDraft,
  putSnapshot,
  setPin,
  setVaultIdleMinutes,
  unlockWithPin,
  unlockWithSignIn,
} from "@/lib/features/offline/offline-store";
import { sendDrafts } from "@/lib/features/offline/offline-sync";
import { MAX_PIN_FAILURES, pinProblem } from "@/lib/features/offline/offline-vault";
import { orgDateTime } from "@/lib/features/org/org-date";
import { VITALS_FIELDS, type VitalsFieldSpec } from "@/lib/features/visits/vitals-units";

type View = { kind: "home" } | { kind: "patient"; id: string } | { kind: "visit"; id: string };
type Note = { ok: boolean; text: string };
/**
 * none: nothing sealed on this device yet; locked: a copy waits for its PIN;
 * locked_out: too many wrong PINs, so only signing in opens it; open: read.
 */
type Lock = "checking" | "none" | "locked" | "locked_out" | "open";

const btn =
  "inline-flex h-10 items-center rounded-md px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed";
const primary = `${btn} bg-[var(--color-brand-600)] text-white hover:bg-[var(--color-brand-700)]`;
const secondary = `${btn} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50`;
const field = "h-10 w-full rounded-md border border-slate-300 px-3 text-base";

/** The open copy as it is on the device (only ever called once it is open). */
async function readDevice(): Promise<{ snap: OfflineSnapshot | null; drafts: OfflineDraft[]; note: Note | null }> {
  const [snap, drafts] = await Promise.all([getSnapshot(), listDrafts()]);
  if (snap && !snapshotIsFresh(snap, new Date())) {
    await clearSnapshot();
    return {
      snap: null,
      drafts,
      note: { ok: false, text: `The saved copy was more than ${OFFLINE_MAX_AGE_HOURS} hours old and has been removed. Save a new one while you're online.` },
    };
  }
  return { snap: snap ?? null, drafts, note: null };
}

export default function OfflinePage() {
  const online = useOnline();
  const [lock, setLock] = useState<Lock>("checking");
  const [snap, setSnap] = useState<OfflineSnapshot | null | undefined>(undefined);
  const [drafts, setDrafts] = useState<OfflineDraft[]>([]);
  const [view, setView] = useState<View>({ kind: "home" });
  const [busy, setBusy] = useState<"save" | "send" | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  /** A PIN is being set: for a first copy, or again after a lockout. */
  const [pinSetup, setPinSetup] = useState<"first" | "again" | null>(null);
  // The practice's limit comes with the copy; 30 is session-policy.ts's
  // default, which a client page cannot import (it reads the database).
  const idleMinutes = useRef(30);

  async function refresh() {
    const d = await readDevice();
    setSnap(d.snap);
    setDrafts(d.drafts);
    if (d.note) setNote(d.note);
  }

  /** What the device holds, without opening anything. */
  async function look() {
    const v = await getVault().catch(() => undefined);
    if (!offlineSupported()) {
      setLock("none");
      setSnap(null);
      setNote({ ok: false, text: "This browser cannot keep an offline copy." });
      return;
    }
    if (!v) {
      setLock("none");
      setSnap(null);
      // Drafts written before 0121 are plain and readable: they are shown and sent.
      setDrafts(await listDrafts().catch(() => []));
      return;
    }
    idleMinutes.current = v.idleMinutes;
    if (isUnlocked()) {
      setLock("open");
      await refresh();
      return;
    }
    setLock(v.pin ? "locked" : "locked_out");
    setSnap(undefined);
    setDrafts([]);
    // Opened again on the list, not on the visit or chart that was open.
    setView({ kind: "home" });
  }

  useEffect(() => {
    // Just after the first paint: what the device holds decides what shows.
    const t = window.setTimeout(() => void look(), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Locked again after the practice's idle limit with nothing done here: what
  // was opened is forgotten, and the PIN is needed again (0121; ONC (d)(5)).
  useEffect(() => {
    if (lock !== "open") return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true, capture: true });
    const tick = window.setInterval(() => {
      if (Date.now() - last > idleMinutes.current * 60_000) {
        lockOffline();
        setNote({ ok: true, text: "Locked after a while with nothing done. Enter your PIN to open it again." });
        void look();
      }
    }, 5_000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch, { capture: true });
      window.clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lock]);

  // Back online: whose session this is, and whether what was written offline
  // can go. A copy saved by someone else on this device is removed: one
  // clinician's patients never sit under another's login. Signed in, a locked
  // copy opens without its PIN.
  useEffect(() => {
    if (online !== true || lock === "checking") return;
    let abandoned = false;
    void (async () => {
      const me = await fetch("/api/auth/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (abandoned) return;
      const userId: string | undefined = me?.data?.userId;
      setSignedIn(Boolean(userId));
      if (!userId) return;
      const v = await getVault();
      if (v && v.userId !== userId) {
        await clearOfflineData();
        if (abandoned) return;
        setSnap(null);
        setDrafts([]);
        setLock("none");
        setNote({ ok: false, text: "The copy on this device was another clinician's, so it has been removed." });
        return;
      }
      if (v && !isUnlocked()) {
        if (!(await unlockWithSignIn()) || abandoned) return;
        setLock("open");
        await refresh();
        // Opened by signing in after too many wrong PINs: a new PIN first.
        if (!v.pin) setPinSetup("again");
      }
      const waiting = await listDrafts().catch(() => []);
      if (waiting.length === 0 || abandoned) return;
      const r = await sendDrafts().catch(() => null);
      if (abandoned || !r) return;
      await refresh();
      setNote(sendNote(r.sent, r.kept));
    })();
    return () => {
      abandoned = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, lock === "checking"]);

  async function openWithPin(pin: string): Promise<string | null> {
    const r = await unlockWithPin(pin);
    if (r === "ok") {
      setLock("open");
      setNote(null);
      await refresh();
      return null;
    }
    if (r === "locked_out") {
      setLock("locked_out");
      return null;
    }
    if (r === "no_copy") {
      await look();
      return null;
    }
    const v = await getVault();
    const left = MAX_PIN_FAILURES - (v?.failures ?? 0);
    return `That PIN didn't open the copy. ${left} more ${left === 1 ? "try" : "tries"} before it can only be opened by signing in.`;
  }

  /** The PIN set for a first copy (then the copy is saved), or again after a lockout. */
  async function choosePin(pin: string): Promise<string | null> {
    if (pinSetup === "again") {
      await setPin(pin);
      setPinSetup(null);
      setNote({ ok: true, text: "New PIN set. Use it to open the copy with no signal." });
      return null;
    }
    const me = await fetch("/api/auth/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const act = await fetch("/api/auth/activity", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!me?.data?.userId) return "You're signed out. Sign in to save a copy.";
    const minutes = Number(act?.data?.idleMinutes) || 30;
    const made = await createVault({ pin, userId: me.data.userId, orgId: me.data.orgId, idleMinutes: minutes });
    if (made === "exists") {
      setPinSetup(null);
      await look();
      return null;
    }
    if (made !== "ok") return "Pallio could not be reached, or the server cannot keep encrypted copies yet. Try again online.";
    idleMinutes.current = minutes;
    setPinSetup(null);
    setLock("open");
    await saveCopy();
    return null;
  }

  async function saveCopy() {
    if (!isUnlocked()) {
      // A sealed copy is opened first, never replaced: its drafts are someone's notes.
      if (await getVault()) {
        setNote({ ok: false, text: "Open the copy first, with your PIN, then save a fresh one." });
        return;
      }
      // The first copy on this device: its PIN is chosen first.
      setPinSetup("first");
      return;
    }
    setBusy("save");
    setNote(null);
    try {
      const [d, act] = await Promise.all([
        fetch("/api/offline/snapshot", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/auth/activity", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (!d.success) {
        setNote({ ok: false, text: d.error ?? "The copy could not be saved." });
        return;
      }
      await putSnapshot(d.data as OfflineSnapshot);
      // The practice's idle limit as it stands now reaches the device's lock.
      const minutes = Number(act?.data?.idleMinutes);
      if (Number.isInteger(minutes) && minutes > 0) {
        await setVaultIdleMinutes(minutes);
        idleMinutes.current = minutes;
      }
      // A fresh copy of this page for the worker, so what opens offline is
      // the version just used.
      navigator.serviceWorker?.controller?.postMessage("warm");
      await refresh();
      const s = d.data as OfflineSnapshot;
      setNote({ ok: true, text: `Saved: ${s.patients.length} patient${s.patients.length === 1 ? "" : "s"} and ${s.visits.length} coming visit${s.visits.length === 1 ? "" : "s"}.` });
    } catch {
      setNote({ ok: false, text: "Pallio could not be reached. Save the copy while you're online." });
    } finally {
      setBusy(null);
    }
  }

  async function sendNow() {
    setBusy("send");
    try {
      const r = await sendDrafts();
      await refresh();
      setNote(r.stopped === "offline" ? { ok: false, text: "Still offline: nothing was sent." } : sendNote(r.sent, r.kept));
    } finally {
      setBusy(null);
    }
  }

  async function discard(d: OfflineDraft) {
    if (!window.confirm(`Delete what you wrote offline under ${d.label} for ${d.patientName}? It has not been sent.`)) return;
    await deleteDraft(d.id);
    await refresh();
  }

  const status =
    online === null ? (
      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Checking the connection…</span>
    ) : online ? (
      <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-600/20">Online</span>
    ) : (
      <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-amber-600/30">Offline</span>
    );

  const patient = view.kind === "patient" ? snap?.patients.find((p) => p.id === view.id) : undefined;
  const visit = view.kind === "visit" ? snap?.visits.find((v) => v.id === view.id) : undefined;

  return (
    <div className="min-h-screen bg-[var(--color-canvas)]">
      <RegisterServiceWorker />
      <header className="border-b border-slate-200 bg-white px-4 py-3 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl tracking-tight">Offline copy {status}</h1>
            <p className="mt-0.5 text-sm text-slate-600">
              {lock === "locked" || lock === "locked_out"
                ? "A copy is saved on this device, locked."
                : snap
                  ? // On the practice's clock, which the copy carries; a copy saved before it did, on this device's, named.
                    `${snap.user.name}'s caseload, saved ${orgDateTime(snap.generatedAt, snap.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)}. Kept ${OFFLINE_MAX_AGE_HOURS} hours.`
                  : snap === null
                    ? "No copy is saved on this device."
                    : "Reading this device…"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {online && (
              <a href="/caseload" className={secondary}>
                ← Back to Pallio
              </a>
            )}
            {online && signedIn !== false && (lock === "none" || lock === "open") && (
              <button type="button" className={primary} disabled={busy !== null} onClick={() => void saveCopy()}>
                {busy === "save" ? "Saving…" : snap ? "Save a fresh copy" : "Save my caseload to this device"}
              </button>
            )}
            {online && drafts.length > 0 && (
              <button type="button" className={secondary} disabled={busy !== null} onClick={() => void sendNow()}>
                {busy === "send" ? "Sending…" : `Send ${drafts.length} written offline`}
              </button>
            )}
            {lock === "open" && (
              <button
                type="button"
                className={secondary}
                onClick={() => {
                  lockOffline();
                  void look();
                }}
              >
                Lock now
              </button>
            )}
          </div>
        </div>
        {online === false && (
          <p role="status" className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            You&rsquo;re offline. This is the copy saved on this device: what you write here is kept on it and sent when
            you&rsquo;re back online. Notes are signed on the visit page once you are.
          </p>
        )}
        {online && signedIn === false && (
          <p role="status" className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            You&rsquo;re signed out. <a href="/login" className="font-medium underline">Sign in</a> to save a copy or send what you
            wrote offline; it stays on this device until then.
          </p>
        )}
        {note && (
          <p role={note.ok ? "status" : "alert"} className={`mt-2 rounded px-3 py-2 text-sm ${note.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"}`}>
            {note.text}
          </p>
        )}
      </header>

      <main className="px-4 py-6 sm:px-8 max-w-4xl">
        {pinSetup && (
          <PinForm
            title={pinSetup === "first" ? "Choose a PIN for this copy" : "Choose a new PIN"}
            help={
              pinSetup === "first"
                ? "The copy is kept encrypted on this device. With no signal it opens only with this PIN; while you're signed in it opens by itself. Pick one you'll remember — at least 6 characters."
                : "Too many wrong PINs were entered, so the old one no longer opens this copy. Choose a new one before you go offline."
            }
            confirm
            submitLabel={pinSetup === "first" ? "Set PIN and save the copy" : "Set the new PIN"}
            onSubmit={choosePin}
            onCancel={pinSetup === "first" ? () => setPinSetup(null) : undefined}
          />
        )}
        {lock === "locked" && (
          <PinForm
            title="Enter your PIN to open the copy"
            help="The PIN you chose when you saved this copy."
            submitLabel="Open"
            onSubmit={openWithPin}
          />
        )}
        {lock === "locked_out" && (
          <Card title="This copy can't be opened with a PIN">
            <p className="text-slate-700">
              The PIN was entered wrong {MAX_PIN_FAILURES} times, so it no longer opens this copy. Nothing on it is lost:{" "}
              {online ? (
                <>
                  <a href="/login" className="font-medium underline">sign in</a> and it opens, then choose a new PIN.
                </>
              ) : (
                "sign in when you're back online and it opens, then choose a new PIN."
              )}
            </p>
          </Card>
        )}
        {view.kind !== "home" && (
          <button type="button" className="mb-4 text-sm text-[var(--color-brand-700)] hover:underline" onClick={() => setView({ kind: "home" })}>
            ← All patients and visits
          </button>
        )}
        {view.kind === "home" && snap !== undefined && (
          <Home snap={snap} drafts={drafts} onOpen={setView} onDiscard={(d) => void discard(d)} online={online === true} />
        )}
        {patient && <PatientChart p={patient} visits={snap!.visits.filter((v) => v.patientId === patient.id)} onOpen={setView} />}
        {visit && (
          <VisitDraft
            v={visit}
            drafts={drafts.filter((d) => d.visitId === visit.id)}
            onChanged={() => void refresh()}
            online={online === true}
          />
        )}
      </main>
    </div>
  );
}

/** A PIN asked for, or chosen (with confirm). onSubmit answers a problem to show, or null. */
function PinForm({
  title, help, confirm, submitLabel, onSubmit, onCancel,
}: {
  title: string;
  help: string;
  confirm?: boolean;
  submitLabel: string;
  onSubmit: (pin: string) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (confirm) {
      const p = pinProblem(pin);
      if (p) return setProblem(p);
      if (pin !== again) return setProblem("The two PINs are different.");
    }
    setBusy(true);
    setProblem(null);
    try {
      const p = await onSubmit(pin);
      if (p) setProblem(p);
      setPin("");
      setAgain("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={title}>
      <form onSubmit={submit} className="max-w-sm space-y-3">
        <p className="text-slate-600">{help}</p>
        <label className="block text-xs font-medium text-slate-700">
          PIN
          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className={`${field} mt-1`}
          />
        </label>
        {confirm && (
          <label className="block text-xs font-medium text-slate-700">
            The same PIN again
            <input type="password" autoComplete="off" value={again} onChange={(e) => setAgain(e.target.value)} className={`${field} mt-1`} />
          </label>
        )}
        {problem && <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">{problem}</p>}
        <div className="flex gap-2">
          <button type="submit" className={primary} disabled={busy || pin.length === 0}>
            {busy ? "…" : submitLabel}
          </button>
          {onCancel && (
            <button type="button" className={secondary} onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

function sendNote(sent: number, kept: number): Note {
  if (sent === 0 && kept === 0) return { ok: true, text: "Nothing was waiting to be sent." };
  const parts = [
    sent > 0 && `${sent} part${sent === 1 ? "" : "s"} of notes sent to the visits; sign each note on its visit page`,
    kept > 0 && `${kept} could not be sent and ${kept === 1 ? "is" : "are"} kept below with the reason`,
  ].filter(Boolean);
  return { ok: kept === 0, text: `${parts.join("; ")}.` };
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-lg border border-slate-200 bg-white">
      <h2 className="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-800">{title}</h2>
      <div className="px-4 py-3 text-sm">{children}</div>
    </section>
  );
}

function Home({
  snap, drafts, onOpen, onDiscard, online,
}: {
  snap: OfflineSnapshot | null; drafts: OfflineDraft[]; onOpen: (v: View) => void; onDiscard: (d: OfflineDraft) => void; online: boolean;
}) {
  return (
    <>
      {drafts.length > 0 && (
        <Card title={`Written offline, not yet sent (${drafts.length})`}>
          <ul className="divide-y divide-slate-100">
            {drafts.map((d) => (
              <li key={d.id} className="py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="font-medium">{d.label}</span> · {d.patientName} · {d.visitWhen}
                  </span>
                  <span className="flex gap-3 text-xs">
                    {snap?.visits.some((v) => v.id === d.visitId) && (
                      <button type="button" className="text-[var(--color-brand-700)] hover:underline" onClick={() => onOpen({ kind: "visit", id: d.visitId })}>
                        Open
                      </button>
                    )}
                    {online && (
                      <a href={`/visits/${d.visitId}/document`} className="text-[var(--color-brand-700)] hover:underline">
                        The visit page
                      </a>
                    )}
                    <button type="button" className="text-red-700 hover:underline" onClick={() => onDiscard(d)}>
                      Delete
                    </button>
                  </span>
                </div>
                {d.problem && <p className="mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-800">{d.problem}</p>}
                {d.problem && d.text && (
                  <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-50 px-2 py-1 font-sans text-xs text-slate-700">{d.text}</pre>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {!snap ? (
        <Card title="No copy on this device">
          <p className="text-slate-600">
            While you&rsquo;re online, save your caseload and your coming visits to this device. You can then read the charts and
            write your notes in a home with no signal; they&rsquo;re sent when you&rsquo;re back online.
          </p>
        </Card>
      ) : (
        <>
          <Card title={`Your visits (${snap.visits.length})`}>
            {snap.visits.length === 0 ? (
              <p className="text-slate-500">No visits booked for you from yesterday to a week ahead.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {snap.visits.map((v) => {
                  const n = drafts.filter((d) => d.visitId === v.id).length;
                  return (
                    <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        <span className="font-medium">{v.patientName}</span> · {v.type} · <span className="tabular">{v.when}</span>
                        {n > 0 && <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900">{n} written offline</span>}
                      </span>
                      <button type="button" className={secondary} onClick={() => onOpen({ kind: "visit", id: v.id })}>
                        Write the note
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title={`Your patients (${snap.patients.length})`}>
            <ul className="divide-y divide-slate-100">
              {snap.patients.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium">{p.name}</span>
                    {p.acuity && <span className="ml-2 text-xs text-slate-500">acuity {p.acuity}</span>}
                    {p.primaryDiagnosis && <span className="ml-2 text-xs text-slate-500">{p.primaryDiagnosis}</span>}
                  </span>
                  <button type="button" className={secondary} onClick={() => onOpen({ kind: "patient", id: p.id })}>
                    Open the chart
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </>
  );
}

const List = ({ items, empty }: { items: string[]; empty: string }) =>
  items.length === 0 ? <p className="text-slate-500">{empty}</p> : (
    <ul className="list-disc space-y-0.5 pl-5">
      {items.map((x, i) => <li key={i}>{x}</li>)}
    </ul>
  );

function PatientChart({ p, visits, onOpen }: { p: OfflinePatient; visits: OfflineVisit[]; onOpen: (v: View) => void }) {
  return (
    <>
      <h2 className="mb-3 font-display text-2xl tracking-tight">{p.name}</h2>
      <Card title="Patient">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          <Row k="Date of birth" v={p.dateOfBirth} />
          <Row k="Sex" v={p.sex} />
          <Row k="Preferred language" v={p.preferredLanguage ?? null} />
          <Row k="Race" v={p.race ?? null} />
          <Row k="Ethnicity" v={p.ethnicity ?? null} />
          <Row k="Phone" v={p.phone} />
          <Row k="Address" v={p.address} />
          <Row k="Acuity" v={p.acuity} />
          <Row k="Primary diagnosis" v={p.primaryDiagnosis} />
          <Row k="Insurance" v={p.payerName} />
          <Row k="Referred for" v={p.referralReason} />
        </dl>
      </Card>
      <Card title="Care team and contacts">
        <List items={p.careTeam.map((c) => `${c.role}: ${c.name}`)} empty="No care team recorded." />
        <div className="mt-2">
          <List
            items={p.contacts.map((c) => [c.name, c.relationship, c.phone, ...c.roles].filter(Boolean).join(" · "))}
            empty="No family or caregiver contacts recorded."
          />
        </div>
      </Card>
      <Card title="Problems, medications, allergies">
        <h3 className="text-xs font-semibold text-slate-500">Problems</h3>
        <List items={p.problems.map((x) => `${x.code} ${x.description}`)} empty="No active problems." />
        <h3 className="mt-3 text-xs font-semibold text-slate-500">Medications</h3>
        <List items={p.medications} empty="No active medications." />
        <h3 className="mt-3 text-xs font-semibold text-slate-500">Allergies</h3>
        {p.noKnownAllergies && p.allergies.length === 0 ? (
          <p>No known allergies.</p>
        ) : (
          <List
            items={p.allergies.map((a) => [a.substance, a.reaction, a.severity].filter(Boolean).join(" · "))}
            empty="No allergies recorded, and no record of none."
          />
        )}
      </Card>
      <Card title="Care plan">
        {!p.carePlan ? (
          <p className="text-slate-500">No care plan yet.</p>
        ) : (
          <div className="space-y-2">
            <List items={p.carePlan.goals} empty="No goals recorded." />
            {p.carePlan.symptoms.length > 0 && <Row k="Symptoms" v={p.carePlan.symptoms.join(", ")} />}
            {p.carePlan.interventions.length > 0 && <Row k="Interventions" v={p.carePlan.interventions.join("; ")} />}
            {p.carePlan.monitoring.length > 0 && <Row k="Monitoring" v={p.carePlan.monitoring.join("; ")} />}
            {p.carePlan.escalation.length > 0 && <Row k="Call the NP when" v={p.carePlan.escalation.join("; ")} />}
            {p.carePlan.reviewOn && <Row k="Review on" v={p.carePlan.reviewOn} />}
          </div>
        )}
      </Card>
      <Card title="Recent visits">
        {p.recentVisits.length === 0 ? (
          <p className="text-slate-500">No signed visits yet.</p>
        ) : (
          <ul className="space-y-2">
            {p.recentVisits.map((r, i) => (
              <li key={i}>
                <div className="font-medium">
                  {r.day} · {r.type}
                  {r.clinician ? ` · ${r.clinician}` : ""}
                </div>
                <p className="whitespace-pre-wrap text-slate-700">{r.assessmentAndPlan || "No assessment and plan written."}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {visits.length > 0 && (
        <Card title="Coming visits">
          <ul className="space-y-1">
            {visits.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-2">
                <span className="tabular">{v.when} · {v.type}</span>
                <button type="button" className="text-[var(--color-brand-700)] hover:underline" onClick={() => onOpen({ kind: "visit", id: v.id })}>
                  Write the note
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function Row({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="flex gap-2">
      <dt className="min-w-32 text-slate-500">{k}</dt>
      <dd className="text-slate-900">{v ?? "—"}</dd>
    </div>
  );
}

/**
 * Each section as the visit's note has it, edited as text: kept on the device
 * the moment it changes, and sent on reconnect onto the version it was
 * written against. Back to the copy's text deletes the draft.
 */
function VisitDraft({ v, drafts, onChanged, online }: { v: OfflineVisit; drafts: OfflineDraft[]; onChanged: () => void; online: boolean }) {
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(v.sections.map((s) => [s.sectionKey, drafts.find((d) => d.sectionKey === s.sectionKey)?.text ?? s.text])),
  );
  // Kept as it is typed, not only on leaving the box: the copy locks itself
  // after a while with nothing done (0121), and typing must never be lost to it.
  const timers = useRef<Record<string, number>>({});
  useEffect(() => {
    const t = timers.current;
    return () => Object.values(t).forEach((id) => window.clearTimeout(id));
  }, []);
  const keepSoon = (s: OfflineSection, text: string) => {
    window.clearTimeout(timers.current[s.sectionKey]);
    timers.current[s.sectionKey] = window.setTimeout(() => void keep(s, text), 800);
  };

  async function keep(s: OfflineSection, text: string) {
    const id = draftId(v.id, s.sectionKey);
    const existing = drafts.find((d) => d.id === id);
    if (text === s.text) {
      if (existing) await deleteDraft(id);
    } else {
      await putDraft({
        id, visitId: v.id, patientName: v.patientName, visitWhen: v.when, sectionKey: s.sectionKey, label: s.label,
        kind: s.kind, text, baseUpdatedAt: existing ? existing.baseUpdatedAt : s.updatedAt, savedAt: new Date().toISOString(),
      });
    }
    onChanged();
  }

  return (
    <>
      <h2 className="font-display text-2xl tracking-tight">{v.patientName}</h2>
      <p className="mb-3 text-sm text-slate-600">
        {v.type} · <span className="tabular">{v.when}</span>. Written here, kept on this device, sent when you&rsquo;re online.{" "}
        <strong>Sign the note on the visit page once you are</strong>
        {online && (
          <>
            {" "}
            (<a href={`/visits/${v.id}/document`} className="text-[var(--color-brand-700)] underline">open it</a>)
          </>
        )}
        .
      </p>
      {v.vitals && <VitalsDraft v={v} draft={drafts.find((d) => d.sectionKey === "vitals")} onChanged={onChanged} />}
      {v.sections.map((s) => {
        const pending = drafts.find((d) => d.sectionKey === s.sectionKey);
        return (
          <Card key={s.sectionKey} title={`${s.label}${s.isRequired ? " · required to sign" : ""}`}>
            {s.helpText && <p className="mb-1 text-xs text-slate-500">{s.helpText}</p>}
            <textarea
              aria-label={s.label}
              value={texts[s.sectionKey] ?? ""}
              rows={s.kind === "list" ? 4 : 5}
              placeholder={s.kind === "list" ? "One per line" : ""}
              onChange={(e) => {
                setTexts((t) => ({ ...t, [s.sectionKey]: e.target.value }));
                keepSoon(s, e.target.value);
              }}
              onBlur={(e) => {
                window.clearTimeout(timers.current[s.sectionKey]);
                void keep(s, e.target.value);
              }}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-slate-500">
              {pending
                ? pending.problem
                  ? <span className="text-red-700">{pending.problem}</span>
                  : `Kept on this device ${new Date(pending.savedAt).toLocaleTimeString()}; sent when you're online${s.kind === "prose" ? " as plain paragraphs" : ""}.`
                : "As the note stands."}
            </p>
          </Card>
        );
      })}
    </>
  );
}

function VitalsDraft({ v, draft, onChanged }: { v: OfflineVisit; draft: OfflineDraft | undefined; onChanged: () => void }) {
  const base = v.vitals!.values;
  const stored = draft?.vitals ?? base;
  const show = (spec: VitalsFieldSpec) => {
    const x = stored[spec.key as keyof typeof stored];
    return typeof x === "number" ? String(spec.fromStored(x)) : "";
  };
  const [shown, setShown] = useState<Record<string, string>>(() => Object.fromEntries(VITALS_FIELDS.map((f) => [f.key, show(f)])));
  const [problem, setProblem] = useState<string | null>(null);
  // Kept as typed, like the sections (0121: the copy locks itself after a while).
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function keep(now: Record<string, string> = shown) {
    const values: Record<string, number | null | string> = { ...stored };
    for (const f of VITALS_FIELDS) {
      const raw = (now[f.key] ?? "").trim();
      if (raw === "") {
        values[f.key] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
        setProblem(`${f.label}: ${f.min}-${f.max} ${f.unit}.`);
        return;
      }
      values[f.key] = f.toStored(n);
    }
    setProblem(null);
    const same = VITALS_FIELDS.every((f) => (values[f.key] ?? null) === (base[f.key as keyof typeof base] ?? null));
    const id = draftId(v.id, "vitals");
    if (same) {
      if (draft) await deleteDraft(id);
    } else {
      await putDraft({
        id, visitId: v.id, patientName: v.patientName, visitWhen: v.when, sectionKey: "vitals", label: "Vitals", kind: "vitals",
        vitals: values as OfflineDraft["vitals"], baseUpdatedAt: draft ? draft.baseUpdatedAt : v.vitals!.recordedAt,
        savedAt: new Date().toISOString(),
      });
    }
    onChanged();
  }

  return (
    <Card title="Vitals">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {VITALS_FIELDS.map((f) => (
          <label key={f.key} className="text-xs text-slate-500">
            {f.label} <span className="text-slate-400">({f.unit})</span>
            <input
              // Named outright: the wrapping label's text did not reach the
              // accessibility tree, and VoiceOver on the iPad reads by name.
              aria-label={`${f.label} (${f.unit})`}
              inputMode="decimal"
              value={shown[f.key] ?? ""}
              onChange={(e) => {
                const next = { ...shown, [f.key]: e.target.value };
                setShown(next);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => void keep(next), 1000);
              }}
              onBlur={() => {
                window.clearTimeout(timer.current);
                void keep();
              }}
              className="mt-0.5 block h-10 w-full rounded-md border border-slate-300 px-2 text-sm text-slate-900"
            />
          </label>
        ))}
      </div>
      {problem && <p role="alert" className="mt-1 text-xs text-red-700">{problem}</p>}
      <p className="mt-1 text-xs text-slate-500">
        {draft ? (draft.problem ?? `Kept on this device ${new Date(draft.savedAt).toLocaleTimeString()}; sent when you're online.`) : "As recorded on the visit."}
      </p>
    </Card>
  );
}
