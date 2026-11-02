/**
 * /patients/[id]/care-plan — living TipTap document.
 *
 * Source: pallio_complete_vision_v3 §6.2 + §7.3.
 *
 * Auto-saves on blur. Every save bumps current_version on the row.
 *
 * Level-1 audit (27 Oct 2026):
 *   - doc:50 — the symptoms and issues being monitored are a list on the
 *     plan, edited here. The medications are the chart's list (0114), shown
 *     here and kept on the chart: the plan's own copy drifted from it.
 *   - doc:59 — the follow-up visit updates the care plan. Opened from a visit
 *     (?visitId=), a save is recorded against that visit, and the visit's
 *     sign-off freezes the plan as it stood: the Version history below, which
 *     was always empty because nothing ever froze one.
 */
"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import type { JSONContent } from "@tiptap/react";

import { TipTapEditor } from "@/components/editor/tiptap-editor";
import { Button } from "@/components/ui/button";
import { medicationLabel, type MedicationView } from "@/lib/features/clinical/clinical-lists.types";
import type { CarePlanStructure, EscalationRule, Intervention, MonitoringItem } from "@/lib/features/care-plans/care-plan.types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import {
  EnrollmentCard,
  EscalationCard,
  FrozenStructure,
  InterventionsCard,
  MonitoringCard,
  ReviewCard,
} from "./structured-cards";

interface CarePlan {
  id: string;
  patientId: string;
  document: JSONContent | null;
  goalsOfCareSummary: string | null;
  primarySymptoms: string[];
  activeMedications: string[];
  goals: string[];
  interventions: Intervention[];
  monitoring: MonitoringItem[];
  escalation: EscalationRule[];
  reviewOn: string | null;
  currentVersion: number;
  lastUpdatedVisit: { id: string; day: string | null; clinicianName: string | null } | null;
  updatedAt: string;
}

/** The visit a save is tied to, when the plan is opened from one. */
interface TiedVisit {
  id: string;
  day: string | null;
  label: string;
}

const OPEN_VISIT = ["scheduled", "in_progress"];

