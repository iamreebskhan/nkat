/**
 * /settings/security — MFA enrollment + recovery codes, and for admins the
 * practice's session rules (0121): sign-out after inactivity, and who must
 * use a second factor.
 */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface Setup {
  secretBase32: string;
  otpauthUri: string;
}

interface MfaStatus {
  enrolled: boolean;
  required: boolean;
  pending: boolean;
}

interface Rules {
  idleTimeoutMinutes: number;
  mfaPolicy: "admins_and_billers" | "everyone";
}

export default function SecurityPage() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** This session owed its second factor and has just set it up. */
  const [justMet, setJustMet] = useState(false);

  useEffect(() => {
    fetch("/api/auth/mfa/status")
      .then((r) => r.json())
      .then((d) =>
        setStatus(
          d.success
            ? { enrolled: Boolean(d.data?.enrolled), required: Boolean(d.data?.required), pending: Boolean(d.data?.pending) }
            : { enrolled: false, required: false, pending: false },
        ),
      )
      .catch(() => setStatus({ enrolled: false, required: false, pending: false }));
  }, []);

  async function startSetup() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/mfa/setup", { method: "POST" });
    const d = await res.json();
    setBusy(false);
    if (!d.success) {
      setError(d.error ?? "Failed to start setup.");
      return;
    }
    setSetup(d.data);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/mfa/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const d = await res.json();
    setBusy(false);
    if (!d.success) {
      setError(d.error ?? "Code didn't match.");
      return;
    }
    setRecoveryCodes(d.data.recoveryCodes);
    setJustMet(Boolean(status?.pending));
    setStatus((s) => ({ enrolled: true, required: s?.required ?? false, pending: false }));
    setSetup(null);
    setCode("");
  }

  async function disable() {
    if (!confirm("Disable MFA on this account? Recovery codes will be wiped.")) return;
    setError(null);
    const res = await fetch("/api/auth/mfa/disable", { method: "POST" });
    const d = await res.json().catch(() => null);
    if (!d?.success) {
      setError(d?.error ?? "MFA was not turned off.");
      return;
    }
    setStatus((s) => ({ enrolled: false, required: s?.required ?? false, pending: false }));
    setSetup(null);
    setRecoveryCodes(null);
  }

  return (
    <div className="px-8 py-8 max-w-2xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Security</h1>
        <p className="text-slate-600 mt-1">
          Two-factor authentication via authenticator app (Google Authenticator, Authy, 1Password).
        </p>
      </header>

      {status?.pending && (
        <div role="alert" className="text-sm text-amber-900 bg-amber-50 border border-amber-200 px-3 py-2 rounded mb-4">
          Your role signs in with a second factor. Set it up below to go on using Pallio.
        </div>
      )}

      {error && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded mb-4">
          {error}
        </div>
      )}

      {recoveryCodes && (
        <Card className="mb-4 border-emerald-300 bg-emerald-50/40">
          <CardContent className="p-5">
            <p className="text-sm font-bold text-emerald-900 mb-2">
              Save these recovery codes
            </p>
            <p className="text-xs text-slate-700 mb-3">
              Each code works once and only once. They&rsquo;re your way back in if you lose your phone.
            </p>
            <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
              {recoveryCodes.map((c) => (
                <li key={c} className="bg-white border border-slate-200 rounded px-3 py-2 tabular tracking-wider">
                  {c}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setRecoveryCodes(null)}>
                I&rsquo;ve saved them
              </Button>
              {justMet && (
                <Button size="sm" onClick={() => (window.location.href = "/")}>
                  Continue to Pallio
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-6">
          {status === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : setup ? (
            <div>
              <p className="text-sm text-slate-700 mb-3">
                Add this secret to your authenticator app, then enter the 6-digit code it shows:
              </p>
              <code className="block font-mono text-sm bg-slate-100 px-3 py-2 rounded mb-2 break-all">
                {setup.secretBase32}
              </code>
              <p className="text-xs text-slate-500 mb-4">
                Or open this link on the phone that has the app:{" "}
                <a href={setup.otpauthUri} className="font-mono break-all underline">
                  {setup.otpauthUri}
                </a>
              </p>
              <form onSubmit={verify} className="flex gap-2 items-end">
                <label className="block">
                  <span className="block text-xs font-medium text-slate-700 mb-1">6-digit code</span>
                  <input
                    required
                    pattern="\d{6}"
                    maxLength={6}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-32 border border-slate-300 rounded px-3 py-2 text-sm font-mono tracking-[0.3em] text-center"
                  />
                </label>
                <Button type="submit" disabled={busy || code.length !== 6}>
                  {busy ? "Verifying…" : "Verify"}
                </Button>
              </form>
              {status.enrolled && (
                <p className="text-xs text-slate-500 mt-3">
                  Your current authenticator keeps working until this one is confirmed.
                </p>
              )}
            </div>
          ) : status.enrolled ? (
            <div>
              <p className="text-sm text-slate-700 mb-3">
                <strong className="text-emerald-700">MFA is on</strong> for this account.
                You&rsquo;ll be asked for a 6-digit code on every login.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={startSetup} disabled={busy}>
                  Move to a new phone
                </Button>
                {status.required ? (
                  <p className="text-xs text-slate-500 self-center">
                    Required for your role, so it can&rsquo;t be turned off.
                  </p>
                ) : (
                  <Button variant="danger" size="sm" onClick={disable}>
                    Disable MFA
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div>
              <p className="text-sm text-slate-700 mb-4">
                {status.required
                  ? "MFA is off, and your role requires it."
                  : "MFA is off. Strongly recommended for every account that can open patient records."}
              </p>
              <Button onClick={startSetup} disabled={busy}>
                {busy ? "…" : "Enable MFA"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <PracticeRules />
    </div>
  );
}

/**
 * The practice's session rules (0121), for those who can see settings; only
 * settings.org may change them. Hidden for everyone else.
 */
function PracticeRules() {
  const [rules, setRules] = useState<Rules | null>(null);
  const [minutes, setMinutes] = useState("30");
  const [policy, setPolicy] = useState<Rules["mfaPolicy"]>("admins_and_billers");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/settings/security")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return;
        const v = d.data as Rules;
        setRules(v);
        setMinutes(String(v.idleTimeoutMinutes));
        setPolicy(v.mfaPolicy);
      })
      .catch(() => {});
  }, []);

  if (!rules) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setDone(false);
    try {
      const res = await fetch("/api/settings/security", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idleTimeoutMinutes: Number(minutes), mfaPolicy: policy }),
      });
      const d = await res.json();
      if (!d.success) {
        setError(d.error ?? "Save failed.");
        return;
      }
      setRules(d.data as Rules);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      setError("Network error — not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardContent className="p-6">
        <h2 className="font-display text-lg">Practice sign-in rules</h2>
        <p className="text-sm text-slate-600 mt-1 mb-4">
          For everyone in the practice. Changes reach people already signed in within a minute.
        </p>
        <form onSubmit={save} className="space-y-4">
          <label className="block">
            <span className="block text-xs font-medium text-slate-700 mb-1">Sign out after this many minutes with nothing done</span>
            <input
              type="number"
              min={5}
              max={120}
              required
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              className="w-32 border border-slate-300 rounded px-3 py-2 text-sm tabular"
            />
            <span className="block text-xs text-slate-500 mt-1">
              5 to 120; 30 unless you change it. A warning comes first, with a button to stay signed in.
            </span>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-700 mb-1">Who signs in with a second factor</span>
            <select
              value={policy}
              onChange={(e) => setPolicy(e.target.value as Rules["mfaPolicy"])}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
            >
              <option value="admins_and_billers">Admins and billers (anyone who can change access, settings or claims)</option>
              <option value="everyone">Everyone</option>
            </select>
          </label>
          {error && (
            <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
              {error}
            </div>
          )}
          {done && (
            <div role="status" className="text-sm text-emerald-700 bg-emerald-50 px-3 py-2 rounded">
              Saved.
            </div>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
