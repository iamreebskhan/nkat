/**
 * Coverage checks (Level-1 doc:23, 0111): each time someone checked a
 * referral's or a patient's insurance, how, and what it said.
 *
 * Recorded by hand (the person on the payer portal or the phone), or asked
 * electronically through a connected clearinghouse (0120), when the payer's
 * own answer is kept with the check and opens under it. The same list sits on
 * the referral and on the chart, where the referral's checks follow the
 * person at admission.
 */
"use client";

import { useEffect, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { hospiceElectionText, type EligibilitySummary } from "@/lib/features/clearinghouse/x12/x12-271";
import { BENEFIT_INFO, ELIGIBILITY_ERRORS, INSURANCE_TYPES, SERVICE_TYPES } from "@/lib/features/clearinghouse/x12/x12-codes";
import {
  VERIFICATION_METHODS,
  VERIFICATION_METHOD_LABEL,
  VERIFICATION_RESULTS,
  VERIFICATION_RESULT_LABEL,
  VerificationSchema,
  type VerificationResult,
  type VerificationView,
} from "@/lib/features/referrals/referral.types";

interface PayerOption {
  id: string;
  name: string;
  states: string[];
}

export const RESULT_STYLE: Record<VerificationResult, string> = {
  active: "bg-emerald-50 text-emerald-900 ring-emerald-600/30",
  inactive: "bg-red-50 text-red-900 ring-red-600/30",
  not_found: "bg-red-50 text-red-900 ring-red-600/30",
  pending: "bg-amber-50 text-amber-900 ring-amber-600/30",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "covered from 2026-01-01, no end date", "covered 2026-01-01 to 2026-12-31", "covered until 2026-12-31". */
const coveredText = (from: string | null, to: string | null) =>
  from && to ? `covered ${from} to ${to}` : from ? `covered from ${from}, no end date` : `covered until ${to}`;

/** The plan's name, then its kind when that adds something ("MEDICARE PART B" and "Medicare Part B" once). */
function planText(s: EligibilitySummary): string {
  const kind = s.insuranceType ? INSURANCE_TYPES[s.insuranceType] ?? s.insuranceType : null;
  return [s.planDescription, kind && kind.toLowerCase() !== s.planDescription?.toLowerCase() ? kind : null].filter(Boolean).join(" · ");
}

export function CoverageCheckList({ checks, emptyText }: { checks: VerificationView[]; emptyText: string }) {
  if (checks.length === 0) return <p className="text-sm text-slate-500">{emptyText}</p>;
  return (
    <ul className="divide-y divide-slate-100 text-sm" aria-label="Coverage checks">
      {checks.map((c) => (
        <li key={c.id} className="py-2 first:pt-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${RESULT_STYLE[c.result]}`}
            >
              {VERIFICATION_RESULT_LABEL[c.result]}
            </span>
            <span className="text-slate-800">{c.payerName ?? "Plan not named"}</span>
            {c.memberId && <span className="font-mono tabular text-xs text-slate-600">{c.memberId}</span>}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {VERIFICATION_METHOD_LABEL[c.method]}
            {c.reference ? ` · ref ${c.reference}` : ""}
            {c.coverageEffectiveOn || c.coverageEndsOn ? ` · ${coveredText(c.coverageEffectiveOn, c.coverageEndsOn)}` : ""}
            {" · "}
            {c.verifiedByName ?? "Someone"}, {when(c.verifiedAt)}
          </p>
          {c.notes && <p className="mt-0.5 text-xs text-slate-600 whitespace-pre-wrap">{c.notes}</p>}
          {c.details && <EligibilityDetails s={c.details} />}
        </li>
      ))}
    </ul>
  );
}

const money = (cents: number | null) => (cents === null ? "" : `$${(cents / 100).toFixed(2)}`);

/** What the payer said, from its 271 (or Availity's API): opens under the check. */
export function EligibilityDetails({ s }: { s: EligibilitySummary }) {
  const costs = s.benefits.filter((b) => ["A", "B", "C", "G"].includes(b.info));
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-[var(--color-brand-700)]">What the payer said</summary>
      <div className="mt-1 space-y-1 rounded-md bg-slate-50 px-2 py-1.5 text-slate-700">
        {s.errors.length > 0 && (
          <p className="text-red-700">
            {s.errors.map((e) => `${ELIGIBILITY_ERRORS[e.code] ?? `Payer error ${e.code}`}${e.followUp === "C" ? " — correct the request and ask again" : ""}`).join("; ")}
          </p>
        )}
        {(s.planDescription || s.insuranceType) && (
          <p>
            Plan: {planText(s)}
            {s.groupNumber ? ` · group ${s.groupNumber}` : ""}
          </p>
        )}
        {(s.planBegin || s.eligibilityBegin || s.planEnd || s.eligibilityEnd) && (
          <p className="first-letter:uppercase">{coveredText(s.eligibilityBegin ?? s.planBegin, s.eligibilityEnd ?? s.planEnd)}</p>
        )}
        {s.hospice.length > 0 && (
          <p className="font-medium text-amber-900">Hospice election on file: {s.hospice.map(hospiceElectionText).join("; ")}</p>
        )}
        {s.otherPayers.length > 0 && (
          <p>Another payer: {s.otherPayers.map((o) => `${o.name ?? "not named"}${o.insuranceType ? ` (${INSURANCE_TYPES[o.insuranceType] ?? o.insuranceType})` : ""}`).join("; ")}</p>
        )}
        {costs.length > 0 && (
          <ul className="list-disc pl-4">
            {costs.map((b, i) => (
              <li key={i}>
                {BENEFIT_INFO[b.info] ?? b.info}
                {b.serviceTypes.length > 0 ? ` for ${b.serviceTypes.map((t) => SERVICE_TYPES[t] ?? t).join(", ")}` : ""}
                {b.amountCents !== null ? `: ${money(b.amountCents)}` : ""}
                {b.percent !== null ? `: ${b.percent}%` : ""}
                {b.inNetwork === "Y" ? " (in network)" : b.inNetwork === "N" ? " (out of network)" : ""}
              </li>
            ))}
          </ul>
        )}
        {s.messages.length > 0 && <p className="text-slate-600">{s.messages.join(" ")}</p>}
      </div>
    </details>
  );
}

/**
 * The "Record a check" form. It starts from the plan and member ID on file;
 * the plan list is the practice's payer list when the viewer may read it,
 * otherwise only the plan on file.
 */
export function CoverageCheckForm({
  postUrl,
  defaultPayerId,
  defaultPayerName,
  defaultMemberId,
  onSaved,
  onCancel,
}: {
  postUrl: string;
  defaultPayerId: string | null;
  defaultPayerName: string | null;
  defaultMemberId: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState({
    payerId: defaultPayerId ?? "",
    memberId: defaultMemberId ?? "",
    method: "",
    result: "",
    coverageEffectiveOn: "",
    coverageEndsOn: "",
    reference: "",
    notes: "",
  });
  type Form = typeof f;
  const [payers, setPayers] = useState<PayerOption[]>([]);
  const [issue, setIssue] = useState<{ path: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let abandoned = false;
    fetch("/api/billing/payers")
      .then((r) => r.json())
      .then((d) => {
        if (!abandoned && d.success) setPayers(d.data?.payers ?? []);
      })
      .catch(() => {});
    return () => {
      abandoned = true;
    };
  }, []);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setIssue(null);
  };
  const errorFor = (k: keyof Form) => (issue?.path === k ? issue.message : undefined);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!f.method) return setIssue({ path: "method", message: "How was it checked?" });
    if (!f.result) return setIssue({ path: "result", message: "What did it say?" });
    const body = Object.fromEntries(
      Object.entries(f)
        .map(([k, v]) => [k, v.trim()])
        .filter(([, v]) => v !== ""),
    );
    const parsed = VerificationSchema.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      return setIssue({ path: String(i.path[0] ?? ""), message: i.message });
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(postUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Not saved.");
        return;
      }
      onSaved();
    } catch {
      setError("Network error — not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} noValidate className="grid grid-cols-1 md:grid-cols-2 gap-3" aria-label="Record a coverage check">
      <Field id="cv-payer" label="Plan checked" optional error={errorFor("payerId")}>
        <Select id="cv-payer" value={f.payerId} onChange={set("payerId")}>
          <option value="">Not named</option>
          {defaultPayerId && !payers.some((p) => p.id === defaultPayerId) && (
            <option value={defaultPayerId}>{defaultPayerName ?? "The plan on file"}</option>
          )}
          {payers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.states.length > 0 ? ` · ${p.states.join("/")}` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="cv-member" label="Member ID" optional error={errorFor("memberId")}>
        <TextInput id="cv-member" value={f.memberId} onChange={set("memberId")} />
      </Field>
      <Field id="cv-method" label="Checked by" required error={errorFor("method")}>
        <Select id="cv-method" value={f.method} onChange={set("method")} invalid={Boolean(errorFor("method"))}>
          <option value="" disabled>
            Choose…
          </option>
          {VERIFICATION_METHODS.map((m) => (
            <option key={m} value={m}>
              {VERIFICATION_METHOD_LABEL[m]}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="cv-result" label="Result" required error={errorFor("result")}>
        <Select id="cv-result" value={f.result} onChange={set("result")} invalid={Boolean(errorFor("result"))}>
          <option value="" disabled>
            Choose…
          </option>
          {VERIFICATION_RESULTS.map((r) => (
            <option key={r} value={r}>
              {VERIFICATION_RESULT_LABEL[r]}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="cv-eff" label="Coverage starts" optional error={errorFor("coverageEffectiveOn")}>
        <TextInput id="cv-eff" type="date" value={f.coverageEffectiveOn} onChange={set("coverageEffectiveOn")} />
      </Field>
      <Field id="cv-ends" label="Coverage ends" optional error={errorFor("coverageEndsOn")}>
        <TextInput
          id="cv-ends"
          type="date"
          value={f.coverageEndsOn}
          onChange={set("coverageEndsOn")}
          invalid={Boolean(errorFor("coverageEndsOn"))}
        />
      </Field>
      <Field
        id="cv-ref"
        label="Reference"
        optional
        explain="The call reference or the portal's transaction number, if it gave one."
        error={errorFor("reference")}
      >
        <TextInput id="cv-ref" value={f.reference} maxLength={100} onChange={set("reference")} />
      </Field>
      <div className="md:col-span-2">
        <Field id="cv-notes" label="Notes" optional error={errorFor("notes")}>
          <TextArea id="cv-notes" rows={2} maxLength={1000} value={f.notes} onChange={set("notes")} />
        </Field>
      </div>
      <div className="md:col-span-2 space-y-2">
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" loading={saving}>
            Save check
          </Button>
        </div>
      </div>
    </form>
  );
}
