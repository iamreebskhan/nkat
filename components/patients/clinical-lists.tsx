/**
 * The chart's problem list, medication list and allergies (0114; Level-1
 * doc:36), one read and three cards.
 *
 * Problems are picked from the ICD-10-CM catalog, as a visit's diagnoses are.
 * Nothing is deleted: a problem is resolved, a medication stopped, an allergy
 * made inactive, each with its day or reason, and the earlier entries stay
 * under the active ones. "No known allergies" is recorded as an answer, not
 * read from an empty list.
 */
"use client";

import { useEffect, useState } from "react";

import { Field, Select, TextInput } from "@/components/forms/field";
import { RxnormPicker } from "@/components/patients/rxnorm-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ALLERGY_KINDS,
  ALLERGY_KIND_LABEL,
  ALLERGY_SEVERITIES,
  ALLERGY_SEVERITY_LABEL,
  medicationLabel,
  type AllergyView,
  type ClinicalListsView,
  type MedicationView,
  type ProblemView,
} from "@/lib/features/clinical/clinical-lists.types";

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

/** POST or PATCH a list; the message to show, or null when it saved. */
async function send(url: string, method: "POST" | "PATCH", body: unknown): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    return d.success ? null : (d.error ?? "Not saved.");
  } catch {
    return "Network error — not saved.";
  }
}

/** '' → undefined on an add (the field is left out), → null on an edit (cleared). */
const blankTo = <T,>(s: string, empty: T) => (s.trim() === "" ? empty : s.trim());

