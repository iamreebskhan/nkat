/**
 * /signup — self-serve org signup with inline BAA.
 *
 * Source: pallio_complete_vision_v3 §6.2.
 * Mark's first impression: 30 seconds from signup to first lookup.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    email: "",
    password: "",
    fullName: "",
    orgName: "",
    baaAccepted: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBaa, setShowBaa] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!data.success) {
      setError(data.error ?? "Signup failed.");
      return;
    }
    router.push(data.data.redirectTo ?? "/");
  }

  return (
    <Card className="w-full max-w-lg mx-auto">
      <CardContent className="p-8">
          <h1 className="font-display text-3xl tracking-tight">Create your Pallio account</h1>
          <p className="text-sm text-slate-600 mt-1 mb-6">
            30 seconds from here to your first rule lookup.
          </p>

          <form onSubmit={submit} className="space-y-4">
            <Field label="Your full name" required>
              <input
                required
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Work email" required>
              <input
                required
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Password (min 12 characters)" required>
              <input
                required
                type="password"
                minLength={12}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono"
              />
            </Field>
            <Field label="Organization name" required>
              <input
                required
                value={form.orgName}
                onChange={(e) => setForm({ ...form, orgName: e.target.value })}
                placeholder="Acme Hospice"
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              />
            </Field>

            <div className="border border-slate-200 rounded p-4 bg-slate-50/50">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  required
                  type="checkbox"
                  checked={form.baaAccepted}
                  onChange={(e) => setForm({ ...form, baaAccepted: e.target.checked })}
                  className="mt-0.5"
                />
                <span className="text-sm text-slate-700">
                  I have read and agree to Pallio's{" "}
                  <button
                    type="button"
                    onClick={() => setShowBaa((v) => !v)}
                    className="text-[var(--color-brand-700)] underline font-medium"
                  >
                    Business Associate Agreement
                  </button>{" "}
                  and the Terms of Service.
                </span>
              </label>
              {showBaa && (
                <div className="mt-3 max-h-56 overflow-y-auto border border-slate-200 rounded bg-white p-3 text-xs text-slate-700 leading-relaxed">
                  <p className="font-bold mb-1">Business Associate Agreement (Summary)</p>
                  <p>
                    This BAA governs the relationship between Pallio (Business
                    Associate) and your organization (Covered Entity) under
                    HIPAA Privacy &amp; Security Rules.
                  </p>
                  <ul className="list-disc pl-5 mt-2 space-y-1">
                    <li>Pallio uses PHI only as needed to provide the platform.</li>
                    <li>Pallio applies safeguards: RLS, encryption at rest + transit, audit logs (6yr retention).</li>
                    <li>Pallio reports breaches within 60 days per §164.410.</li>
                    <li>Pallio returns/destroys PHI on termination per §164.504(e)(2)(ii)(J).</li>
                    <li>Subcontractors with PHI access execute downstream BAAs.</li>
                  </ul>
                  <p className="mt-2 italic">
                    Full executable BAA is sent for signature post-onboarding.
                    This summary is binding interim acceptance.
                  </p>
                </div>
              )}
            </div>

            {error && (
              <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
                {error}
              </div>
            )}

            <Button type="submit" disabled={submitting || !form.baaAccepted} className="w-full">
              {submitting ? "Creating account…" : "Create account"}
            </Button>
          </form>

          <p className="text-xs text-slate-500 mt-6 text-center">
            Already have an account?{" "}
            <Link href="/login" className="text-[var(--color-brand-700)] underline">
              Log in
            </Link>
          </p>
        </CardContent>
    </Card>
  );
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
