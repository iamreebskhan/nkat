"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  /** 'creds' | 'mfa' — flips when the server returns mfa_required. */
  const [stage, setStage] = useState<"creds" | "mfa">("creds");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          mfaCode: stage === "mfa" ? mfaCode : undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        // Server says "MFA code required" → flip the form into MFA mode.
        if (res.status === 401 && /mfa code required/i.test(data.error ?? "")) {
          setStage("mfa");
          setError(null);
          return;
        }
        setError(data.error ?? "Sign-in failed.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-display">Sign in to Pallio</CardTitle>
        <CardDescription>
          Palliative-care EMR + billing intelligence.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium text-slate-700">
              Work email
              <span className="text-red-600 ml-0.5" aria-hidden>*</span>
              <span className="sr-only">required</span>
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              readOnly={stage === "mfa"}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-10 px-3 rounded-md border border-slate-300 bg-white text-base focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 read-only:bg-slate-50 read-only:text-slate-600"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium text-slate-700">
              Password
              <span className="text-red-600 ml-0.5" aria-hidden>*</span>
              <span className="sr-only">required</span>
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              readOnly={stage === "mfa"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-10 px-3 rounded-md border border-slate-300 bg-white text-base focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 read-only:bg-slate-50 read-only:text-slate-600"
            />
          </div>

          {stage === "mfa" && (
            <div className="space-y-1.5">
              <label htmlFor="mfaCode" className="text-sm font-medium text-slate-700">
                6-digit code from your authenticator
                <span className="text-red-600 ml-0.5" aria-hidden>*</span>
              </label>
              <input
                id="mfaCode"
                name="mfaCode"
                type="text"
                inputMode="numeric"
                pattern="\d{6}|[0-9a-f]{10}"
                autoComplete="one-time-code"
                required
                autoFocus
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="123456"
                className="w-full h-10 px-3 rounded-md border border-slate-300 bg-white text-base font-mono tracking-[0.3em] text-center focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2"
              />
              <p className="text-xs text-slate-500">
                Lost your phone? Enter a 10-character recovery code instead.
              </p>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-600 flex items-center gap-1">
              {error}
            </p>
          )}

          <Button type="submit" loading={submitting} className="w-full">
            {stage === "mfa" ? "Verify" : "Sign in"}
          </Button>

          {stage === "creds" && (
            <div className="flex items-center justify-between text-xs text-slate-600 pt-1">
              <Link href="/forgot-password" className="text-[var(--color-brand-700)] underline">
                Forgot password?
              </Link>
              <span>
                New here?{" "}
                <Link href="/signup" className="text-[var(--color-brand-700)] underline">
                  Create an account
                </Link>
              </span>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