export function ClinicalListsCards({ patientId, canEdit }: { patientId: string; canEdit: boolean }) {
  const [lists, setLists] = useState<ClinicalListsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/patients/${patientId}/clinical-lists`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (d.success) {
          setLists(d.data);
          setFailed(false);
        } else setFailed(true);
      })
      .catch(() => {
        if (!abandoned) setFailed(true);
      });
    return () => {
      abandoned = true;
    };
  }, [patientId, version]);

  const reload = () => setVersion((v) => v + 1);
  const base = `/api/patients/${patientId}/clinical-lists`;

  if (failed) {
    return (
      <Card className="md:col-span-2">
        <CardContent className="py-4 text-sm text-slate-500">The problem, medication and allergy lists could not be loaded.</CardContent>
      </Card>
    );
  }
  if (!lists) {
    return (
      <Card className="md:col-span-2">
        <CardContent className="py-4 text-sm text-slate-500">Loading the problem, medication and allergy lists…</CardContent>
      </Card>
    );
  }
  return (
    <>
      <ProblemsCard base={base} problems={lists.problems} today={lists.practiceToday} canEdit={canEdit} onSaved={reload} />
      <AllergiesCard
        base={base}
        allergies={lists.allergies}
        noKnownAllergies={lists.noKnownAllergies}
        canEdit={canEdit}
        onSaved={reload}
      />
      <MedicationsCard
        base={base}
        medications={lists.medications}
        today={lists.practiceToday}
        canEdit={canEdit}
        onSaved={reload}
      />
    </>
  );
}

function Earlier({ count, label, children }: { count: number; label: string; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <details className="pt-1">
      <summary className="cursor-pointer text-xs text-slate-600">
        {label} ({count})
      </summary>
      <ul className="mt-2 space-y-2 border-l-2 border-slate-100 pl-3">{children}</ul>
    </details>
  );
}

function Problem({ msg }: { msg: string | null }) {
  return msg ? (
    <p role="alert" className="text-sm text-red-700">
      {msg}
    </p>
  ) : null;
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

interface Icd10Match {
  code: string;
  description: string;
  billable: boolean;
}

function ProblemsCard({
  base,
  problems,
  today,
  canEdit,
  onSaved,
}: {
  base: string;
  problems: ProblemView[];
  today: string;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const active = problems.filter((p) => p.status === "active");
  const resolved = problems.filter((p) => p.status === "resolved");
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Icd10Match[]>([]);
  const [picked, setPicked] = useState<Icd10Match | null>(null);
  const [onset, setOnset] = useState("");
  const [notes, setNotes] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolvedOn, setResolvedOn] = useState(today);
  // Correcting an entry's onset or notes; the code is the problem, so a
  // different code is a different problem, added on its own.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ onsetOn: "", notes: "" });
  const [msg, setMsg] = useState<string | null>(null);

  // The catalog, as the visit's diagnosis picker searches it.
  useEffect(() => {
    const q = query.trim();
    if (!adding || q.length < 2 || picked) return;
    let abandoned = false;
    const t = setTimeout(() => {
      fetch(`/api/billing/icd10?query=${encodeURIComponent(q)}&limit=8`)
        .then((r) => r.json())
        .then((d) => {
          if (!abandoned) setMatches(d.success ? (d.data?.rows ?? []) : []);
        })
        .catch(() => {});
    }, 250);
    return () => {
      abandoned = true;
      clearTimeout(t);
    };
  }, [query, adding, picked]);

  function resetAdd() {
    setAdding(false);
    setQuery("");
    setMatches([]);
    setPicked(null);
    setOnset("");
    setNotes("");
    setMsg(null);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!picked) return setMsg("Pick the code from the list.");
    if (onset && onset > today) return setMsg("The onset is after today.");
    setBusyId("add");
    setMsg(null);
    const err = await send(`${base}/problems`, "POST", {
      icd10: picked.code,
      description: picked.description,
      ...(onset && { onsetOn: onset }),
      ...(notes.trim() && { notes: notes.trim() }),
    });
    setBusyId(null);
    if (err) return setMsg(err);
    resetAdd();
    onSaved();
  }

  async function change(p: ProblemView, body: Record<string, unknown>) {
    setBusyId(p.id);
    setMsg(null);
    const err = await send(`${base}/problems/${p.id}`, "PATCH", body);
    setBusyId(null);
    if (err) return setMsg(err);
    setResolvingId(null);
    setEditingId(null);
    onSaved();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Problem list</CardTitle>
          <CardDescription>Coded in ICD-10-CM.</CardDescription>
        </div>
        {canEdit && !adding && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setAdding(true);
              setMsg(null);
            }}
          >
            Add problem
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {adding && (
          <form onSubmit={add} className="space-y-2 rounded-md border border-slate-200 p-3" aria-label="Add a problem">
            {picked ? (
              <div className="flex items-start justify-between gap-2">
                <p>
                  <span className="font-mono">{picked.code}</span> {picked.description}
                </p>
                <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => setPicked(null)}>
                  Change
                </button>
              </div>
            ) : (
              <div>
                <TextInput
                  aria-label="Search ICD-10 by code or words"
                  placeholder="Search by code or words, e.g. heart failure"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-9 text-sm"
                  autoFocus
                />
                {matches.length > 0 && query.trim().length >= 2 && (
                  <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-slate-200" role="listbox" aria-label="ICD-10 matches">
                    {matches.map((m) => (
                      <li key={m.code}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          onClick={() => {
                            setPicked(m);
                            setMatches([]);
                          }}
                          className="w-full px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                        >
                          <span className="font-mono">{m.code}</span> {m.description}
                          {!m.billable && <span className="ml-1 text-xs text-amber-800">(category, not billable)</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Field id="pr-onset" label="Onset" optional>
                <TextInput id="pr-onset" type="date" max={today} value={onset} onChange={(e) => setOnset(e.target.value)} className="h-9 text-sm" />
              </Field>
              <Field id="pr-notes" label="Notes" optional>
                <TextInput id="pr-notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} className="h-9 text-sm" />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={resetAdd}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={busyId === "add"} disabled={!picked}>
                Add
              </Button>
            </div>
          </form>
        )}
        {active.length === 0 ? (
          <p className="text-slate-500">No active problems recorded.</p>
        ) : (
          <ul className="space-y-2" aria-label="Active problems">
            {active.map((p) => (
              <li key={p.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0">
                    <span className="font-mono">{p.icd10}</span> {p.description}
                    {p.onsetOn && <span className="text-xs text-slate-500"> · since {p.onsetOn}</span>}
                  </p>
                  {canEdit && resolvingId !== p.id && editingId !== p.id && (
                    <span className="flex gap-3">
                      <button
                        type="button"
                        className="text-xs text-slate-500 hover:text-slate-900"
                        onClick={() => {
                          setEditingId(p.id);
                          setResolvingId(null);
                          setEdit({ onsetOn: p.onsetOn ?? "", notes: p.notes ?? "" });
                          setMsg(null);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="text-xs text-slate-500 hover:text-slate-900"
                        onClick={() => {
                          setResolvingId(p.id);
                          setEditingId(null);
                          setResolvedOn(today);
                          setMsg(null);
                        }}
                      >
                        Resolve
                      </button>
                    </span>
                  )}
                </div>
                {p.notes && editingId !== p.id && <p className="text-xs text-slate-600">{p.notes}</p>}
                {editingId === p.id && (
                  <div className="mt-1 flex flex-wrap items-center gap-2" role="group" aria-label="Edit problem">
                    <TextInput
                      type="date"
                      aria-label="Onset"
                      value={edit.onsetOn}
                      max={today}
                      onChange={(e) => setEdit((x) => ({ ...x, onsetOn: e.target.value }))}
                      className="h-8 w-40 text-sm"
                    />
                    <TextInput
                      aria-label="Notes"
                      placeholder="Notes"
                      maxLength={1000}
                      value={edit.notes}
                      onChange={(e) => setEdit((x) => ({ ...x, notes: e.target.value }))}
                      className="h-8 flex-1 min-w-40 text-sm"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      loading={busyId === p.id}
                      onClick={() => void change(p, { onsetOn: blankTo(edit.onsetOn, null), notes: blankTo(edit.notes, null) })}
                    >
                      Save
                    </Button>
                  </div>
                )}
                {resolvingId === p.id && (
                  <div className="mt-1 flex flex-wrap items-center gap-2" role="group" aria-label="Resolve problem">
                    <TextInput
                      type="date"
                      aria-label="Resolved on"
                      value={resolvedOn}
                      min={p.onsetOn ?? undefined}
                      max={today}
                      onChange={(e) => setResolvedOn(e.target.value)}
                      className="h-8 w-40 text-sm"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={() => setResolvingId(null)}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      loading={busyId === p.id}
                      onClick={() => void change(p, { status: "resolved", resolvedOn })}
                    >
                      Resolve
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <Earlier count={resolved.length} label="Resolved">
          {resolved.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 text-slate-600">
              <span>
                <span className="font-mono">{p.icd10}</span> {p.description}
                <span className="text-xs"> · resolved {p.resolvedOn}</span>
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="text-xs text-slate-500 hover:text-slate-900"
                  disabled={busyId === p.id}
                  onClick={() => void change(p, { status: "active" })}
                >
                  Reopen
                </button>
              )}
            </li>
          ))}
        </Earlier>
        <Problem msg={msg} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Medications
// ---------------------------------------------------------------------------

const ROUTES = ["PO", "SL", "SC", "IV", "IM", "PR", "Topical", "Transdermal", "Inhaled", "Nebulized"];
const FREQUENCIES = ["daily", "twice daily", "three times daily", "every 4 hours", "every 6 hours", "every 12 hours", "at bedtime", "weekly"];

const EMPTY_MED = { name: "", dose: "", route: "", frequency: "", prn: false, indication: "", startedOn: "", rxnormCui: "" };

function MedicationsCard({
  base,
  medications,
  today,
  canEdit,
  onSaved,
}: {
  base: string;
  medications: MedicationView[];
  today: string;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const active = medications.filter((m) => m.status === "active");
  const stopped = medications.filter((m) => m.status === "stopped");
  const [form, setForm] = useState<typeof EMPTY_MED | null>(null);
  /** The medication the form edits; null adds a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [stoppedOn, setStoppedOn] = useState(today);
  const [stopReason, setStopReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const set = (k: keyof typeof EMPTY_MED) => (e: { target: { value: string } }) =>
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  function edit(m: MedicationView) {
    setEditingId(m.id);
    setStoppingId(null);
    setMsg(null);
    setForm({
      name: m.name,
      dose: m.dose ?? "",
      route: m.route ?? "",
      frequency: m.frequency ?? "",
      prn: m.prn,
      indication: m.indication ?? "",
      startedOn: m.startedOn ?? "",
      rxnormCui: m.rxnormCui ?? "",
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    if (!form.name.trim()) return setMsg("Name the medication.");
    if (form.startedOn && form.startedOn > today) return setMsg("The start is after today.");
    setBusy(true);
    setMsg(null);
    const err = editingId
      ? await send(`${base}/medications/${editingId}`, "PATCH", {
          name: form.name.trim(),
          dose: blankTo(form.dose, null),
          route: blankTo(form.route, null),
          frequency: blankTo(form.frequency, null),
          prn: form.prn,
          indication: blankTo(form.indication, null),
          startedOn: blankTo(form.startedOn, null),
          rxnormCui: blankTo(form.rxnormCui, null),
        })
      : await send(`${base}/medications`, "POST", {
          name: form.name.trim(),
          dose: blankTo(form.dose, undefined),
          route: blankTo(form.route, undefined),
          frequency: blankTo(form.frequency, undefined),
          prn: form.prn,
          indication: blankTo(form.indication, undefined),
          startedOn: blankTo(form.startedOn, undefined),
          rxnormCui: blankTo(form.rxnormCui, undefined),
        });
    setBusy(false);
    if (err) return setMsg(err);
    setForm(null);
    setEditingId(null);
    onSaved();
  }

  async function stop(m: MedicationView) {
    setBusy(true);
    setMsg(null);
    const err = await send(`${base}/medications/${m.id}`, "PATCH", {
      status: "stopped",
      stoppedOn,
      stopReason: blankTo(stopReason, null),
    });
    setBusy(false);
    if (err) return setMsg(err);
    setStoppingId(null);
    onSaved();
  }

  async function restart(m: MedicationView) {
    setBusy(true);
    setMsg(null);
    const err = await send(`${base}/medications/${m.id}`, "PATCH", { status: "active" });
    setBusy(false);
    if (err) return setMsg(err);
    onSaved();
  }

  return (
    <Card className="md:col-span-2" id="medications">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Medications</CardTitle>
          <CardDescription>The patient&rsquo;s medication list. The care plan shows these.</CardDescription>
        </div>
        {canEdit && !form && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditingId(null);
              setForm({ ...EMPTY_MED });
              setMsg(null);
            }}
          >
            Add medication
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {form && (
          <form
            onSubmit={save}
            noValidate
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 rounded-md border border-slate-200 p-3"
            aria-label={editingId ? "Edit medication" : "Add a medication"}
          >
            <div className="sm:col-span-2">
              <Field id="md-name" label="Medication" required>
                <TextInput
                  id="md-name"
                  value={form.name}
                  maxLength={200}
                  onChange={(e) => setForm((f) => (f ? { ...f, name: e.target.value, rxnormCui: "" } : f))}
                  className="h-9 text-sm"
                  placeholder="e.g. Morphine sulfate ER"
                />
              </Field>
              <RxnormPicker
                use="medication"
                term={form.name}
                cui={form.rxnormCui}
                onPick={(c) => setForm((f) => (f ? { ...f, name: c.name, rxnormCui: c.rxcui } : f))}
                onClear={() => setForm((f) => (f ? { ...f, rxnormCui: "" } : f))}
              />
            </div>
            <Field id="md-dose" label="Dose" optional>
              <TextInput id="md-dose" value={form.dose} maxLength={100} onChange={set("dose")} className="h-9 text-sm" placeholder="15 mg" />
            </Field>
            <Field id="md-route" label="Route" optional>
              <TextInput id="md-route" list="md-routes" value={form.route} maxLength={50} onChange={set("route")} className="h-9 text-sm" />
              <datalist id="md-routes">
                {ROUTES.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </Field>
            <Field id="md-freq" label="How often" optional>
              <TextInput id="md-freq" list="md-freqs" value={form.frequency} maxLength={100} onChange={set("frequency")} className="h-9 text-sm" />
              <datalist id="md-freqs">
                {FREQUENCIES.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </Field>
            <Field id="md-ind" label="For" optional>
              <TextInput id="md-ind" value={form.indication} maxLength={200} onChange={set("indication")} className="h-9 text-sm" placeholder="pain, dyspnea…" />
            </Field>
            <Field id="md-start" label="Started" optional>
              <TextInput id="md-start" type="date" max={today} value={form.startedOn} onChange={set("startedOn")} className="h-9 text-sm" />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2">
              <input type="checkbox" checked={form.prn} onChange={(e) => setForm((f) => (f ? { ...f, prn: e.target.checked } : f))} />
              <span>As needed (PRN)</span>
            </label>
            <div className="sm:col-span-2 lg:col-span-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setForm(null);
                  setEditingId(null);
                  setMsg(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={busy}>
                {editingId ? "Save" : "Add"}
              </Button>
            </div>
          </form>
        )}
        {active.length === 0 ? (
          <p className="text-slate-500">No active medications recorded.</p>
        ) : (
          <ul className="divide-y divide-slate-100" aria-label="Active medications">
            {active.map((m) => (
              <li key={m.id} className="py-1.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0">
                    {medicationLabel(m)}
                    {m.indication && <span className="text-slate-500"> — for {m.indication}</span>}
                    {m.startedOn && <span className="text-xs text-slate-500"> · since {m.startedOn}</span>}
                    {m.rxnormCui && <span className="text-xs text-slate-400"> · RxNorm {m.rxnormCui}</span>}
                  </p>
                  {canEdit && stoppingId !== m.id && (
                    <span className="flex gap-3">
                      <button type="button" className="text-xs text-slate-500 hover:text-slate-900" onClick={() => edit(m)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="text-xs text-slate-500 hover:text-red-700"
                        onClick={() => {
                          setStoppingId(m.id);
                          setStoppedOn(today);
                          setStopReason("");
                          setMsg(null);
                        }}
                      >
                        Stop
                      </button>
                    </span>
                  )}
                </div>
                {stoppingId === m.id && (
                  <div className="mt-1 flex flex-wrap items-center gap-2" role="group" aria-label="Stop medication">
                    <TextInput
                      type="date"
                      aria-label="Stopped on"
                      value={stoppedOn}
                      min={m.startedOn ?? undefined}
                      max={today}
                      onChange={(e) => setStoppedOn(e.target.value)}
                      className="h-8 w-40 text-sm"
                    />
                    <TextInput
                      aria-label="Why it was stopped"
                      placeholder="Why (optional)"
                      maxLength={300}
                      value={stopReason}
                      onChange={(e) => setStopReason(e.target.value)}
                      className="h-8 flex-1 min-w-40 text-sm"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={() => setStoppingId(null)}>
                      Cancel
                    </Button>
                    <Button type="button" variant="danger" size="sm" loading={busy} onClick={() => void stop(m)}>
                      Stop
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <Earlier count={stopped.length} label="Stopped">
          {stopped.map((m) => (
            <li key={m.id} className="flex flex-wrap items-start justify-between gap-2 text-slate-600">
              <span>
                {medicationLabel(m)}
                <span className="text-xs">
                  {" "}
                  · stopped {m.stoppedOn}
                  {m.stopReason ? ` — ${m.stopReason}` : ""}
                </span>
              </span>
              {canEdit && (
                <button type="button" className="text-xs text-slate-500 hover:text-slate-900" disabled={busy} onClick={() => void restart(m)}>
                  Restart
                </button>
              )}
            </li>
          ))}
        </Earlier>
        <Problem msg={msg} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

function AllergiesCard({
  base,
  allergies,
  noKnownAllergies,
  canEdit,
  onSaved,
}: {
  base: string;
  allergies: AllergyView[];
  noKnownAllergies: ClinicalListsView["noKnownAllergies"];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const active = allergies.filter((a) => a.status === "active");
  const inactive = allergies.filter((a) => a.status === "inactive");
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ substance: "", kind: "", reaction: "", severity: "", rxnormCui: "" });
  const [inactivatingId, setInactivatingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // The reaction and severity, which are often learned after the allergy.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ reaction: "", severity: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!f.substance.trim()) return setMsg("Name what they are allergic to.");
    if (!f.kind) return setMsg("Say what kind of allergy it is.");
    setBusy(true);
    setMsg(null);
    const err = await send(`${base}/allergies`, "POST", {
      substance: f.substance.trim(),
      kind: f.kind,
      ...(f.reaction.trim() && { reaction: f.reaction.trim() }),
      ...(f.severity && { severity: f.severity }),
      ...(f.rxnormCui && { rxnormCui: f.rxnormCui }),
    });
    setBusy(false);
    if (err) return setMsg(err);
    setAdding(false);
    setF({ substance: "", kind: "", reaction: "", severity: "", rxnormCui: "" });
    onSaved();
  }

  async function patch(a: AllergyView, body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    const err = await send(`${base}/allergies/${a.id}`, "PATCH", body);
    setBusy(false);
    if (err) return setMsg(err);
    setInactivatingId(null);
    setEditingId(null);
    onSaved();
  }

  async function recordNone() {
    setBusy(true);
    setMsg(null);
    const err = await send(`${base}/no-known-allergies`, "POST", {});
    setBusy(false);
    if (err) return setMsg(err);
    onSaved();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Allergies</CardTitle>
          <CardDescription>Allergies and intolerances.</CardDescription>
        </div>
        {canEdit && !adding && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setAdding(true);
              setMsg(null);
            }}
          >
            Add allergy
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {adding && (
          <form onSubmit={add} noValidate className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-md border border-slate-200 p-3" aria-label="Add an allergy">
            <Field id="al-sub" label="Allergic to" required>
              <TextInput
                id="al-sub"
                maxLength={200}
                value={f.substance}
                onChange={(e) => setF((x) => ({ ...x, substance: e.target.value, rxnormCui: "" }))}
                className="h-9 text-sm"
                placeholder="e.g. Penicillin"
              />
              {/* RxNorm names drugs: a food or an environmental allergy stays as typed. */}
              {(f.kind === "" || f.kind === "drug") && (
                <RxnormPicker
                  use="allergy"
                  term={f.substance}
                  cui={f.rxnormCui}
                  onPick={(c) => setF((x) => ({ ...x, substance: c.name, rxnormCui: c.rxcui, kind: "drug" }))}
                  onClear={() => setF((x) => ({ ...x, rxnormCui: "" }))}
                />
              )}
            </Field>
            <Field id="al-kind" label="Kind" required>
              <Select id="al-kind" value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value }))} className="h-9 text-sm">
                <option value="" disabled>
                  Choose…
                </option>
                {ALLERGY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ALLERGY_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="al-react" label="Reaction" optional>
              <TextInput
                id="al-react"
                maxLength={300}
                value={f.reaction}
                onChange={(e) => setF((x) => ({ ...x, reaction: e.target.value }))}
                className="h-9 text-sm"
                placeholder="e.g. Hives"
              />
            </Field>
            <Field id="al-sev" label="Severity" optional>
              <Select id="al-sev" value={f.severity} onChange={(e) => setF((x) => ({ ...x, severity: e.target.value }))} className="h-9 text-sm">
                <option value="">—</option>
                {ALLERGY_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {ALLERGY_SEVERITY_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="sm:col-span-2 flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setAdding(false);
                  setMsg(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={busy}>
                Add
              </Button>
            </div>
          </form>
        )}
        {active.length === 0 ? (
          noKnownAllergies ? (
            <p className="text-slate-700">
              <strong>No known allergies</strong>
              <span className="text-xs text-slate-500">
                {" "}
                · recorded by {noKnownAllergies.byName ?? "someone"}, {when(noKnownAllergies.at)}
              </span>
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-amber-800">Allergies not recorded yet.</p>
              {canEdit && (
                <Button type="button" variant="secondary" size="sm" loading={busy} onClick={() => void recordNone()}>
                  Record no known allergies
                </Button>
              )}
            </div>
          )
        ) : (
          <ul className="space-y-2" aria-label="Active allergies">
            {active.map((a) => (
              <li key={a.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0">
                    <strong>{a.substance}</strong>
                    <span className="text-slate-500"> ({ALLERGY_KIND_LABEL[a.kind]})</span>
                    {a.rxnormCui && <span className="text-xs text-slate-400"> · RxNorm {a.rxnormCui}</span>}
                    {a.reaction && <span> — {a.reaction}</span>}
                    {a.severity && (
                      <span className={a.severity === "severe" ? "text-red-700" : "text-slate-600"}>
                        {" "}
                        · {ALLERGY_SEVERITY_LABEL[a.severity]}
                      </span>
                    )}
                  </p>
                  {canEdit && inactivatingId !== a.id && editingId !== a.id && (
                    <span className="flex gap-3">
                      <button
                        type="button"
                        className="text-xs text-slate-500 hover:text-slate-900"
                        onClick={() => {
                          setEditingId(a.id);
                          setInactivatingId(null);
                          setEdit({ reaction: a.reaction ?? "", severity: a.severity ?? "" });
                          setMsg(null);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="text-xs text-slate-500 hover:text-slate-900"
                        onClick={() => {
                          setInactivatingId(a.id);
                          setEditingId(null);
                          setReason("");
                          setMsg(null);
                        }}
                      >
                        Mark inactive
                      </button>
                    </span>
                  )}
                </div>
                {editingId === a.id && (
                  <div className="mt-1 flex flex-wrap items-center gap-2" role="group" aria-label="Edit allergy">
                    <TextInput
                      aria-label="Reaction"
                      placeholder="Reaction"
                      maxLength={300}
                      value={edit.reaction}
                      onChange={(e) => setEdit((x) => ({ ...x, reaction: e.target.value }))}
                      className="h-8 flex-1 min-w-40 text-sm"
                    />
                    <Select
                      aria-label="Severity"
                      value={edit.severity}
                      onChange={(e) => setEdit((x) => ({ ...x, severity: e.target.value }))}
                      className="h-8 w-36 text-sm"
                    >
                      <option value="">—</option>
                      {ALLERGY_SEVERITIES.map((s) => (
                        <option key={s} value={s}>
                          {ALLERGY_SEVERITY_LABEL[s]}
                        </option>
                      ))}
                    </Select>
                    <Button type="button" variant="secondary" size="sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      loading={busy}
                      onClick={() =>
                        void patch(a, { reaction: blankTo(edit.reaction, null), severity: edit.severity || null })
                      }
                    >
                      Save
                    </Button>
                  </div>
                )}
                {inactivatingId === a.id && (
                  <div className="mt-1 flex flex-wrap items-center gap-2" role="group" aria-label="Mark allergy inactive">
                    <TextInput
                      aria-label="Why it is inactive"
                      placeholder="Why, e.g. entered in error"
                      maxLength={300}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className="h-8 flex-1 min-w-40 text-sm"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={() => setInactivatingId(null)}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      loading={busy}
                      onClick={() => void patch(a, { status: "inactive", inactiveReason: blankTo(reason, null) })}
                    >
                      Mark inactive
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <Earlier count={inactive.length} label="Inactive">
          {inactive.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 text-slate-600">
              <span>
                {a.substance}
                {a.inactiveReason && <span className="text-xs"> — {a.inactiveReason}</span>}
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="text-xs text-slate-500 hover:text-slate-900"
                  disabled={busy}
                  onClick={() => void patch(a, { status: "active" })}
                >
                  Make active
                </button>
              )}
            </li>
          ))}
        </Earlier>
        <Problem msg={msg} />
      </CardContent>
    </Card>
  );
}
