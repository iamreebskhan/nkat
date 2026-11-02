/**
 * Prior authorizations on the chart (0124). What the payer approved, for which
 * codes and dates: the claim carries the number (box 23), and the bill's review
 * asks when a payer's rule requires one and none covers the visit. A mistaken
 * one is withdrawn, and stays on record.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import { Field, Select, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PriorAuthView } from "@/lib/features/patients/prior-auth.service";

interface Draft {
  payerId: string;
  authNumber: string;
  codes: string;
  validFrom: string;
  validTo: string;
  visits: string;
}

const EMPTY: Draft = { payerId: "", authNumber: "", codes: "", validFrom: "", validTo: "", visits: "" };

export function PriorAuthsCard({ patientId, canEdit, className }: { patientId: string; canEdit: boolean; className?: string }) {
  const [auths, setAuths] = useState<PriorAuthView[] | null>(null);
  const [plans, setPlans] = useState<{ id: string; name: string }[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [f, setF] = useState<Draft>(EMPTY);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/patients/${patientId}/prior-auths`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return setFailed(d.error ?? "Could not load the authorizations.");
        setAuths(d.data.auths);
        setPlans(d.data.plans);
      })
      .catch(() => setFailed("Network error."));
  }, [patientId]);
  useEffect(() => load(), [load]);

  const set = (k: keyof Draft) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setMsg(null);
  };

  function open(a?: PriorAuthView) {
    setMsg(null);
    setEditing(a ? a.id : "new");
    setF(
      a
        ? { payerId: a.payerId, authNumber: a.authNumber, codes: a.codes.join(", "), validFrom: a.validFrom, validTo: a.validTo, visits: a.visitsAuthorized?.toString() ?? "" }
        : { ...EMPTY, payerId: plans[0]?.id ?? "" },
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[A-Za-z0-9-]{1,50}$/.test(f.authNumber.trim())) return setMsg("The authorization number, as the payer gave it: letters, digits and hyphens.");
    if (!f.validFrom || !f.validTo) return setMsg("The dates it runs.");
    if (f.validTo < f.validFrom) return setMsg("The authorization ends before it starts.");
    if (f.visits.trim() && !/^\d+$/.test(f.visits.trim())) return setMsg("Visits allowed is a whole number, or leave it empty.");
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(editing === "new" ? `/api/patients/${patientId}/prior-auths` : `/api/patients/${patientId}/prior-auths/${editing}`, {
        method: editing === "new" ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payerId: f.payerId,
          authNumber: f.authNumber.trim(),
          codes: f.codes.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean),
          validFrom: f.validFrom,
          validTo: f.validTo,
          visitsAuthorized: f.visits.trim() ? Number(f.visits) : null,
        }),
      });
      const d = await r.json();
      if (!d.success) return setMsg(d.error ?? "Not saved.");
      setEditing(null);
      load();
    } catch {
      setMsg("Network error — not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(a: PriorAuthView) {
    if (!window.confirm(`Withdraw authorization ${a.authNumber} as recorded in error? It stops going on claims, and stays on record.`)) return;
    const d = await fetch(`/api/patients/${patientId}/prior-auths/${a.id}`, { method: "DELETE" }).then((r) => r.json()).catch(() => null);
    if (!d?.success) return setFailed(d?.error ?? "Not withdrawn.");
    load();
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Prior authorizations</CardTitle>
        <CardDescription>What the payer approved. A claim it covers carries the number (box 23).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {failed && (
          <p role="alert" className="text-red-700">
            {failed}
          </p>
        )}
        {auths === null ? (
          !failed && <p className="text-slate-500">Loading…</p>
        ) : auths.length === 0 ? (
          <p className="text-slate-500">None on file.</p>
        ) : (
          <ul className="divide-y divide-slate-100" aria-label="Prior authorizations">
            {auths.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 py-1.5">
                <span>
                  <span className="font-mono">{a.authNumber}</span> · {a.payerName ?? "Plan"}
                  <span className="block text-xs text-slate-600">
                    {a.validFrom} to {a.validTo} · {a.codes.length > 0 ? a.codes.join(", ") : "all services"}
                    {a.visitsAuthorized !== null ? ` · ${a.visitsUsed} of ${a.visitsAuthorized} visits used` : ` · ${a.visitsUsed} billed`}
                  </span>
                  {a.visitsAuthorized !== null && a.visitsUsed >= a.visitsAuthorized && (
                    <span className="mt-0.5 block rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-900">All the visits it allows are used.</span>
                  )}
                </span>
                {canEdit && (
                  <span className="flex gap-3 text-xs">
                    <button type="button" className="text-[var(--color-brand-700)] hover:underline" onClick={() => open(a)}>
                      Edit
                    </button>
                    <button type="button" className="text-slate-500 hover:text-red-700" onClick={() => void withdraw(a)}>
                      Withdraw
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit &&
          auths !== null &&
          (editing === null ? (
            plans.length > 0 ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => open()}>
                Add an authorization
              </Button>
            ) : (
              <p className="text-xs text-slate-500">Add the patient&rsquo;s plan under Insurance first.</p>
            )
          ) : (
            <form onSubmit={save} noValidate className="grid grid-cols-1 md:grid-cols-2 gap-3" aria-label="Prior authorization">
              <Field id="pa-plan" label="Plan" required>
                <Select id="pa-plan" value={f.payerId} onChange={set("payerId")}>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="pa-number" label="Authorization number" required>
                <TextInput id="pa-number" maxLength={50} value={f.authNumber} onChange={set("authNumber")} />
              </Field>
              <Field id="pa-from" label="From" required>
                <TextInput id="pa-from" type="date" value={f.validFrom} onChange={set("validFrom")} />
              </Field>
              <Field id="pa-to" label="To" required>
                <TextInput id="pa-to" type="date" value={f.validTo} onChange={set("validTo")} />
              </Field>
              <Field id="pa-codes" label="Codes" optional explain="As the approval lists them. Leave empty if it covers every service under the plan.">
                <TextInput id="pa-codes" placeholder="99349, 99350" value={f.codes} onChange={set("codes")} />
              </Field>
              <Field id="pa-visits" label="Visits allowed" optional explain="When the payer caps them.">
                <TextInput id="pa-visits" inputMode="numeric" maxLength={4} value={f.visits} onChange={set("visits")} />
              </Field>
              {msg && (
                <p role="alert" className="md:col-span-2 text-red-700">
                  {msg}
                </p>
              )}
              <div className="md:col-span-2 flex justify-end gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" loading={busy}>
                  Save
                </Button>
              </div>
            </form>
          ))}
      </CardContent>
    </Card>
  );
}
