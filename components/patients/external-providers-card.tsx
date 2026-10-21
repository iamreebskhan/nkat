/**
 * Outside providers on the chart (audit R30).
 *
 * The chart held one referring-physician pair that no screen showed, where
 * the header of Mark's note lists a PCP, a referring physician, a
 * pulmonologist and an oncologist. Providers come from the org's roster, so a
 * PCP who refers ten patients is one entry: correct her fax once, here, and
 * every chart that links her has it.
 */
"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { Field, Select, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EXTERNAL_PROVIDER_ROLES,
  EXTERNAL_PROVIDER_ROLE_LABELS,
  type ExternalProviderRole,
  type ExternalProviderView,
  type PatientProviderView,
} from "@/lib/features/patients/contacts.types";
import { isValidNpi } from "@/lib/features/team/clinician";

interface ProviderDraft {
  fullName: string;
  npi: string;
  specialty: string;
  practiceName: string;
  phone: string;
  fax: string;
}

const EMPTY_PROVIDER: ProviderDraft = {
  fullName: "",
  npi: "",
  specialty: "",
  practiceName: "",
  phone: "",
  fax: "",
};
const PROVIDER_KEYS = Object.keys(EMPTY_PROVIDER) as (keyof ProviderDraft)[];

const toProviderDraft = (p: ExternalProviderView): ProviderDraft => ({
  fullName: p.fullName,
  npi: p.npi ?? "",
  specialty: p.specialty ?? "",
  practiceName: p.practiceName ?? "",
  phone: p.phone ?? "",
  fax: p.fax ?? "",
});

/** A labelled role reads as its label ("Pulmonologist"); the rest as the role. */
const roleText = (l: PatientProviderView) =>
  (l.role === "specialist" || l.role === "other") && l.roleLabel
    ? l.roleLabel
    : EXTERNAL_PROVIDER_ROLE_LABELS[l.role];

