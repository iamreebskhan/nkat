/**
 * Family & caregivers on the chart (audit R30).
 *
 * The chart held one unlabelled emergency-contact name, never its phone, and
 * showed neither. Mark's patients have a daughter-in-law who is the caregiver
 * and a nephew who holds power of attorney; this card holds all of them with
 * the roles that matter at the bedside. The healthcare POA and the primary
 * caregiver also print in the note header.
 */
"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CONTACT_RELATIONSHIPS,
  CONTACT_RELATIONSHIP_LABELS,
  type ContactRelationship,
  type PatientContactView,
} from "@/lib/features/patients/contacts.types";

interface Draft {
  fullName: string;
  relationship: ContactRelationship | "";
  phone: string;
  altPhone: string;
  email: string;
  isPrimaryCaregiver: boolean;
  isEmergencyContact: boolean;
  isHealthcarePoa: boolean;
  livesWithPatient: boolean;
  notes: string;
}

const EMPTY: Draft = {
  fullName: "",
  relationship: "",
  phone: "",
  altPhone: "",
  email: "",
  isPrimaryCaregiver: false,
  isEmergencyContact: false,
  isHealthcarePoa: false,
  livesWithPatient: false,
  notes: "",
};

const TEXT_KEYS = ["phone", "altPhone", "email", "notes"] as const;
const FLAGS = [
  ["isPrimaryCaregiver", "Primary caregiver"],
  ["isEmergencyContact", "Emergency contact"],
  ["isHealthcarePoa", "Healthcare POA"],
  ["livesWithPatient", "Lives with patient"],
] as const;

const toDraft = (c: PatientContactView): Draft => ({
  fullName: c.fullName,
  relationship: c.relationship,
  phone: c.phone ?? "",
  altPhone: c.altPhone ?? "",
  email: c.email ?? "",
  isPrimaryCaregiver: c.isPrimaryCaregiver,
  isEmergencyContact: c.isEmergencyContact,
  isHealthcarePoa: c.isHealthcarePoa,
  livesWithPatient: c.livesWithPatient,
  notes: c.notes ?? "",
});

/** POST body: blank text fields are left out rather than sent empty. */
function createBody(d: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = { fullName: d.fullName.trim(), relationship: d.relationship };
  for (const k of TEXT_KEYS) if (d[k].trim()) out[k] = d[k].trim();
  for (const [k] of FLAGS) out[k] = d[k];
  return out;
}

/** PATCH body: only what changed. A cleared text field is sent as null. */
function patchBody(d: Draft, was: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (d.fullName.trim() !== was.fullName) out.fullName = d.fullName.trim();
  if (d.relationship !== was.relationship) out.relationship = d.relationship;
  for (const k of TEXT_KEYS) if (d[k].trim() !== was[k]) out[k] = d[k].trim() || null;
  for (const [k] of FLAGS) if (d[k] !== was[k]) out[k] = d[k];
  return out;
}

