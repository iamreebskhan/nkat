/**
 * /payers/attestations/new — log a payer phone call.
 *
 * Required fields per vision §15.3: payer, state, CPT, attribute,
 * coverage status, rep name, call date, confirmed quote. Optional:
 * rep ID, call time, phone number, notes.
 */
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface PayerOption {
  id: string;
  name: string;
}

export default function NewAttestationPage() {
  return (
    <Suspense fallback={null}>
      <NewAttestationInner />
    </Suspense>
  );
}

function NewAttestationInner() {
  const router = useRouter();
  const params = useSearchParams();
  const requestId = params.get("requestId");

  const [payers, setPayers] = useState<PayerOption[]>([]);
  const [form, setForm] = useState({
    payerId: "",
    state: params.get("state") ?? "",
    cptCode: params.get("cptCode") ?? "",
    attribute: params.get("attribute") ?? "coverage",
    coverageStatus: "covered" as "covered" | "not_covered" | "varies" | "unknown",
    payerRepName: "",
    payerRepId: "",
    callDate: new Date().toISOString().slice(0, 10),
    callTime: "",
    callPhoneNumber: "",
    callNotes: "",
    confirmedQuote: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/billing/payers")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setPayers(data.data.rows ?? data.data ?? []);
      })
      .catch(() => undefined);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/attestations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payerId: form.payerId,
          state: form.state.toUpperCase(),
          cptCode: form.cptCode,
          attribute: form.attribute,
          coverageStatus: form.coverageStatus,
          payerRepName: form.payerRepName,
          payerRepId: form.payerRepId || undefined,
          callDate: form.callDate,
          callTime: form.callTime || undefined,
          callPhoneNumber: form.callPhoneNumber || undefined,
          callNotes: form.callNotes || undefined,
          confirmedQuote: form.confirmedQuote || undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Save failed.");
        setSubmitting(false);
        return;
      }
      if (requestId) {
        await fetch(`/api/attestations/requests/${requestId}/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attestationId: data.data.id }),
        });
      }
      router.push("/payers/attestations");
    } catch {
      setError("Network error.");
      setSubmitting(false);
    }
  }

  return (
    <div className="px-8 py-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Log payer call</h1>
        <p className="text-slate-600 mt-1">
          Confirmed rules expire 90 days from call date.
        </p>
      </header>

      <Card>
        <CardContent className="p-6">
          <form onSubmit={submit} className="space-y-5">
            <Row>
              <Field label="Payer" required>
                <select
                  required
                  value={form.payerId}
                  onChange={(e) => setForm({ ...form, payerId: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
                >
                  <option value="">Select…</option>
                  {payers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="State" required>
                <input
                  required
                  value={form.state}
                  onChange={(e) => setForm({ ...form, state: e.target.value })}
                  maxLength={2}
                  pattern="[A-Za-z]{2}"
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm uppercase"
                />
              </Field>
            </Row>
            <Row>
              <Field label="CPT" required>
                <input
                  required
                  value={form.cptCode}
                  onChange={(e) => setForm({ ...form, cptCode: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono"
                />
              </Field>
              <Field label="Attribute" required>
                <input
                  required
                  value={form.attribute}
                  onChange={(e) => setForm({ ...form, attribute: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Coverage" required>
                <select
                  value={form.coverageStatus}
                  onChange={(e) => setForm({ ...form, coverageStatus: e.target.value as typeof form.coverageStatus })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
                >
                  <option value="covered">Covered</option>
                  <option value="not_covered">Not covered</option>
                  <option value="varies">Varies</option>
                  <option value="unknown">Unknown</option>
                </select>
              </Field>
            </Row>
            <Row>
              <Field label="Payer rep name" required>
                <input
                  required
                  value={form.payerRepName}
                  onChange={(e) => setForm({ ...form, payerRepName: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Rep ID">
                <input
                  value={form.payerRepId}
                  onChange={(e) => setForm({ ...form, payerRepId: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </Field>
            </Row>
            <Row>
              <Field label="Call date" required>
                <input
                  required
                  type="date"
                  value={form.callDate}
                  onChange={(e) => setForm({ ...form, callDate: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Phone number">
                <input
                  value={form.callPhoneNumber}
                  onChange={(e) => setForm({ ...form, callPhoneNumber: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </Field>
            </Row>
            <Field label="Confirmed quote (verbatim)">
              <textarea
                value={form.confirmedQuote}
                onChange={(e) => setForm({ ...form, confirmedQuote: e.target.value })}
                rows={3}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                placeholder='"99349 telehealth covered when…"'
              />
            </Field>
            <Field label="Notes">
              <textarea
                value={form.callNotes}
                onChange={(e) => setForm({ ...form, callNotes: e.target.value })}
                rows={3}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              />
            </Field>

            {error && (
              <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : "Save attestation"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-3 gap-4">{children}</div>;
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-700 mb-1">
        {label}
        {required && <span className="text-red-600 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}
