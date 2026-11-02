/**
 * Tasks to the interdisciplinary team (0116; Level-1 doc:40, :54): the form
 * that gives one, and the list that tracks them to done. Used on the chart,
 * the visit, an escalation alert and /tasks.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import type { TaskView } from "@/lib/features/care-coordination/care-coordination.types";
import { DISCIPLINES, DISCIPLINE_LABEL, type Discipline } from "@/lib/features/care-plans/care-plan.types";

export interface Member {
  userId: string;
  fullName: string | null;
  email: string;
}

const memberName = (m: Member) => m.fullName ?? m.email;

async function send(url: string, method: "POST" | "PATCH", body: unknown): Promise<string | null> {
  try {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    return d.success ? null : (d.error ?? "Not saved.");
  } catch {
    return "Network error — not saved.";
  }
}

/** The practice's active members, for picking who a task is for. */
export function useMembers(): Member[] {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    let abandoned = false;
    fetch("/api/messaging/members")
      .then((r) => r.json())
      .then((d) => {
        if (!abandoned && d.success) setMembers(d.data?.rows ?? []);
      })
      .catch(() => {});
    return () => {
      abandoned = true;
    };
  }, []);
  return members;
}

export function TaskForm({
  patientId,
  visitId,
  alertId,
  phoneEncounterId,
  today,
  defaults,
  onSaved,
  onCancel,
}: {
  patientId?: string;
  visitId?: string;
  alertId?: string;
  phoneEncounterId?: string;
  /** The practice's today, the earliest due day; the server checks it either way. */
  today: string | null;
  defaults?: { title?: string; discipline?: Discipline; assigneeUserId?: string };
  onSaved: () => void;
  onCancel: () => void;
}) {
  const members = useMembers();
  const [f, setF] = useState({
    title: defaults?.title ?? "",
    details: "",
    discipline: defaults?.discipline ?? ("" as Discipline | ""),
    assigneeUserId: defaults?.assigneeUserId ?? "",
    dueOn: "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setMsg(null);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!f.title.trim()) return setMsg("Say what the task is.");
    if (!f.discipline) return setMsg("Whose task is it: which discipline?");
    if (f.dueOn && today && f.dueOn < today) return setMsg("The due day has passed. Pick today or a later day.");
    setBusy(true);
    const err = await send("/api/tasks", "POST", {
      title: f.title.trim(),
      discipline: f.discipline,
      ...(f.details.trim() && { details: f.details.trim() }),
      ...(f.assigneeUserId && { assigneeUserId: f.assigneeUserId }),
      ...(f.dueOn && { dueOn: f.dueOn }),
      ...(patientId && { patientId }),
      ...(visitId && { visitId }),
      ...(alertId && { alertId }),
      ...(phoneEncounterId && { phoneEncounterId }),
    });
    setBusy(false);
    if (err) return setMsg(err);
    onSaved();
  }

  return (
    <form onSubmit={save} noValidate className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-md border border-slate-200 p-3" aria-label="New task">
      <div className="md:col-span-2">
        <Field id="tk-title" label="Task" required>
          <TextInput id="tk-title" maxLength={200} value={f.title} onChange={set("title")} placeholder="e.g. Call the daughter about respite care" />
        </Field>
      </div>
      <Field id="tk-disc" label="For" required>
        <Select id="tk-disc" value={f.discipline} onChange={set("discipline")}>
          <option value="" disabled>
            Choose the discipline…
          </option>
          {DISCIPLINES.map((d) => (
            <option key={d} value={d}>
              {DISCIPLINE_LABEL[d]}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="tk-who" label="Assigned to" optional explain="Left empty, it waits for anyone in that discipline to take it. A chaplaincy task about a patient goes to their chaplain.">
        <Select id="tk-who" value={f.assigneeUserId} onChange={set("assigneeUserId")}>
          <option value="">Nobody yet</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {memberName(m)}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="tk-due" label="Due" optional>
        <TextInput id="tk-due" type="date" min={today ?? undefined} value={f.dueOn} onChange={set("dueOn")} />
      </Field>
      <div className="md:col-span-2">
        <Field id="tk-details" label="Details" optional>
          <TextArea id="tk-details" rows={2} maxLength={2000} value={f.details} onChange={set("details")} />
        </Field>
      </div>
      {msg && (
        <p role="alert" className="md:col-span-2 text-sm text-red-700">
          {msg}
        </p>
      )}
      <div className="md:col-span-2 flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={busy}>
          Give the task
        </Button>
      </div>
    </form>
  );
}

type Closing = { id: string; how: "done" | "cancel" } | null;

export function TaskList({
  tasks,
  me,
  canEditAny,
  showPatient,
  onChanged,
  emptyText,
}: {
  tasks: TaskView[];
  me: string | null;
  /** patients.edit: take, reassign; and close anyone's. */
  canEditAny: boolean;
  showPatient?: boolean;
  onChanged: () => void;
  emptyText: string;
}) {
  const members = useMembers();
  const [closing, setClosing] = useState<Closing>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ id: string; text: string } | null>(null);

  async function patch(id: string, body: unknown) {
    setBusy(true);
    setMsg(null);
    const err = await send(`/api/tasks/${id}`, "PATCH", body);
    setBusy(false);
    if (err) return setMsg({ id, text: err });
    setClosing(null);
    setNote("");
    onChanged();
  }

  if (tasks.length === 0) return <p className="text-sm text-slate-500">{emptyText}</p>;
  return (
    <ul className="divide-y divide-slate-100" aria-label="Tasks">
      {tasks.map((t) => {
        const open = t.status === "open";
        const mayClose = open && (canEditAny || t.assigneeUserId === me);
        return (
          <li key={t.id} className={`py-2 text-sm ${open ? "" : "opacity-70"}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className={`font-medium ${t.status === "cancelled" ? "line-through" : ""}`}>{t.title}</p>
                <p className="text-xs text-slate-500">
                  {showPatient &&
                    (t.patientId ? (
                      <Link href={`/patients/${t.patientId}?tab=tasks`} className="font-medium text-[var(--color-brand-700)] hover:underline">
                        {t.patientName ?? "Patient"}
                      </Link>
                    ) : (
                      "No patient"
                    ))}
                  {showPatient && " · "}
                  {[
                    DISCIPLINE_LABEL[t.discipline],
                    t.assigneeName ? `assigned to ${t.assigneeName}` : "nobody yet",
                    t.dueOn && `due ${t.dueOn}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {t.overdue && <span className="ml-1 font-medium text-red-700">overdue</span>}
                </p>
              </div>
              {open && closing?.id !== t.id && (
                <span className="flex flex-wrap items-center gap-3">
                  {canEditAny && t.assigneeUserId !== me && me && (
                    <button type="button" className="text-xs text-slate-600 hover:text-slate-900" disabled={busy} onClick={() => void patch(t.id, { assigneeUserId: me })}>
                      Take it
                    </button>
                  )}
                  {canEditAny && (
                    <select
                      aria-label={`Reassign ${t.title}`}
                      value=""
                      disabled={busy}
                      onChange={(e) => e.target.value && void patch(t.id, { assigneeUserId: e.target.value })}
                      className="h-7 rounded border border-slate-300 bg-white px-1 text-xs"
                    >
                      <option value="">Reassign…</option>
                      {members
                        .filter((m) => m.userId !== t.assigneeUserId)
                        .map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {memberName(m)}
                          </option>
                        ))}
                    </select>
                  )}
                  {mayClose && (
                    <>
                      <button type="button" className="text-xs text-emerald-700 hover:text-emerald-900" onClick={() => setClosing({ id: t.id, how: "done" })}>
                        Done
                      </button>
                      <button type="button" className="text-xs text-slate-500 hover:text-red-700" onClick={() => setClosing({ id: t.id, how: "cancel" })}>
                        Cancel task
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
            {t.details && <p className="mt-0.5 whitespace-pre-wrap text-slate-700">{t.details}</p>}
            <p className="text-xs text-slate-500">
              Given by {t.createdByName ?? "someone"}, {new Date(t.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
              {t.visitId && (
                <>
                  {" · "}
                  <Link href={`/visits/${t.visitId}/document`} className="hover:underline">
                    from a visit
                  </Link>
                </>
              )}
              {t.alertId && " · from an escalation alert"}
              {t.phoneEncounterId && " · from a call"}
              {!open && ` · ${t.status === "done" ? "done" : "cancelled"} by ${t.closedByName ?? "someone"}`}
              {t.closeNote && `: ${t.closeNote}`}
            </p>
            {closing?.id === t.id && (
              <div className="mt-1 flex flex-wrap items-center gap-2" role="group" aria-label={closing.how === "done" ? "Mark done" : "Cancel task"}>
                <TextInput
                  aria-label={closing.how === "done" ? "What was done" : "Why it is cancelled"}
                  placeholder={closing.how === "done" ? "What was done (optional)" : "Why, e.g. no longer needed"}
                  maxLength={1000}
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setMsg(null);
                  }}
                  className="h-8 min-w-48 flex-1 text-sm"
                />
                <Button type="button" variant="secondary" size="sm" onClick={() => setClosing(null)}>
                  Back
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={closing.how === "done" ? "primary" : "danger"}
                  loading={busy}
                  onClick={() =>
                    closing.how === "done"
                      ? void patch(t.id, { done: note.trim() ? { note: note.trim() } : {} })
                      : note.trim()
                        ? void patch(t.id, { cancel: { reason: note.trim() } })
                        : setMsg({ id: t.id, text: "Say why." })
                  }
                >
                  {closing.how === "done" ? "Mark done" : "Cancel task"}
                </Button>
              </div>
            )}
            {msg?.id === t.id && (
              <p role="alert" className="mt-1 text-xs text-red-700">
                {msg.text}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Giving a task while still with the patient (doc:40, :43): from the visit,
 * which the task names.
 */
export function VisitTaskCard({ visitId, patientId }: { visitId: string; patientId: string }) {
  const [adding, setAdding] = useState(false);
  const [given, setGiven] = useState(0);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <p className="font-display text-base font-semibold text-slate-900">Tasks for the team</p>
      <p className="mt-0.5 text-xs text-slate-500">Nursing, social work, chaplaincy or administration, from this visit.</p>
      {given > 0 && (
        <p className="mt-2 text-xs text-emerald-700">
          {given === 1 ? "Task given." : `${given} tasks given.`}{" "}
          <Link href={`/patients/${patientId}?tab=tasks`} className="underline">
            The patient&rsquo;s tasks →
          </Link>
        </p>
      )}
      {adding ? (
        <div className="mt-2">
          <TaskForm
            patientId={patientId}
            visitId={visitId}
            today={null}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              setGiven((n) => n + 1);
            }}
          />
        </div>
      ) : (
        <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => setAdding(true)}>
          Give a task
        </Button>
      )}
    </div>
  );
}

/** A patient's tasks, with the form to give one (the chart's Tasks tab). */
export function PatientTasks({
  patientId,
  me,
  canEdit,
}: {
  patientId: string;
  me: string | null;
  canEdit: boolean;
}) {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [status, setStatus] = useState<"open" | "all">("open");
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/tasks?scope=patient&patientId=${patientId}&status=${status}`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (d.success) {
          setTasks(d.data.rows);
          setToday(d.data.today);
          setFailed(false);
        } else setFailed(true);
      })
      .catch(() => {
        if (!abandoned) setFailed(true);
      });
    return () => {
      abandoned = true;
    };
  }, [patientId, status, version]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 text-sm" role="group" aria-label="Which tasks">
          {(["open", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`rounded px-2 py-1 ${status === s ? "bg-slate-200 font-medium" : "text-slate-600 hover:bg-slate-100"}`}
            >
              {s === "open" ? "Open" : "All, with done and cancelled"}
            </button>
          ))}
        </div>
        {canEdit && !adding && (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            Give a task
          </Button>
        )}
      </div>
      {adding && (
        <TaskForm
          patientId={patientId}
          today={today}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setVersion((v) => v + 1);
          }}
        />
      )}
      {failed ? (
        <p className="text-sm text-slate-500">The tasks could not be loaded.</p>
      ) : tasks === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <TaskList
          tasks={tasks}
          me={me}
          canEditAny={canEdit}
          onChanged={() => setVersion((v) => v + 1)}
          emptyText={status === "open" ? "No open tasks." : "No tasks yet."}
        />
      )}
    </div>
  );
}