function Badge({ children, tone }: { children: string; tone: "violet" | "teal" | "amber" | "slate" }) {
  const tones = {
    violet: "bg-violet-50 text-violet-800 ring-violet-600/20",
    teal: "bg-teal-50 text-teal-800 ring-teal-600/20",
    amber: "bg-amber-50 text-amber-800 ring-amber-600/30",
    slate: "bg-slate-50 text-slate-700 ring-slate-500/20",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function PatientContactsCard({
  patientId,
  canEdit,
  className,
}: {
  patientId: string;
  /** Mirrors the server's patients.edit gate; without it the card is read-only. */
  canEdit: boolean;
  className?: string;
}) {
  const [rows, setRows] = useState<PatientContactView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // null = no form open; "new" = adding; otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      const r = await fetch(`/api/patients/${patientId}/contacts`).catch(() => null);
      const d = r ? await r.json().catch(() => null) : null;
      if (abandoned) return;
      if (!d?.success) {
        setLoadError(d?.error ?? "Could not load family and caregivers.");
        return;
      }
      setLoadError(null);
      setRows((d.data?.rows ?? []) as PatientContactView[]);
    })();
    return () => {
      abandoned = true;
    };
  }, [patientId, reload]);

  function open(target: PatientContactView | "new") {
    setError(null);
    if (target === "new") {
      setEditing("new");
      setDraft(EMPTY);
    } else {
      setEditing(target.id);
      setDraft(toDraft(target));
    }
  }

  async function save() {
    const was = editing && editing !== "new" ? rows?.find((r) => r.id === editing) : undefined;
    if (!draft.fullName.trim() || !draft.relationship) {
      setError("Name and relationship are required.");
      return;
    }
    const body = was ? patchBody(draft, toDraft(was)) : createBody(draft);
    if (was && Object.keys(body).length === 0) {
      setEditing(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(
        was ? `/api/patients/${patientId}/contacts/${was.id}` : `/api/patients/${patientId}/contacts`,
        {
          method: was ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const d = await r.json().catch(() => null);
      if (!d?.success) {
        // The form stays open with what was typed; nothing was saved.
        setError(d?.error ?? "Could not save this contact.");
        return;
      }
      setEditing(null);
      setReload((n) => n + 1);
    } catch {
      setError("Network error. Nothing was saved.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(c: PatientContactView) {
    if (!confirm(`Remove ${c.fullName} from this patient's family and caregivers?`)) return;
    const before = rows;
    // Optimistic, rolled back on failure (the care-team seat pattern).
    setRows((rs) => rs?.filter((x) => x.id !== c.id) ?? rs);
    setError(null);
    try {
      const r = await fetch(`/api/patients/${patientId}/contacts/${c.id}`, { method: "DELETE" });
      const d = await r.json().catch(() => null);
      if (!d?.success) {
        setRows(before);
        setError(d?.error ?? "Could not remove this contact.");
      }
    } catch {
      setRows(before);
      setError("Network error. Nothing was removed.");
    }
  }

  const formProps = {
    draft,
    setDraft,
    saving,
    error,
    onSave: () => void save(),
    onCancel: () => {
      setEditing(null);
      setError(null);
    },
  };

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Family &amp; caregivers</CardTitle>
            <CardDescription>
              Who to call, who cares for the patient at home, and who holds healthcare power of attorney.
            </CardDescription>
          </div>
          {canEdit && editing === null && rows !== null && (
            <Button size="sm" variant="secondary" onClick={() => open("new")}>
              Add contact
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-700">
        {loadError && (
          <p role="alert" className="text-red-700">
            {loadError}
          </p>
        )}
        {error && editing === null && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
        {rows === null && !loadError && <p className="text-slate-500">Loading…</p>}
        {rows !== null && rows.length === 0 && editing !== "new" && (
          <p className="text-slate-500">No family or caregivers on file.</p>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {rows.map((c) =>
              editing === c.id ? (
                <li key={c.id} className="py-3">
                  <ContactForm idPrefix={`contact-${c.id}`} {...formProps} />
                </li>
              ) : (
                <li key={c.id} className="py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900">
                      {c.fullName}
                      <span className="font-normal text-slate-500">
                        {" · "}
                        {CONTACT_RELATIONSHIP_LABELS[c.relationship]}
                      </span>
                    </div>
                    <div className="text-slate-600 tabular">
                      {[c.phone, c.altPhone].filter(Boolean).join(" · ") || "No phone on file"}
                      {c.email ? ` · ${c.email}` : ""}
                    </div>
                    {(c.isHealthcarePoa || c.isPrimaryCaregiver || c.isEmergencyContact || c.livesWithPatient) && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {c.isHealthcarePoa && <Badge tone="violet">Healthcare POA</Badge>}
                        {c.isPrimaryCaregiver && <Badge tone="teal">Primary caregiver</Badge>}
                        {c.isEmergencyContact && <Badge tone="amber">Emergency contact</Badge>}
                        {c.livesWithPatient && <Badge tone="slate">Lives with patient</Badge>}
                      </div>
                    )}
                    {c.notes && <p className="mt-1 text-xs text-slate-500 whitespace-pre-wrap">{c.notes}</p>}
                  </div>
                  {canEdit && editing === null && (
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" onClick={() => open(c)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void remove(c)}>
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
        {editing === "new" && <ContactForm idPrefix="contact-new" {...formProps} />}
      </CardContent>
    </Card>
  );
}

function ContactForm({
  idPrefix,
  draft,
  setDraft,
  saving,
  error,
  onSave,
  onCancel,
}: {
  idPrefix: string;
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const text = (k: "fullName" | "phone" | "altPhone" | "email") => ({
    id: `${idPrefix}-${k}`,
    value: draft[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setDraft((d) => ({ ...d, [k]: v }));
    },
  });
  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50/60 p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field id={`${idPrefix}-fullName`} label="Full name" required>
          <TextInput {...text("fullName")} maxLength={120} autoComplete="off" />
        </Field>
        <Field id={`${idPrefix}-relationship`} label="Relationship" required>
          <Select
            id={`${idPrefix}-relationship`}
            value={draft.relationship}
            onChange={(e) => {
              const v = e.target.value as ContactRelationship | "";
              setDraft((d) => ({ ...d, relationship: v }));
            }}
          >
            <option value="">Select…</option>
            {CONTACT_RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {CONTACT_RELATIONSHIP_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${idPrefix}-phone`} label="Phone" optional>
          <TextInput {...text("phone")} type="tel" autoComplete="off" />
        </Field>
        <Field id={`${idPrefix}-altPhone`} label="Other phone" optional>
          <TextInput {...text("altPhone")} type="tel" autoComplete="off" />
        </Field>
        <Field id={`${idPrefix}-email`} label="Email" optional>
          <TextInput {...text("email")} type="email" autoComplete="off" />
        </Field>
      </div>
      <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
        <legend className="sr-only">Roles</legend>
        {FLAGS.map(([key, label]) => (
          <label key={key} className="inline-flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={draft[key]}
              onChange={(e) => {
                const v = e.target.checked;
                setDraft((d) => ({ ...d, [key]: v }));
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <Field id={`${idPrefix}-notes`} label="Notes" optional>
        <TextArea
          id={`${idPrefix}-notes`}
          rows={2}
          maxLength={500}
          value={draft.notes}
          onChange={(e) => {
            const v = e.target.value;
            setDraft((d) => ({ ...d, notes: v }));
          }}
        />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} loading={saving}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
