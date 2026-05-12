/** /admin/settings — platform_admin: system_setting upsert + rate_limit_override view. */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface CatalogEntry { key: string; description: string }
interface SettingRow { key: string; value: unknown; note: string | null; updatedAt: string }
interface RlOverride {
  orgId: string;
  scope: string;
  limit: number;
  refillPerSec: number;
  reason: string | null;
  expiresAt: string | null;
}

export default function PlatformSettingsPage() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [overrides, setOverrides] = useState<RlOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; value: string; note: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/platform-settings");
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Failed.");
        return;
      }
      setCatalog(d.data.catalog ?? []);
      setSettings(d.data.settings ?? []);
      setOverrides(d.data.rateLimitOverrides ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function save() {
    if (!editing) return;
    setSaving(true);
    let parsed: unknown;
    try { parsed = JSON.parse(editing.value); }
    catch { setError(`Value for ${editing.key} must be valid JSON.`); setSaving(false); return; }
    const r = await fetch("/api/admin/platform-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: editing.key, value: parsed, note: editing.note || null }),
    });
    const d = await r.json();
    setSaving(false);
    if (!d.success) { setError(d.error ?? "Save failed."); return; }
    setEditing(null);
    await load();
  }

  const settingByKey = new Map(settings.map((s) => [s.key, s]));

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Platform settings</h1>
        <p className="text-slate-600 mt-1">
          Cross-tenant configuration. Persisted in <code className="font-mono">system_setting</code>.
        </p>
      </header>

      {error && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded mb-4">
          {error}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>System settings</CardTitle>
          <CardDescription>{loading ? "Loading…" : `${settings.length} configured · ${catalog.length} catalog keys`}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-semibold px-4 py-2.5">Key</th>
                <th className="text-left font-semibold px-4 py-2.5">Value</th>
                <th className="text-left font-semibold px-4 py-2.5">Updated</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {catalog.map((c) => {
                const cur = settingByKey.get(c.key);
                return (
                  <tr key={c.key} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-mono text-xs">
                      <div>{c.key}</div>
                      <div className="text-slate-500 text-xs">{c.description}</div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs max-w-md truncate">
                      {cur ? JSON.stringify(cur.value) : <span className="text-slate-400">(not set)</span>}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500 tabular">
                      {cur?.updatedAt.replace("T", " ").slice(0, 16) ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          setEditing({
                            key: c.key,
                            value: cur ? JSON.stringify(cur.value, null, 2) : '""',
                            note: cur?.note ?? "",
                          })
                        }
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {editing && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="font-mono text-sm">{editing.key}</CardTitle>
            <CardDescription>Value must be valid JSON.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <textarea
              value={editing.value}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              rows={6}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono"
            />
            <input
              value={editing.note}
              onChange={(e) => setEditing({ ...editing, note: e.target.value })}
              placeholder="Optional note (audit trail)"
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Rate-limit overrides</CardTitle>
          <CardDescription>Per-org per-scope ceilings from <code className="font-mono">rate_limit_override</code>.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {overrides.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-500">No overrides — every org runs on default ceilings.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-semibold px-4 py-2.5">Org</th>
                  <th className="text-left font-semibold px-4 py-2.5">Scope</th>
                  <th className="text-right font-semibold px-4 py-2.5">Limit</th>
                  <th className="text-right font-semibold px-4 py-2.5">Refill/s</th>
                  <th className="text-left font-semibold px-4 py-2.5">Expires</th>
                  <th className="text-left font-semibold px-4 py-2.5">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overrides.map((o) => (
                  <tr key={`${o.orgId}-${o.scope}`}>
                    <td className="px-4 py-2 font-mono text-xs">{o.orgId.slice(0, 8)}</td>
                    <td className="px-4 py-2 text-xs">{o.scope}</td>
                    <td className="px-4 py-2 text-right tabular">{o.limit}</td>
                    <td className="px-4 py-2 text-right tabular">{o.refillPerSec}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{o.expiresAt?.slice(0, 16) ?? "never"}</td>
                    <td className="px-4 py-2 text-xs text-slate-500 max-w-md truncate">{o.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