export default function CarePlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ visitId?: string | string[] }>;
}) {
  const { id: patientId } = use(params);
  const visitParam = use(searchParams).visitId;
  const askedVisitId = typeof visitParam === "string" ? visitParam : null;

  const [plan, setPlan] = useState<CarePlan | null>(null);
  const [doc, setDoc] = useState<JSONContent | null>(null);
  const [goals, setGoals] = useState("");
  const [symptoms, setSymptoms] = useState<string[]>([]);
  // The formal plan's structured parts (0116, doc:38).
  const [structure, setStructure] = useState<Required<Omit<CarePlanStructure, "reviewOn">> & { reviewOn: string | null }>({
    goals: [],
    interventions: [],
    monitoring: [],
    escalation: [],
    reviewOn: null,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Why the plan could not be read. */
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [visit, setVisit] = useState<TiedVisit | null>(null);
  // Why a visit named in the URL is not one a save can be tied to.
  const [visitNote, setVisitNote] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const r = await fetch(`/api/care-plans/${patientId}`);
        const data = await r.json();
        if (abandoned) return;
        if (!data.success) {
          setLoadProblem(r.status === 403 ? "Your role doesn't open care plans." : "The care plan could not be loaded.");
          return;
        }
        if (data.data.carePlan) {
          const cp = data.data.carePlan as CarePlan;
          setPlan(cp);
          setDoc(cp.document ?? null);
          setGoals(cp.goalsOfCareSummary ?? "");
          setSymptoms(cp.primarySymptoms ?? []);
          setStructure({
            goals: cp.goals ?? [],
            interventions: cp.interventions ?? [],
            monitoring: cp.monitoring ?? [],
            escalation: cp.escalation ?? [],
            reviewOn: cp.reviewOn ?? null,
          });
        }
      } catch {
        if (!abandoned) setLoadProblem("The care plan could not be loaded.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [patientId]);

  useEffect(() => {
    if (!askedVisitId) return;
    let abandoned = false;
    fetch(`/api/visits/${askedVisitId}`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        const v = d.success ? d.data : null;
        if (!v || v.patientId !== patientId) {
          setVisitNote("That visit is not this patient's, so changes here are not tied to it.");
        } else if (!OPEN_VISIT.includes(v.status)) {
          setVisitNote(
            "That visit is signed, and the care plan was frozen with it. Changes here are saved to the plan without a visit.",
          );
        } else {
          setVisit({ id: v.id, day: v.serviceDay ?? null, label: v.visitTypeLabel ?? "visit" });
        }
      })
      .catch(() => {
        if (!abandoned) setVisitNote("Could not load the visit; changes here are not tied to it.");
      });
    return () => {
      abandoned = true;
    };
  }, [askedVisitId, patientId]);

  async function save(over: {
    document?: JSONContent | null;
    symptoms?: string[];
    /** One structured part (0116); the others are kept as stored. */
    part?: CarePlanStructure;
  } = {}) {
    setSaving(true);
    setError(null);
    try {
      const body = {
        document: over.document ?? doc ?? { type: "doc", content: [] },
        // "" = explicit clear; null would mean "keep stored value" server-side,
        // which made an emptied textarea impossible to save.
        goalsOfCareSummary: goals,
        primarySymptoms: over.symptoms ?? symptoms,
        ...over.part,
        ...(visit && { visitId: visit.id }),
      };
      const r = await fetch(`/api/care-plans/${patientId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Save failed.");
        return false;
      }
      setSaved(new Date().toLocaleTimeString());
      const now = new Date().toISOString();
      // As the server records it: this visit, or none for a save outside one.
      const tied = visit
        ? {
            id: visit.id,
            day: visit.day,
            clinicianName: plan?.lastUpdatedVisit?.id === visit.id ? plan.lastUpdatedVisit.clinicianName : null,
          }
        : null;
      setPlan((p) =>
        p
          ? { ...p, currentVersion: data.data.version, updatedAt: now, lastUpdatedVisit: tied }
          : {
              id: "",
              patientId,
              document: body.document as JSONContent,
              goalsOfCareSummary: body.goalsOfCareSummary,
              primarySymptoms: body.primarySymptoms,
              activeMedications: [],
              ...structure,
              ...over.part,
              reviewOn: over.part?.reviewOn !== undefined ? over.part.reviewOn : structure.reviewOn,
              currentVersion: data.data.version,
              lastUpdatedVisit: tied,
              updatedAt: now,
            },
      );
      return true;
    } catch {
      setError("Network error.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** A list change saves at once, like a blur does; undone if the save fails. */
  async function changeSymptoms(next: string[]) {
    const prev = symptoms;
    setSymptoms(next);
    if (!(await save({ symptoms: next }))) setSymptoms(prev);
  }

  /** A structured part saves at once too, alone; undone if the save fails. */
  async function changePart(part: CarePlanStructure): Promise<boolean> {
    const prev = structure;
    setStructure((s) => ({ ...s, ...part, reviewOn: part.reviewOn !== undefined ? part.reviewOn : s.reviewOn }));
    const ok = await save({ part });
    if (!ok) setStructure(prev);
    return ok;
  }

  if (loading) return <div className="px-8 py-8 text-slate-500">Loading…</div>;

  // A plan that could not be read is not an empty plan. Every box below saves
  // when the cursor leaves it, so a blank form here would write blanks over the
  // real plan, and tells someone without access that the patient has none.
  if (loadProblem) {
    return (
      <div className="px-8 py-8 max-w-4xl">
        <Link href={`/patients/${patientId}`} className="text-xs text-slate-500 hover:underline">
          ← Patient
        </Link>
        <h1 className="font-display text-3xl tracking-tight mt-1">Care plan</h1>
        <p role="alert" className="text-red-700 mt-3">
          {loadProblem}
        </p>
      </div>
    );
  }

  return (
    <div className="px-8 py-8 max-w-4xl">
      <header className="mb-6">
        <Link
          href={visit ? `/visits/${visit.id}/document` : `/patients/${patientId}`}
          className="text-xs text-slate-500 hover:underline"
        >
          {visit ? "← Back to the visit" : "← Patient"}
        </Link>
        <h1 className="font-display text-3xl tracking-tight mt-1">Care plan</h1>
        <p className="text-slate-600 mt-1 tabular">
          {plan
            ? `v${plan.currentVersion} · last saved ${new Date(plan.updatedAt).toLocaleString()}`
            : "No saves yet"}
        </p>
        {plan?.lastUpdatedVisit && (
          <p className="text-sm text-slate-500 mt-0.5">
            Last updated during{" "}
            <Link
              href={`/visits/${plan.lastUpdatedVisit.id}/document`}
              className="text-[var(--color-brand-700)] hover:underline"
            >
              the visit of {plan.lastUpdatedVisit.day ?? "an unscheduled day"}
            </Link>
            {plan.lastUpdatedVisit.clinicianName && ` (${plan.lastUpdatedVisit.clinicianName})`}.
          </p>
        )}
      </header>

      {visit && (
        <div className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-600/30">
          Updating the plan during the visit of {visit.day ?? "today"} ({visit.label}). What you save is recorded
          against this visit, and the plan is frozen as it stands when the visit is signed.
        </div>
      )}
      {visitNote && (
        <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/30">
          {visitNote}
        </div>
      )}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Goals of care</CardTitle>
          <CardDescription>One-paragraph summary updated each visit.</CardDescription>
        </CardHeader>
        <CardContent>
          <textarea
            rows={3}
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
            onBlur={() => save()}
            aria-label="Goals of care"
            className="w-full px-3 py-2 rounded-md border border-slate-300 text-base focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2"
            placeholder="Patient prefers comfort-focused care at home…"
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <ListCard
          title="Symptoms to monitor"
          description="Symptoms and issues followed between visits."
          placeholder="e.g. Dyspnea on exertion"
          items={symptoms}
          maxItems={40}
          maxLength={120}
          busy={saving}
          onChange={(next) => void changeSymptoms(next)}
        />
        <ChartMedications patientId={patientId} />
      </div>

      {/* The formal plan (0116, doc:38): goals, interventions and who does
          them, monitoring and how often, the NP's escalation parameters, the
          next review, and PCM/CCM enrolment. Each saves on its own. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <ListCard
          title="Goals"
          description="Measurable goals of this patient's care."
          placeholder="e.g. Pain at or below 4/10 on most days"
          items={structure.goals}
          maxItems={30}
          maxLength={200}
          busy={saving}
          onChange={(next) => void changePart({ goals: next })}
        />
        <InterventionsCard items={structure.interventions} busy={saving} onChange={(next) => changePart({ interventions: next })} />
        <MonitoringCard items={structure.monitoring} busy={saving} onChange={(next) => changePart({ monitoring: next })} />
        <EscalationCard rules={structure.escalation} busy={saving} onSave={(next) => changePart({ escalation: next })} />
        <ReviewCard reviewOn={structure.reviewOn} busy={saving} onSave={(day) => changePart({ reviewOn: day })} />
        <EnrollmentCard patientId={patientId} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Care plan document</CardTitle>
          <CardDescription>
            Living document. Auto-saves on blur. Signing a visit freezes the plan as it stands.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TipTapEditor
            initial={doc ?? null}
            onChange={(d) => setDoc(d)}
            onBlurSave={(d) => save({ document: d })}
            placeholder="Document the care plan…"
          />
        </CardContent>
      </Card>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-slate-500" aria-live="polite">
          {saving ? "Saving…" : saved ? `Saved at ${saved}` : ""}
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <Button variant="secondary" onClick={() => save()} loading={saving}>
          Save now
        </Button>
      </div>

      <VersionHistory patientId={patientId} />
    </div>
  );
}

/**
 * The chart's active medications (0114), read here: the plan's list is the
 * chart's, kept there, and a signed visit freezes it with the plan.
 */
function ChartMedications({ patientId }: { patientId: string }) {
  const [meds, setMeds] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/patients/${patientId}/clinical-lists`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (!d.success) return setFailed(true);
        const list: MedicationView[] = d.data?.medications ?? [];
        setMeds(list.filter((m) => m.status === "active").map(medicationLabel));
      })
      .catch(() => {
        if (!abandoned) setFailed(true);
      });
    return () => {
      abandoned = true;
    };
  }, [patientId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active medications</CardTitle>
        <CardDescription>
          The chart&rsquo;s medication list.{" "}
          <Link href={`/patients/${patientId}#medications`} className="text-[var(--color-brand-700)] hover:underline">
            Change it on the chart →
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {failed ? (
          <p className="text-sm text-slate-500">The medication list could not be loaded.</p>
        ) : meds === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : meds.length === 0 ? (
          <p className="text-sm text-slate-400">None recorded.</p>
        ) : (
          <ul className="space-y-1 text-sm text-slate-800" aria-label="Active medications">
            {meds.map((m, i) => (
              <li key={`${m}-${i}`} className="break-words">
                {m}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** A list on the plan: each entry removable, a new one added with Enter or Add. */
function ListCard({
  title,
  description,
  placeholder,
  items,
  maxItems,
  maxLength,
  busy,
  onChange,
}: {
  title: string;
  description: string;
  placeholder: string;
  items: string[];
  maxItems: number;
  maxLength: number;
  busy: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = `add-${title.toLowerCase().replace(/\s+/g, "-")}`;

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (items.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setProblem("Already on the list.");
      return;
    }
    if (items.length >= maxItems) {
      setProblem(`At most ${maxItems}.`);
      return;
    }
    setProblem(null);
    setDraft("");
    onChange([...items, v]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-slate-400">None recorded.</p>
        ) : (
          <ul className="space-y-1" aria-label={title}>
            {items.map((item) => (
              <li key={item} className="flex items-start justify-between gap-2 text-sm text-slate-800">
                <span className="min-w-0 break-words">{item}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onChange(items.filter((x) => x !== item))}
                  aria-label={`Remove ${item}`}
                  className="shrink-0 text-xs text-slate-500 hover:text-red-700 disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <label htmlFor={inputId} className="sr-only">
            Add to {title.toLowerCase()}
          </label>
          <input
            id={inputId}
            value={draft}
            maxLength={maxLength}
            placeholder={placeholder}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            className="h-9 min-w-0 flex-1 rounded-md border border-slate-300 px-2 text-sm"
          />
          <Button type="button" size="sm" variant="secondary" onClick={add} disabled={busy || !draft.trim()}>
            Add
          </Button>
        </div>
        {problem && (
          <p role="alert" className="text-xs text-red-700">
            {problem}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface VersionRow {
  version: number;
  document: JSONContent | null;
  goalsOfCareSummary: string | null;
  primarySymptoms: string[] | null;
  activeMedications: string[] | null;
  goals: string[] | null;
  interventions: Intervention[] | null;
  monitoring: MonitoringItem[] | null;
  escalation: EscalationRule[] | null;
  reviewOn: string | null;
  snapshotVisitId: string | null;
  snapshotVisitDay: string | null;
  createdByName: string | null;
  createdAt: string;
}

/**
 * Frozen snapshots (care_plan_version) — written when a visit is signed;
 * this viewer is the read side. "What did the plan say when that visit was
 * signed?"
 */
function VersionHistory({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [openVersion, setOpenVersion] = useState<number | null>(null);

  useEffect(() => {
    fetch(`/api/care-plans/${patientId}/versions`)
      .then((r) => r.json())
      .then((d) => setRows(d.success ? (d.data?.rows ?? []) : []))
      .catch(() => setRows([]));
  }, [patientId]);

  if (!rows || rows.length === 0) return null;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Version history</CardTitle>
        <CardDescription>
          The plan as it stood when each visit was signed. Click a version to read it.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-slate-100">
          {rows.map((v) => (
            <li key={v.version}>
              <button
                type="button"
                onClick={() => setOpenVersion(openVersion === v.version ? null : v.version)}
                className="w-full px-4 py-2.5 flex items-center justify-between gap-3 text-sm hover:bg-slate-50 text-left"
                aria-expanded={openVersion === v.version}
              >
                <span className="font-medium tabular">v{v.version}</span>
                <span className="text-slate-500 text-xs">
                  {v.snapshotVisitId
                    ? `Frozen when the visit of ${v.snapshotVisitDay ?? "?"} was signed${v.createdByName ? ` by ${v.createdByName}` : ""}`
                    : new Date(v.createdAt).toLocaleString()}
                </span>
              </button>
              {openVersion === v.version && (
                <div className="px-4 pb-4 space-y-3 text-sm">
                  {v.snapshotVisitId && (
                    <Link
                      href={`/visits/${v.snapshotVisitId}/document`}
                      className="text-xs text-[var(--color-brand-700)] underline"
                    >
                      Open the signed visit →
                    </Link>
                  )}
                  {v.goalsOfCareSummary && (
                    <div>
                      <p className="text-xs font-medium text-slate-500">Goals of care</p>
                      <p className="whitespace-pre-wrap text-slate-800">{v.goalsOfCareSummary}</p>
                    </div>
                  )}
                  {v.primarySymptoms && v.primarySymptoms.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-slate-500">Symptoms to monitor</p>
                      <p className="text-slate-800">{v.primarySymptoms.join(" · ")}</p>
                    </div>
                  )}
                  {v.activeMedications && v.activeMedications.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-slate-500">Active medications</p>
                      <ul className="list-disc pl-5 text-slate-800">
                        {v.activeMedications.map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <FrozenStructure v={v} />
                  <div className="mt-2">
                    <TipTapEditor initial={v.document ?? null} readOnly />
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
