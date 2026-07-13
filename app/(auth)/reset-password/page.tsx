"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function ResetPasswordPage() {
  const router = useRouter();
  // Read ?token= client-side. useSearchParams would force this under a Suspense
  // boundary that can stall on a cold load and leave the page blank — the worst
  // outcome for a reset link a user clicks straight from their email. null =
  // "not yet read" so we show a neutral state instead of flashing "Invalid".
  const [token, setToken] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") ?? "");
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) return;
    if (pw !== pw2) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    const res = await fetch("/api/auth/password/confirm-reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: pw }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!data.success) {
      setError(data.error ?? "Reset failed.");
      return;
    }
    setDone(true);
    setTimeout(() => router.push("/login"), 1500);
  }

  if (token === null) {
    return (
      <Card className="w-full max-w-md mx-auto">
        <CardContent className="p-8">
          <h1 className="font-display text-2xl tracking-tight">Set a new password</h1>
          <p className="text-sm text-slate-500 mt-3">Verifying your reset link…</p>
        </CardContent>
      </Card>
    );
  }

  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    return (
      <Card className="w-full max-w-md mx-auto">
        <CardContent className="p-8">
          <h1 className="text-xl font-bold">Invalid reset link</h1>
          <p className="text-sm text-slate-600 mt-2">
            The link is malformed.{" "}
            <Link href="/forgot-password" className="underline text-[var(--color-brand-700)]">
              Request a new one
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md mx-auto">
      <CardContent className="p-8">
        <h1 className="font-display text-2xl tracking-tight">Set a new password</h1>
        {done ? (
          <p className="text-sm text-emerald-700 mt-4">Done. Redirecting to login…</p>
        ) : (
          <form onSubmit={submit} className="space-y-4 mt-5">
            <label className="block">
              <span className="block text-xs font-medium text-slate-700 mb-1">New password (min 12 chars)</span>
              <input
                required
                type="password"
                minLength={12}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-slate-700 mb-1">Confirm</span>
              <input
                required
                type="password"
                minLength={12}
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono"
              />
            </label>
            {error && (
              <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
                {error}
              </div>
            )}
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? "Saving…" : "Set password"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
