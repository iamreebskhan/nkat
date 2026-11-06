"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { QrCodeImage } from "@/components/auth/qr-code-image";
import { PasswordInput } from "@/components/forms/password-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface EnrolSetup {
  secretBase32: string;
  otpauthUri: string;
}

const inputClass =
  "w-full h-10 px-3 rounded-md border border-slate-300 bg-white text-base focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 read-only:bg-slate-50 read-only:text-slate-600";

const IDLE_NOTICE = "You were signed out because nothing was done for a while. Sign in again to go on.";

const noChanges = () => () => {};
/**
 * Whether the idle limit brought this person here (0121). Read from the
 * address, not useSearchParams, so the page stays static; false on the server
 * and the first render, so hydration matches.
 */
const useSignedOutIdle = () =>
  useSyncExternalStore(
    noChanges,
    () => new URLSearchParams(window.location.search).get("reason") === "idle",
    () => false,
  );

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  /**
   * 'creds' | 'mfa' — flips when the server returns mfa_required.
   * 'enrol' | 'codes' — a role that requires a second factor and has none
   * sets one up here, then sees its recovery codes once (0121).
   */
  const [stage, setStage] = useState<"creds" | "mfa" | "enrol" | "codes">("creds");
  const [enrolToken, setEnrolToken] = useState<string | null>(null);
  const [enrolSetup, setEnrolSetup] = useState<EnrolSetup | null>(null);
  const [enrolCode, setEnrolCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const signedOutIdle = useSignedOutIdle();

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
        // The role requires a second factor that is not set up yet (0121).
        if (res.status === 403 && typeof data.data?.enrolToken === "string") {
          await startEnrol(data.data.enrolToken, data.error);
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

  async function startEnrol(token: string, why: string | null) {
    setEnrolToken(token);
    setNotice(why);
    const res = await fetch("/api/auth/mfa/enrol", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const d = await res.json().catch(() => null);
    if (!d?.success) {
      setError(d?.error ?? "The setup could not start. Sign in again.");
      return;
    }
    setEnrolSetup(d.data as EnrolSetup);
    setStage("enrol");
  }

  async function confirmEnrol(e: React.FormEvent) {
    e.preventDefault();
    if (!enrolToken) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/mfa/enrol/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: enrolToken, code: enrolCode }),
      });
      const d = await res.json();
      if (!d.success) {
        setError(d.error ?? "That code didn't match.");
        return;
      }
      setRecoveryCodes(d.data.recoveryCodes as string[]);
      setNotice(null);
      setStage("codes");
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (stage === "enrol" && enrolSetup) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="font-display">Set up two-step sign-in</CardTitle>
          <CardDescription>{notice}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={confirmEnrol} className="space-y-4" noValidate>
            <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-700">
              <li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password).</li>
              <li>
                Scan this code with the app:
                <span className="block mt-2">
                  <QrCodeImage text={enrolSetup.otpauthUri} label="QR code to add Pallio to your authenticator app" />
                </span>
                <span className="block text-xs text-slate-500 mt-2">Can&rsquo;t scan? Add an account with this key instead:</span>
                <code className="block font-mono text-sm bg-slate-100 px-3 py-2 rounded mt-1 break-all">
                  {enrolSetup.secretBase32}
                </code>
                <span className="block text-xs text-slate-500 mt-1">
                  On the phone that has the app, you can open{" "}
                  <a href={enrolSetup.otpauthUri} className="underline">this link</a> instead.
                </span>
              </li>
              <li>Enter the 6-digit code the app shows for Pallio.</li>
            </ol>
            <div className="space-y-1.5">
              <label htmlFor="enrolCode" className="text-sm font-medium text-slate-700">
                6-digit code
                <span className="text-red-600 ml-0.5" aria-hidden>*</span>
              </label>
              <input
                id="enrolCode"
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="one-time-code"
                required
                autoFocus
                value={enrolCode}
                onChange={(e) => setEnrolCode(e.target.value.trim())}
                placeholder="123456"
                className={`${inputClass} font-mono tracking-[0.3em] text-center`}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
            <Button type="submit" loading={submitting} className="w-full" disabled={enrolCode.length !== 6}>
              Confirm and sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  if (stage === "codes") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="font-display">Save your recovery codes</CardTitle>
          <CardDescription>
            Each works once. They are your way in if you lose the phone with the authenticator app. This is the only
            time they are shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm mb-4">
            {recoveryCodes.map((c) => (
              <li key={c} className="bg-white border border-slate-200 rounded px-3 py-2 tabular tracking-wider">
                {c}
              </li>
            ))}
          </ul>
          <Button
            className="w-full"
            onClick={() => {
              router.push("/");
              router.refresh();
            }}
          >
            I&rsquo;ve saved them — continue
          </Button>
        </CardContent>
      </Card>
    );
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
        {(notice || signedOutIdle) && (
          <p role="status" className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4">
            {notice ?? IDLE_NOTICE}
          </p>
        )}
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
              className={inputClass}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium text-slate-700">
              Password
              <span className="text-red-600 ml-0.5" aria-hidden>*</span>
              <span className="sr-only">required</span>
            </label>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="current-password"
              required
              readOnly={stage === "mfa"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
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
                className={`${inputClass} font-mono tracking-[0.3em] text-center`}
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
