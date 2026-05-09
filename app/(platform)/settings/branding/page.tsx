/**
 * /settings/branding — org white-label settings.
 *
 * Source: pallio_complete_vision_v3 §6.1. Org logo, primary color
 * override, custom domain CNAME setup, email "from" identity.
 */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { BrandingView } from "@/lib/features/branding/branding.service";

export default function BrandingPage() {
  const [view, setView] = useState<BrandingView | null>(null);
  const [draft, setDraft] = useState({
    displayName: "",
    logoUrl: "",
    primaryColor: "#0d9488",
    customDomain: "",
    emailFromName: "",
    emailFromAddress: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings/branding")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          setError(d.error ?? "Failed.");
          return;
        }
        const v = d.data as BrandingView;
        setView(v);
        setDraft({
          displayName: v.displayName ?? "",
          logoUrl: v.logoUrl ?? "",
          primaryColor: v.primaryColor ?? "#0d9488",
          customDomain: v.customDomain ?? "",
          emailFromName: v.emailFromName ?? "",
          emailFromAddress: v.emailFromAddress ?? "",
        });
      });
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/settings/branding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: draft.displayName || null,
        logoUrl: draft.logoUrl || null,
        primaryColor: draft.primaryColor || null,
        customDomain: draft.customDomain.trim().toLowerCase() || null,
        emailFromName: draft.emailFromName || null,
        emailFromAddress: draft.emailFromAddress || null,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!data.success) {
      setError(data.error ?? "Save failed.");
      return;
    }
    setView(data.data);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="px-8 py-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Branding</h1>
        <p className="text-slate-600 mt-1">
          Logo, primary color, custom domain, and email "from" identity.
        </p>
      </header>

      <Card>
        <CardContent className="p-6">
          <form onSubmit={save} className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Display name">
                <input
                  value={draft.displayName}
                  onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Primary color">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={draft.primaryColor}
                    onChange={(e) => setDraft({ ...draft, primaryColor: e.target.value })}
                    className="h-10 w-14 border border-slate-300 rounded cursor-pointer"
                  />
                  <input
                    value={draft.primaryColor}
                    onChange={(e) => setDraft({ ...draft, primaryColor: e.target.value })}
                    pattern="#[0-9A-Fa-f]{6}"
                    className="flex-1 border border-slate-300 rounded px-3 py-2 text-sm font-mono"
                  />
                </div>
              </Field>
            </div>
            <Field label="Logo URL">
              <input
                value={draft.logoUrl}
                onChange={(e) => setDraft({ ...draft, logoUrl: e.target.value })}
                placeholder="https://…"
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Custom domain">
              <input
                value={draft.customDomain}
                onChange={(e) => setDraft({ ...draft, customDomain: e.target.value })}
                placeholder="rules.example.com"
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono"
              />
              {view?.customDomain && (
                <p className="text-xs text-slate-500 mt-1">
                  CNAME status: <strong>{view.domainStatus}</strong>. Point a CNAME
                  record from <code>{view.customDomain}</code> to <code>app.pallio.io</code>.
                </p>
              )}
            </Field>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Email from name">
                <input
                  value={draft.emailFromName}
                  onChange={(e) => setDraft({ ...draft, emailFromName: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Email from address">
                <input
                  type="email"
                  value={draft.emailFromAddress}
                  onChange={(e) => setDraft({ ...draft, emailFromAddress: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
                />
              </Field>
            </div>

            {error && (
              <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
                {error}
              </div>
            )}
            {saved && (
              <div className="text-sm text-emerald-700 bg-emerald-50 px-3 py-2 rounded">
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
