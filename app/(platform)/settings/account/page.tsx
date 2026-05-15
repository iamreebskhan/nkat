/**
 * /settings/account — your profile + password rotation.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Me {
  email: string;
  fullName: string | null;
  role: string;
  lastLoginAt: string | null;
  permissions: string[];
}

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [cur, setCur] = useState("");
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => {
      if (d.success) {
        setMe(d.data);
        setName(d.data.fullName ?? "");
      }
    });
  }, []);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setSavingName(true);
    setNameMsg(null);
    const res = await fetch("/api/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName: name }),
    });
    const d = await res.json();
    setSavingName(false);
    setNameMsg(d.success ? { ok: true, text: "Saved." } : { ok: false, text: d.error ?? "Failed." });
    if (d.success && me) setMe({ ...me, fullName: name });
  }

  async function savePw(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    if (pw1 !== pw2) {
      setPwMsg({ ok: false, text: "New passwords don't match." });
      return;
    }
    setSavingPw(true);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: cur, newPassword: pw1 }),
    });
    const d = await res.json();
    setSavingPw(false);
    if (d.success) {
      setPwMsg({ ok: true, text: "Password rotated. Future logins use the new password." });
      setCur(""); setPw1(""); setPw2("");
    } else {
      setPwMsg({ ok: false, text: d.error ?? "Failed." });
    }
  }

  if (!me) {
    return <div className="px-8 py-8 text-sm text-slate-500">Loading…</div>;
  }

  return (
    <div className="px-8 py-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Account</h1>
        <p className="text-slate-600 mt-1">
          Your profile, password, and security. <Link href="/settings/security" className="text-[var(--color-brand-700)] underline">MFA & recovery codes →</Link>
        </p>
      </header>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>What teammates see in audit logs + invites you've sent.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveName} className="space-y-4">
            <Field label="Full name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Email">
              <input value={me.email} readOnly disabled className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-slate-50 text-slate-500" />
              <p className="text-xs text-slate-500 mt-1">Email changes need org admin approval — not yet self-serve.</p>
            </Field>
            <Field label="Role">
              <input value={me.role.replace("_", " ")} readOnly disabled className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-slate-50 text-slate-500" />
            </Field>
            <Field label="Permissions">
              <p className="text-xs text-slate-600">{me.permissions.length} grants — managed by org admin in <Link href="/team" className="underline">/team</Link>.</p>
            </Field>
            {me.lastLoginAt && (
              <Field label="Last login">
                <p className="text-xs text-slate-600 tabular">{me.lastLoginAt.replace("T", " ").slice(0, 19)}Z</p>
              </Field>
            )}
            {nameMsg && (
              <div role="alert" className={`text-sm px-3 py-2 rounded ${nameMsg.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                {nameMsg.text}
              </div>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={savingName || name === (me.fullName ?? "")}>
                {savingName ? "Saving…" : "Save profile"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>You'll stay signed in on this device; other sessions are unaffected.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={savePw} className="space-y-4">
            <Field label="Current password">
              <input required type="password" value={cur} onChange={(e) => setCur(e.target.value)} className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono" />
            </Field>
            <Field label="New password (min 12 chars)">
              <input required type="password" minLength={12} value={pw1} onChange={(e) => setPw1(e.target.value)} className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono" />
            </Field>
            <Field label="Confirm new password">
              <input required type="password" minLength={12} value={pw2} onChange={(e) => setPw2(e.target.value)} className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono" />
            </Field>
            {pwMsg && (
              <div role="alert" className={`text-sm px-3 py-2 rounded ${pwMsg.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                {pwMsg.text}
              </div>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={savingPw || !cur || !pw1 || !pw2}>
                {savingPw ? "Rotating…" : "Rotate password"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-700 mb-1">{label}</span>
      {children}
    </label>
  );
}
