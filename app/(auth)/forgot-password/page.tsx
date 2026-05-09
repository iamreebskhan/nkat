"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    await fetch("/api/auth/password/request-reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setSubmitted(true);
    setSubmitting(false);
  }

  return (
    <Card className="w-full max-w-md mx-auto">
      <CardContent className="p-8">
        <h1 className="font-display text-2xl tracking-tight">Forgot password</h1>
        {submitted ? (
          <div className="mt-4 text-sm text-slate-700 leading-relaxed">
            <p>If an account exists for <strong>{email}</strong>, a reset link has been sent.</p>
            <p className="mt-2 text-slate-500 text-xs">The link expires in 30 minutes.</p>
            <Link href="/login" className="text-[var(--color-brand-700)] underline text-sm mt-4 inline-block">
              Back to login
            </Link>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-600 mt-1 mb-5">
              Enter your work email and we'll send a reset link.
            </p>
            <form onSubmit={submit} className="space-y-4">
              <input
                required
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              />
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? "Sending…" : "Send reset link"}
              </Button>
            </form>
            <p className="text-xs text-slate-500 mt-4 text-center">
              <Link href="/login" className="underline">Back to login</Link>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
