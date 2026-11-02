/**
 * The formal care plan's structured parts (0116; Level-1 doc:38, :50-51,
 * :55): interventions and who is responsible, monitoring and how often, the
 * NP's escalation parameters, the next review, and PCM/CCM enrolment. Each
 * card saves its own part; the page keeps the rest as stored.
 */
"use client";

import { useEffect, useState } from "react";

import { Field, Select, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CARE_PROGRAMS,
  CARE_PROGRAM_LABEL,
  type CareProgram,
  type EnrollmentView,
} from "@/lib/features/care-coordination/care-coordination.types";
import {
  DISCIPLINES,
  DISCIPLINE_LABEL,
  ESCALATION_MEASURES,
  ESCALATION_MEASURE_INFO,
  MONITORING_HOW,
  MONITORING_HOW_LABEL,
  escalationRuleText,
  type Discipline,
  type EscalationRule,
  type Intervention,
  type MonitoringHow,
  type MonitoringItem,
} from "@/lib/features/care-plans/care-plan.types";

function Problem({ msg }: { msg: string | null }) {
  return msg ? (
    <p role="alert" className="text-xs text-red-700">
      {msg}
    </p>
  ) : null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Interventions, and who does them
// ---------------------------------------------------------------------------

export function InterventionsCard({
  items,
  busy,
  onChange,
}: {
  items: Intervention[];
  busy: boolean;
  onChange: (next: Intervention[]) => Promise<boolean>;
}) {
  const [item, setItem] = useState("");
  const [by, setBy] = useState<Discipline | "">("");
  const [msg, setMsg] = useState<string | null>(null);

  async function add() {
    const v = item.trim();
    if (!v) return setMsg("Say what the intervention is.");
    if (items.some((x) => same(x.item, v))) return setMsg("Already on the list.");
    if (items.length >= 40) return setMsg("At most 40.");
    setMsg(null);
    if (await onChange([...items, { item: v, by: by || null }])) {
      setItem("");
      setBy("");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Interventions</CardTitle>
        <CardDescription>What the team will do, and who is responsible.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-slate-400">None recorded.</p>
        ) : (
          <ul className="space-y-1" aria-label="Interventions">
            {items.map((x) => (
              <li key={x.item} className="flex items-start justify-between gap-2 text-sm text-slate-800">
                <span className="min-w-0 break-words">
                  {x.item}
                  <span className="text-slate-500"> · {x.by ? DISCIPLINE_LABEL[x.by] : "anyone on the team"}</span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onChange(items.filter((y) => y !== x))}
                  aria-label={`Remove ${x.item}`}
                  className="shrink-0 text-xs text-slate-500 hover:text-red-700 disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="New intervention"
            value={item}
            maxLength={200}
            placeholder="e.g. Weekly medication reconciliation"
            onChange={(e) => {
              setItem(e.target.value);
              setMsg(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            className="h-9 min-w-0 flex-1 rounded-md border border-slate-300 px-2 text-sm"
          />
          <select
            aria-label="Responsible"
            value={by}
            onChange={(e) => setBy(e.target.value as Discipline | "")}
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
          >
            <option value="">Anyone</option>
            {DISCIPLINES.map((d) => (
              <option key={d} value={d}>
                {DISCIPLINE_LABEL[d]}
              </option>
            ))}
          </select>
          <Button type="button" size="sm" variant="secondary" onClick={() => void add()} disabled={busy || !item.trim()}>
            Add
          </Button>
        </div>
        <Problem msg={msg} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Monitoring between visits, and how often
// ---------------------------------------------------------------------------

export function MonitoringCard({
  items,
  busy,
  onChange,
}: {
  items: MonitoringItem[];
  busy: boolean;
  onChange: (next: MonitoringItem[]) => Promise<boolean>;
}) {
  const [item, setItem] = useState("");
  const [every, setEvery] = useState("");
  const [how, setHow] = useState<MonitoringHow>("phone");
  const [msg, setMsg] = useState<string | null>(null);

  async function add() {
    const v = item.trim();
    if (!v) return setMsg("Say what is monitored.");
    if (items.some((x) => same(x.item, v))) return setMsg("Already on the list.");
    const n = every.trim() === "" ? null : Number(every);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 365)) return setMsg("Every 1 to 365 days, or leave it empty for as needed.");
    if (items.length >= 30) return setMsg("At most 30.");
    setMsg(null);
    if (await onChange([...items, { item: v, everyDays: n, how }])) {
      setItem("");
      setEvery("");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Monitoring</CardTitle>
        <CardDescription>
          What is checked between visits, how, and how often. A due check shows on the caseload and the inbox.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-slate-400">None recorded.</p>
        ) : (
          <ul className="space-y-1" aria-label="Monitoring">
            {items.map((x) => (
              <li key={x.item} className="flex items-start justify-between gap-2 text-sm text-slate-800">
                <span className="min-w-0 break-words">
                  {x.item}
                  <span className="text-slate-500">
                    {" "}
                    · {MONITORING_HOW_LABEL[x.how]}
                    {x.everyDays ? `, every ${x.everyDays} day${x.everyDays === 1 ? "" : "s"}` : ", as needed"}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onChange(items.filter((y) => y !== x))}
                  aria-label={`Remove ${x.item}`}
                  className="shrink-0 text-xs text-slate-500 hover:text-red-700 disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="New monitored item"
            value={item}
            maxLength={160}
            placeholder="e.g. Pain and shortness of breath"
            onChange={(e) => {
              setItem(e.target.value);
              setMsg(null);
            }}
            className="h-9 min-w-0 flex-1 rounded-md border border-slate-300 px-2 text-sm"
          />
          <select
            aria-label="How"
            value={how}
            onChange={(e) => setHow(e.target.value as MonitoringHow)}
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
          >
            {MONITORING_HOW.map((h) => (
              <option key={h} value={h}>
                {MONITORING_HOW_LABEL[h]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-sm text-slate-600">
            every
            <input
              aria-label="Every how many days"
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              value={every}
              onChange={(e) => {
                setEvery(e.target.value);
                setMsg(null);
              }}
              className="h-9 w-16 rounded-md border border-slate-300 px-2 text-sm"
            />
            days
          </label>
          <Button type="button" size="sm" variant="secondary" onClick={() => void add()} disabled={busy || !item.trim()}>
            Add
          </Button>
        </div>
        <Problem msg={msg} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Escalation parameters (doc:55)
// ---------------------------------------------------------------------------

type Draft = Record<string, { on: boolean; value: string }>;

const fromRules = (rules: EscalationRule[]): Draft =>
  Object.fromEntries(
    ESCALATION_MEASURES.map((m) => {
      const r = rules.find((x) => x.measure === m);
      return [m, { on: Boolean(r), value: r?.threshold !== null && r?.threshold !== undefined ? String(r.threshold) : "" }];
    }),
  );

export function EscalationCard({
  rules,
  busy,
  onSave,
}: {
  rules: EscalationRule[];
  busy: boolean;
  onSave: (next: EscalationRule[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Draft>(() => fromRules(rules));
  const [msg, setMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setMsg(null);
    setSaved(false);
    const next: EscalationRule[] = [];
    for (const m of ESCALATION_MEASURES) {
      const d = draft[m]!;
      const info = ESCALATION_MEASURE_INFO[m];
      if (info.crosses === "any") {
        if (d.on) next.push({ measure: m, threshold: null });
        continue;
      }
      if (d.value.trim() === "") continue;
      const n = Number(d.value);
      if (!Number.isInteger(n) || n < info.min! || n > info.max!) {
        return setMsg(`${info.label}: a whole number from ${info.min} to ${info.max}, or empty for none.`);
      }
      next.push({ measure: m, threshold: n });
    }
    if (await onSave(next)) setSaved(true);
  }

  const set = (m: string, patch: Partial<{ on: boolean; value: string }>) => {
    setDraft((d) => ({ ...d, [m]: { ...d[m]!, ...patch } }));
    setMsg(null);
    setSaved(false);
  };

  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle>Escalation parameters</CardTitle>
        <CardDescription>
          The NP&rsquo;s limits. A reading at a visit or on a call that crosses one, or an event chosen here, raises an
          alert for the patient&rsquo;s primary NP.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ESCALATION_MEASURES.map((m) => {
            const info = ESCALATION_MEASURE_INFO[m];
            const d = draft[m]!;
            return info.crosses === "any" ? (
              <label key={m} className="flex items-center gap-2">
                <input type="checkbox" checked={d.on} onChange={(e) => set(m, { on: e.target.checked })} />
                <span>Alert on {info.label[0]!.toLowerCase() + info.label.slice(1)}</span>
              </label>
            ) : (
              <label key={m} className="flex items-center gap-2">
                <span className="w-44 shrink-0">
                  {info.label} {info.crosses === "at_least" ? "at or above" : "at or below"}
                </span>
                <input
                  aria-label={`${info.label} limit`}
                  type="number"
                  inputMode="numeric"
                  min={info.min}
                  max={info.max}
                  value={d.value}
                  placeholder="none"
                  onChange={(e) => set(m, { value: e.target.value })}
                  className="h-8 w-20 rounded-md border border-slate-300 px-2"
                />
                <span className="text-slate-500">{info.unit}</span>
              </label>
            );
          })}
        </div>
        {rules.length > 0 && (
          <p className="text-xs text-slate-500">In force: {rules.map(escalationRuleText).join(" · ")}</p>
        )}
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-xs text-emerald-700">Saved.</span>}
          <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => void save()}>
            Save the parameters
          </Button>
        </div>
        <Problem msg={msg} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The next review
// ---------------------------------------------------------------------------

export function ReviewCard({
  reviewOn,
  busy,
  onSave,
}: {
  reviewOn: string | null;
  busy: boolean;
  onSave: (day: string | null) => Promise<boolean>;
}) {
  const [day, setDay] = useState(reviewOn ?? "");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Review</CardTitle>
        <CardDescription>When the plan is next reviewed and revised. It shows as due on the caseload from that day.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 text-sm">
        <TextInput aria-label="Review on" type="date" value={day} onChange={(e) => setDay(e.target.value)} className="h-9 w-44" />
        <Button type="button" size="sm" variant="secondary" disabled={busy || day === (reviewOn ?? "")} onClick={() => void onSave(day || null)}>
          {!day && reviewOn ? "Clear" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PCM/CCM enrolment (doc:38, :101)
// ---------------------------------------------------------------------------

export function EnrollmentCard({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<EnrollmentView[] | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<string | null>(null);
  const [f, setF] = useState({ program: "" as CareProgram | "", enrolledOn: "", consentOn: "", consentMethod: "", consentNote: "" });
  const [end, setEnd] = useState({ endedOn: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/patients/${patientId}/enrollments`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned || !d.success) return;
        setRows(d.data.rows);
        setToday(d.data.today);
      })
      .catch(() => {});
    return () => {
      abandoned = true;
    };
  }, [patientId, version]);

  async function call(url: string, method: "POST" | "PATCH", body: unknown) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!d.success) {
        setMsg(d.error ?? "Not saved.");
        return false;
      }
      setVersion((v) => v + 1);
      return true;
    } catch {
      setMsg("Network error — not saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function enroll(e: React.FormEvent) {
    e.preventDefault();
    if (!f.program || !f.enrolledOn || !f.consentOn || !f.consentMethod) return setMsg("The program, both days and how consent was given.");
    if (f.consentOn > f.enrolledOn) return setMsg("Consent comes before enrolment.");
    if (today && (f.enrolledOn > today || f.consentOn > today)) return setMsg("A day after today.");
    const ok = await call(`/api/patients/${patientId}/enrollments`, "POST", {
      program: f.program,
      enrolledOn: f.enrolledOn,
      consentOn: f.consentOn,
      consentMethod: f.consentMethod,
      ...(f.consentNote.trim() && { consentNote: f.consentNote.trim() }),
    });
    if (ok) {
      setAdding(false);
      setF({ program: "", enrolledOn: "", consentOn: "", consentMethod: "", consentNote: "" });
    }
  }

  async function finish(id: string) {
    if (!end.endedOn || !end.reason.trim()) return setMsg("The day it ends, and why.");
    if (await call(`/api/patients/${patientId}/enrollments/${id}`, "PATCH", { endedOn: end.endedOn, reason: end.reason.trim() })) {
      setEnding(null);
      setEnd({ endedOn: "", reason: "" });
    }
  }

  const current = (rows ?? []).filter((r) => !r.endedOn);
  const past = (rows ?? []).filter((r) => r.endedOn);
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>PCM / CCM</CardTitle>
          <CardDescription>Care management enrolment, with the consent that comes first.</CardDescription>
        </div>
        {!adding && rows !== null && current.length < CARE_PROGRAMS.length && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setAdding(true);
              setMsg(null);
              setF((x) => ({ ...x, enrolledOn: today ?? "", consentOn: today ?? "" }));
            }}
          >
            Enrol
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {rows === null ? (
          <p className="text-slate-500">Loading…</p>
        ) : current.length === 0 && !adding ? (
          <p className="text-slate-400">Not enrolled.</p>
        ) : (
          <ul className="space-y-2" aria-label="Enrolments">
            {current.map((r) => (
              <li key={r.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span>
                    <strong>{CARE_PROGRAM_LABEL[r.program]}</strong>
                    <span className="text-slate-500">
                      {" "}
                      · since {r.enrolledOn} · {r.consentMethod} consent {r.consentOn}
                    </span>
                  </span>
                  {ending !== r.id && (
                    <button
                      type="button"
                      className="text-xs text-slate-500 hover:text-red-700"
                      onClick={() => {
                        setEnding(r.id);
                        setEnd({ endedOn: today ?? "", reason: "" });
                        setMsg(null);
                      }}
                    >
                      End
                    </button>
                  )}
                </div>
                {r.consentNote && <p className="text-xs text-slate-600">{r.consentNote}</p>}
                {ending === r.id && (
                  <div className="mt-1 flex flex-wrap items-center gap-2" role="group" aria-label="End enrolment">
                    <TextInput aria-label="Ended on" type="date" min={r.enrolledOn} max={today ?? undefined} value={end.endedOn} onChange={(e) => setEnd((x) => ({ ...x, endedOn: e.target.value }))} className="h-8 w-40 text-sm" />
                    <TextInput aria-label="Why it ends" placeholder="Why" maxLength={300} value={end.reason} onChange={(e) => setEnd((x) => ({ ...x, reason: e.target.value }))} className="h-8 min-w-40 flex-1 text-sm" />
                    <Button type="button" size="sm" variant="secondary" onClick={() => setEnding(null)}>
                      Back
                    </Button>
                    <Button type="button" size="sm" variant="danger" loading={busy} onClick={() => void finish(r.id)}>
                      End it
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {adding && (
          <form onSubmit={enroll} noValidate className="grid grid-cols-1 gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-2" aria-label="Enrol">
            <Field id="en-program" label="Program" required>
              <Select id="en-program" value={f.program} onChange={(e) => setF((x) => ({ ...x, program: e.target.value as CareProgram }))}>
                <option value="" disabled>
                  Choose…
                </option>
                {CARE_PROGRAMS.filter((p) => !current.some((c) => c.program === p)).map((p) => (
                  <option key={p} value={p}>
                    {CARE_PROGRAM_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="en-method" label="Consent given" required>
              <Select id="en-method" value={f.consentMethod} onChange={(e) => setF((x) => ({ ...x, consentMethod: e.target.value }))}>
                <option value="" disabled>
                  Choose…
                </option>
                <option value="verbal">Verbally</option>
                <option value="written">In writing</option>
              </Select>
            </Field>
            <Field id="en-consent" label="Consent on" required>
              <TextInput id="en-consent" type="date" max={today ?? undefined} value={f.consentOn} onChange={(e) => setF((x) => ({ ...x, consentOn: e.target.value }))} />
            </Field>
            <Field id="en-on" label="Enrolled on" required>
              <TextInput id="en-on" type="date" min={f.consentOn || undefined} max={today ?? undefined} value={f.enrolledOn} onChange={(e) => setF((x) => ({ ...x, enrolledOn: e.target.value }))} />
            </Field>
            <div className="sm:col-span-2">
              <Field id="en-note" label="Consent note" optional explain="Who gave consent and anything said about cost sharing.">
                <TextInput id="en-note" maxLength={500} value={f.consentNote} onChange={(e) => setF((x) => ({ ...x, consentNote: e.target.value }))} />
              </Field>
            </div>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={busy}>
                Enrol
              </Button>
            </div>
          </form>
        )}
        {past.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-slate-600">Ended ({past.length})</summary>
            <ul className="mt-1 space-y-1 text-xs text-slate-600">
              {past.map((r) => (
                <li key={r.id}>
                  {CARE_PROGRAM_LABEL[r.program]} · {r.enrolledOn} to {r.endedOn}
                  {r.endReason ? ` — ${r.endReason}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
        <Problem msg={msg} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A frozen version's structured parts
// ---------------------------------------------------------------------------

export function FrozenStructure({
  v,
}: {
  v: {
    goals: string[] | null;
    interventions: Intervention[] | null;
    monitoring: MonitoringItem[] | null;
    escalation: EscalationRule[] | null;
    reviewOn: string | null;
  };
}) {
  const block = (title: string, lines: string[]) =>
    lines.length > 0 && (
      <div>
        <p className="text-xs font-medium text-slate-500">{title}</p>
        <ul className="list-disc pl-5 text-slate-800">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <>
      {block("Goals", v.goals ?? [])}
      {block("Interventions", (v.interventions ?? []).map((i) => `${i.item} · ${i.by ? DISCIPLINE_LABEL[i.by] : "anyone on the team"}`))}
      {block(
        "Monitoring",
        (v.monitoring ?? []).map(
          (m) => `${m.item} · ${MONITORING_HOW_LABEL[m.how]}${m.everyDays ? `, every ${m.everyDays} days` : ", as needed"}`,
        ),
      )}
      {block("Escalation parameters", (v.escalation ?? []).map(escalationRuleText))}
      {v.reviewOn && <p className="text-xs text-slate-500">Review set for {v.reviewOn}</p>}
    </>
  );
}
