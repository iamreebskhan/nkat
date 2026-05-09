/**
 * /settings/security — MFA enrollment + recovery codes.
 */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface Setup {
  secretBase32: string;
  otpauthUri: string;
}

export default function SecurityPage() {
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/mfa/status")
      .then((r) => r.json())
      .then((d) => setEnrolled(Boolean(d.success && d.data?.enrolled)))
      .catch(() => setEnrolled(false));
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
    setEnrolled(true);
  }

  async function disable() {
    if (!confirm("Disable MFA on this account? Recovery codes will be wiped.")) return;
    await fetch("/api/auth/mfa/disable", { method: "POST" });
    setEnrolled(false);
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
              Each code works once and only once. They're your way back in if you lose your phone.
            </p>
            <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
              {recoveryCodes.map((c) => (
                <li key={c} className="bg-white border border-slate-200 rounded px-3 py-2 tabular tracking-wider">
                  {c}
                </li>
              ))}
            </ul>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => setRecoveryCodes(null)}>
              I've saved them
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-6">
          {enrolled === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : enrolled ? (
            <div>
              <p className="text-sm text-slate-700 mb-3">
                <strong className="text-emerald-700">MFA is on</strong> for this account.
                You'll be asked for a 6-digit code on every login.
              </p>
              <Button variant="danger" size="sm" onClick={disable}>
                Disable MFA
              </Button>
            </div>
          ) : setup ? (
            <div>
              <p className="text-sm text-slate-700 mb-3">
                Add this secret to your authenticator app, then enter the 6-digit code it shows:
              </p>
              <code className="block font-mono text-sm bg-slate-100 px-3 py-2 rounded mb-2 break-all">
                {setup.secretBase32}
              </code>
              <p className="text-xs text-slate-500 mb-4">
                Or scan this URI as a QR code:{" "}
                <span className="font-mono break-all">{setup.otpauthUri}</span>
              </p>
              <form onSubmit={verify} className="flex gap-2 items-end">
                <label className="block">
                  <span className="block text-xs font-medium text-slate-700 mb-1">6-digit code</span>
                  <input
                    required
                    pattern="\d{6}"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-32 border border-slate-300 rounded px-3 py-2 text-sm font-mono tracking-[0.3em] text-center"
                  />
                </label>
                <Button type="submit" disabled={busy || code.length !== 6}>
                  {busy ? "Verifying…" : "Verify"}
                </Button>
              </form>
            </div>
          ) : (
            <div>
              <p className="text-sm text-slate-700 mb-4">
                MFA is off. Strongly recommended for any account with{" "}
                <code>team.permissions</code> or <code>billing.*</code>.
              </p>
              <Button onClick={startSetup} disabled={busy}>
                {busy ? "…" : "Enable MFA"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