export function ExternalProvidersCard({
  patientId,
  canEdit,
  className,
}: {
  patientId: string;
  /** Mirrors the server's patients.edit gate; without it the card is read-only. */
  canEdit: boolean;
  className?: string;
}) {
  const [links, setLinks] = useState<PatientProviderView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The add form.
  const [adding, setAdding] = useState(false);
  const [role, setRole] = useState<ExternalProviderRole>("primary_care");
  const [roleLabel, setRoleLabel] = useState("");
  const [mode, setMode] = useState<"pick" | "new">("pick");
  const [query, setQuery] = useState("");
  // The roster's answer and the text it answers; rows null = the search
  // failed. Keyed by text so an answer only ever shows for the query that
  // asked, and "No match" waits for that answer (see `searching`).
  const [answer, setAnswer] = useState<{ q: string; rows: ExternalProviderView[] | null } | null>(null);
  const [picked, setPicked] = useState<ExternalProviderView | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_PROVIDER);

  // A roster entry being corrected in place, by provider id.
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(EMPTY_PROVIDER);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      const r = await fetch(`/api/patients/${patientId}/providers`).catch(() => null);
      const d = r ? await r.json().catch(() => null) : null;
      if (abandoned) return;
      if (!d?.success) {
        setLoadError(d?.error ?? "Could not load outside providers.");
        return;
      }
      setLoadError(null);
      setLinks((d.data?.rows ?? []) as PatientProviderView[]);
    })();
    return () => {
      abandoned = true;
    };
  }, [patientId, reload]);

  // Roster typeahead, debounced. State is only set from the timer, never in
  // the effect body; a short query simply shows nothing (see `typed`). An
  // answer for text that has since changed is dropped twice over: the effect
  // for the new text abandons it, and it is keyed to its own text.
  useEffect(() => {
    const q = query.trim();
    if (!adding || mode !== "pick" || q.length < 2) return;
    let abandoned = false;
    const t = setTimeout(async () => {
      const r = await fetch(`/api/external-providers?q=${encodeURIComponent(q)}`).catch(() => null);
      const d = r ? await r.json().catch(() => null) : null;
      if (abandoned) return;
      setAnswer({ q, rows: d?.success ? ((d.data?.rows ?? []) as ExternalProviderView[]) : null });
    }, 250);
    return () => {
      abandoned = true;
      clearTimeout(t);
    };
  }, [query, adding, mode]);
  const typed = query.trim();
  // Still searching until the answer for exactly this text lands. The empty
  // list a search starts from used to read as the roster's answer, so on a
  // slow first response "No match on your roster" showed for seconds before
  // the match appeared (audit R30).
  const searching = typed.length >= 2 && answer?.q !== typed;
  const shown = typed.length >= 2 && !searching ? (answer?.rows ?? []) : [];

  function openAdd() {
    setError(null);
    setAdding(true);
    setRole("primary_care");
    setRoleLabel("");
    setMode("pick");
    setQuery("");
    setPicked(null);
    setDraft(EMPTY_PROVIDER);
  }

  async function link() {
    setError(null);
    const label = roleLabel.trim();
    if (role === "specialist" && !label) {
      setError("Name the specialty, e.g. Pulmonologist.");
      return;
    }
    const body: Record<string, unknown> = { role };
    if ((role === "specialist" || role === "other") && label) body.roleLabel = label;
    if (mode === "pick") {
      if (!picked) {
        setError("Pick a provider from your roster, or add a new one.");
        return;
      }
      body.externalProviderId = picked.id;
    } else {
      if (!draft.fullName.trim()) {
        setError("The provider's name is required.");
        return;
      }
      const provider: Record<string, string> = {};
      for (const k of PROVIDER_KEYS) if (draft[k].trim()) provider[k] = draft[k].trim();
      body.provider = provider;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/patients/${patientId}/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => null);
      if (!d?.success) {
        setError(d?.error ?? "Could not add this provider.");
        return;
      }
      setAdding(false);
      setReload((n) => n + 1);
    } catch {
      setError("Network error. Nothing was saved.");
    } finally {
      setSaving(false);
    }
  }

  async function unlink(l: PatientProviderView) {
    if (!confirm(`Remove ${l.provider.fullName} from this patient's outside providers? They stay on your roster.`)) {
      return;
    }
    const before = links;
    // Optimistic, rolled back on failure (the care-team seat pattern).
    setLinks((ls) => ls?.filter((x) => x.linkId !== l.linkId) ?? ls);
    setError(null);
    try {
      const r = await fetch(`/api/patients/${patientId}/providers/${l.linkId}`, { method: "DELETE" });
      const d = await r.json().catch(() => null);
      if (!d?.success) {
        setLinks(before);
        setError(d?.error ?? "Could not remove this provider.");
      }
    } catch {
      setLinks(before);
      setError("Network error. Nothing was removed.");
    }
  }

  async function saveProvider(p: ExternalProviderView) {
    setError(null);
    if (!providerDraft.fullName.trim()) {
      setError("The provider's name is required.");
      return;
    }
    const was = toProviderDraft(p);
    const patch: Record<string, string | null> = {};
    for (const k of PROVIDER_KEYS) {
      const v = providerDraft[k].trim();
      if (v !== was[k]) patch[k] = k === "fullName" ? v : v || null;
    }
    if (Object.keys(patch).length === 0) {
      setEditingProvider(null);
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/external-providers/${p.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = await r.json().catch(() => null);
      if (!d?.success) {
        setError(d?.error ?? "Could not update this provider.");
        return;
      }
      setEditingProvider(null);
      setReload((n) => n + 1);
    } catch {
      setError("Network error. Nothing was saved.");
    } finally {
      setSaving(false);
    }
  }

  const busy = adding || editingProvider !== null;

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Outside providers</CardTitle>
            <CardDescription>
              Primary care, referring physician and specialists. These head the visit note.
            </CardDescription>
          </div>
          {canEdit && !busy && links !== null && (
            <Button size="sm" variant="secondary" onClick={openAdd}>
              Add provider
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
        {error && !adding && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
        {links === null && !loadError && <p className="text-slate-500">Loading…</p>}
        {links !== null && links.length === 0 && !adding && (
          <p className="text-slate-500">No outside providers on file.</p>
        )}
        {links !== null && links.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {links.map((l) =>
              editingProvider === l.provider.id ? (
                <li key={l.linkId} className="py-3">
                  <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50/60 p-4">
                    <p className="text-xs text-slate-600">
                      Changes apply to every patient who sees {l.provider.fullName}.
                    </p>
                    <ProviderFields idPrefix={`edit-${l.linkId}`} draft={providerDraft} setDraft={setProviderDraft} />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void saveProvider(l.provider)} loading={saving}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingProvider(null)} disabled={saving}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                </li>
              ) : (
                <li key={l.linkId} className="py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {roleText(l)}
                    </div>
                    <div className="font-medium text-slate-900">{l.provider.fullName}</div>
                    <div className="text-slate-600">
                      {[l.provider.specialty, l.provider.practiceName].filter(Boolean).join(" · ") || "—"}
                    </div>
                    <div className="text-xs text-slate-500 tabular">
                      {[
                        l.provider.npi && `NPI ${l.provider.npi}`,
                        l.provider.phone && `Phone ${l.provider.phone}`,
                        l.provider.fax && `Fax ${l.provider.fax}`,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "No NPI or number on file"}
                    </div>
                  </div>
                  {canEdit && !busy && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setError(null);
                          setEditingProvider(l.provider.id);
                          setProviderDraft(toProviderDraft(l.provider));
                        }}
                      >
                        Edit details
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void unlink(l)}>
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              ),
            )}
          </ul>
        )}

        {adding && (
          <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50/60 p-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field id="provider-role" label="Role" required>
                <Select
                  id="provider-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as ExternalProviderRole)}
                >
                  {EXTERNAL_PROVIDER_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {EXTERNAL_PROVIDER_ROLE_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </Field>
              {(role === "specialist" || role === "other") && (
                <Field
                  id="provider-role-label"
                  label={role === "specialist" ? "Specialty" : "Label"}
                  required={role === "specialist"}
                  optional={role === "other"}
                  explain="How the note header names this provider, e.g. Pulmonologist or Oncologist."
                >
                  <TextInput
                    id="provider-role-label"
                    value={roleLabel}
                    maxLength={80}
                    placeholder={role === "specialist" ? "Pulmonologist" : ""}
                    onChange={(e) => setRoleLabel(e.target.value)}
                  />
                </Field>
              )}
            </div>

            <div className="flex gap-1 text-xs" role="tablist" aria-label="Provider source">
              {(["pick", "new"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded px-2.5 py-1 font-medium ${
                    mode === m ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {m === "pick" ? "From your roster" : "New provider"}
                </button>
              ))}
            </div>

            {mode === "pick" ? (
              <div className="space-y-2">
                <Field id="provider-search" label="Search by name, practice or NPI">
                  <TextInput
                    id="provider-search"
                    value={query}
                    autoComplete="off"
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPicked(null);
                    }}
                  />
                </Field>
                {picked ? (
                  <p className="text-slate-800">
                    Selected: <span className="font-medium">{picked.fullName}</span>
                    {picked.npi ? ` (NPI ${picked.npi})` : ""}
                  </p>
                ) : typed.length < 2 ? null : searching ? (
                  <p role="status" className="text-xs text-slate-500">
                    Searching…
                  </p>
                ) : answer?.rows === null ? (
                  <p role="alert" className="text-xs text-red-700">
                    Could not search your roster. Try again, or{" "}
                    <button type="button" className="underline" onClick={() => setMode("new")}>
                      add them as a new provider
                    </button>
                    .
                  </p>
                ) : shown.length > 0 ? (
                  <ul className="max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white">
                    {shown.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className="w-full px-3 py-1.5 text-left hover:bg-slate-50"
                          onClick={() => setPicked(p)}
                        >
                          <span className="font-medium">{p.fullName}</span>
                          <span className="text-slate-500">
                            {[p.specialty, p.practiceName, p.npi && `NPI ${p.npi}`].filter(Boolean).length > 0
                              ? ` · ${[p.specialty, p.practiceName, p.npi && `NPI ${p.npi}`].filter(Boolean).join(" · ")}`
                              : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-500">
                    No match on your roster.{" "}
                    <button type="button" className="underline" onClick={() => setMode("new")}>
                      Add them as a new provider
                    </button>
                    .
                  </p>
                )}
              </div>
            ) : (
              <ProviderFields idPrefix="provider-new" draft={draft} setDraft={setDraft} />
            )}

            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void link()} loading={saving}>
                Add
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProviderFields({
  idPrefix,
  draft,
  setDraft,
}: {
  idPrefix: string;
  draft: ProviderDraft;
  setDraft: Dispatch<SetStateAction<ProviderDraft>>;
}) {
  const input = (k: keyof ProviderDraft) => ({
    id: `${idPrefix}-${k}`,
    value: draft[k],
    autoComplete: "off",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setDraft((d) => ({ ...d, [k]: v }));
    },
  });
  const npi = draft.npi.trim();
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Field id={`${idPrefix}-fullName`} label="Name" required>
        <TextInput {...input("fullName")} maxLength={150} placeholder="Dr Alan Brooks" />
      </Field>
      <Field
        id={`${idPrefix}-npi`}
        label="NPI"
        optional
        explain="With an NPI, the same provider is one roster entry however many patients they see."
        error={npi && !isValidNpi(npi) ? "Ten digits with a valid check digit." : undefined}
      >
        <TextInput {...input("npi")} inputMode="numeric" maxLength={10} className="tabular slashed-zero" />
      </Field>
      <Field id={`${idPrefix}-specialty`} label="Specialty" optional>
        <TextInput {...input("specialty")} maxLength={120} />
      </Field>
      <Field id={`${idPrefix}-practiceName`} label="Practice" optional>
        <TextInput {...input("practiceName")} maxLength={150} />
      </Field>
      <Field id={`${idPrefix}-phone`} label="Phone" optional>
        <TextInput {...input("phone")} type="tel" />
      </Field>
      <Field id={`${idPrefix}-fax`} label="Fax" optional>
        <TextInput {...input("fax")} type="tel" />
      </Field>
    </div>
  );
}
