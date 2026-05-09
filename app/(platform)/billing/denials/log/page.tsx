/**
 * /billing/denials/log — log a new denial.
 *
 * Source: pallio_complete_vision_v3 §6.5 + §8.4.
 *
 * Form: superbill ID + CPT + CARC + reason + denied amount + DOS.
 * Auto-runs AI analysis on save.
 */
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function LogDenialPage() {
  const router = useRouter();
  const [superbillId, setSuperbillId] = useState("");
  const [cptCode, setCptCode] = useState("");
  const [carcCode, setCarcCode] = useState("");
  const [rarcCode, setRarcCode] = useState("");
  const [denialReason, setDenialReason] = useState("");
  const [deniedAmount, setDeniedAmount] = useState("");
  const [deniedAt, setDeniedAt] = useState(
    new Date().toISOString().slice(0, 16),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    superbillId.length === 36 &&
    cptCode.length >= 5 &&
    carcCode.length >= 1 &&
    deniedAt.length >= 16;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/denials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          superbillId,
          cptCode: cptCode.toUpperCase(),
          carcCode: carcCode.toUpperCase(),
          rarcCode: rarcCode || undefined,
          denialReason: denialReason || undefined,
          deniedAmountCents: deniedAmount
            ? Math.round(parseFloat(deniedAmount) * 100)
            : undefined,
          deniedAt: new Date(deniedAt).toISOString(),
        }),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Save failed.");
        return;
      }
      // Trigger AI analysis in the background; the detail page picks it up.
      const id = data.data.id;
      void fetch(`/api/denials/${id}/analyze`, { method: "POST" });
      router.push(`/billing/denials/${id}`);
    } catch {
      setError("Network error.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-8 py-8 max-w-2xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Log denial</h1>
        <p className="text-slate-600 mt-1">
          Record an EOB denial against a superbill. AI analysis runs automatically.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Denial detail</CardTitle>
          <CardDescription>From the EOB or 835 file.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4" noValidate>
            <Field id="sb" label="Superbill ID" required hint="UUID — copy from the superbill page">
              <TextInput
                id="sb"
                value={superbillId}
                onChange={(e) => setSuperbillId(e.target.value)}
                className="font-mono text-xs"
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </Field>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field id="cpt" label="CPT / HCPCS" required>
                <TextInput
                  id="cpt"
                  value={cptCode}
                  onChange={(e) => setCptCode(e.target.value.toUpperCase())}
                  placeholder="99349"
                  className="tabular slashed-zero uppercase"
                />
              </Field>
              <Field id="carc" label="CARC" required hint="e.g. 197, B7">
                <TextInput
                  id="carc"
                  value={carcCode}
                  onChange={(e) => setCarcCode(e.target.value.toUpperCase())}
                  placeholder="197"
                  className="tabular uppercase"
                />
              </Field>
              <Field id="rarc" label="RARC" optional>
                <TextInput
                  id="rarc"
                  value={rarcCode}
                  onChange={(e) => setRarcCode(e.target.value.toUpperCase())}
                  className="tabular uppercase"
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field id="amt" label="Denied amount ($)" optional>
                <TextInput
                  id="amt"
                  type="number"
                  step="0.01"
                  min="0"
                  value={deniedAmount}
                  onChange={(e) => setDeniedAmount(e.target.value)}
                  className="tabular"
                />
              </Field>
              <Field id="dos" label="Denied at" required>
                <TextInput
                  id="dos"
                  type="datetime-local"
                  value={deniedAt}
                  onChange={(e) => setDeniedAt(e.target.value)}
                />
              </Field>
            </div>

            <Field id="reason" label="Denial reason (free-text from EOB)" optional>
              <TextArea
                id="reason"
                rows={3}
                value={denialReason}
                onChange={(e) => setDenialReason(e.target.value)}
              />
            </Field>

            {error && (
              <p
                role="alert"
                className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded-md ring-1 ring-inset ring-red-600/20"
              >
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                type="button"
                onClick={() => router.push("/billing/denials")}
              >
                Cancel
              </Button>
              <Button type="submit" loading={submitting} disabled={!ready}>
                Save + analyze
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
