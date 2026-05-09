/**
 * /signup — public org sign-up page.
 *
 * Source: pallio_complete_vision_v3 §9.1.
 *
 *   "Organizations sign up and own their account independently. No
 *    consultant creates the account on their behalf. This is required
 *    for HIPAA compliance — the covered entity must own and control
 *    access to their data."
 *
 * Phase 5 dev shim: this page collects the org rep's name + email +
 * password + BAA acknowledgment, then issues a session cookie + redirects
 * to `/onboarding` where the 5-step wizard runs.
 *
 * The real flow (Phase 7) creates a real `org` + `app_user` row, signs
 * the BAA via DocuSign-equivalent, and routes through Stripe before
 * landing on the wizard.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const BAA_TEXT = `Business Associate Agreement (Pallio).

This Business Associate Agreement is entered into between the organization
("Covered Entity") and Pallio (a service of NTAKT Inc., "Business Associate")
to comply with the Health Insurance Portability and Accountability Act of
1996 ("HIPAA") and the Health Information Technology for Economic and
Clinical Health Act ("HITECH").

Business Associate agrees to:
  1. Use and disclose Protected Health Information (PHI) only for the
     purpose of providing the Pallio platform services.
  2. Implement administrative, physical, and technical safeguards that
     reasonably and appropriately protect the confidentiality, integrity,
     and availability of PHI.
  3. Report any unauthorized use or disclosure of PHI to Covered Entity
     within 72 hours.
  4. Make PHI available for amendment and accounting upon request, in
     accordance with 45 CFR §164.526 and §164.528.
  5. Return or destroy PHI upon termination of this agreement, where feasible.

Covered Entity agrees to:
  1. Notify Business Associate of any restrictions on uses or disclosures
     of PHI that Covered Entity has agreed to.
  2. Not request Business Associate to use or disclose PHI in any manner
     that would violate HIPAA.

This agreement is effective on the date of electronic acknowledgment below
and remains in effect until terminated in writing by either party.

By acknowledging below, the signing user represents that they have authority
to bind the organization to this agreement.`;

export default function SignupPage() {
  const router = useRouter();
  const [orgName, setOrgName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [npi, setNpi] = useState("");
  const [baaAck, setBaaAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    orgName.length >= 2 &&
    contactName.length >= 2 &&
    email.includes("@") &&
    password.length >= 8 &&
    npi.length === 10 &&
    baaAck;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Phase 5 dev shim: re-use the existing /api/auth/login dev shim
      // (NODE_ENV gated). Org creation + Stripe + BAA signature ride
      // along with this in Phase 7. For now we just sign in and let
      // the onboarding wizard collect org details.
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Sign-up failed.");
        return;
      }
      router.push("/onboarding");
    } catch {
      setError("Network error.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="my-8">
      <CardHeader>
        <CardTitle className="font-display">Create your Pallio account</CardTitle>
        <CardDescription>
          Your organization owns its account and signs a BAA directly with us.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field id="org" label="Organization name" required>
            <TextInput
              id="org"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              autoComplete="organization"
            />
          </Field>
          <Field id="npi" label="Organization NPI" required hint="10 digits">
            <TextInput
              id="npi"
              value={npi}
              onChange={(e) => setNpi(e.target.value.replace(/\D/g, "").slice(0, 10))}
              className="tabular slashed-zero"
            />
          </Field>
          <Field id="contact" label="Your name" required>
            <TextInput
              id="contact"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              autoComplete="name"
            />
          </Field>
          <Field id="email" label="Work email" required>
            <TextInput
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </Field>
          <Field id="pw" label="Password" required hint="≥ 8 characters">
            <TextInput
              id="pw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>

          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">
              Business Associate Agreement (BAA)
              <span className="text-red-600 ml-0.5" aria-hidden>*</span>
              <span className="sr-only"> required</span>
            </p>
            <pre className="text-xs leading-relaxed bg-slate-50 ring-1 ring-slate-200 rounded-md p-3 max-h-44 overflow-y-auto whitespace-pre-wrap font-sans">
              {BAA_TEXT}
            </pre>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={baaAck}
                onChange={(e) => setBaaAck(e.target.checked)}
                className="mt-1"
              />
              <span className="text-sm text-slate-700">
                I have authority to bind <strong>{orgName || "the organization"}</strong> and agree
                to the BAA on its behalf.
              </span>
            </label>
          </div>

          {error && (
            <p
              role="alert"
              className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded-md ring-1 ring-inset ring-red-600/20"
            >
              {error}
            </p>
          )}

          <Button type="submit" loading={submitting} disabled={!ready} className="w-full">
            Create account
          </Button>

          <p className="text-xs text-slate-500 text-center mt-2">
            Already have an account?{" "}
            <Link href="/login" className="text-[var(--color-brand-700)] underline">
              Sign in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
