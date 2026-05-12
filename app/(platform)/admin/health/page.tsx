/** /admin/health — platform_admin live health probe. */
"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Livez {
  ok: boolean;
  db: string;
  uptime_ms?: number;
  reason?: string;
}

export default function HealthPage() {
  const [live, setLive] = useState<Livez | null>(null);

  async function probe() {
    const res = await fetch("/api/health/livez", { cache: "no-store" });
    setLive(await res.json());
  }

  useEffect(() => {
    void probe();
    const id = setInterval(probe, 5_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Platform health</h1>
        <p className="text-slate-600 mt-1">Probes /api/health/livez every 5s.</p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Liveness</CardTitle>
          <CardDescription>App up + Postgres reachable within 2s.</CardDescription>
        </CardHeader>
        <CardContent>
          {live === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <div>
              <div
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium ring-1 ring-inset ${
                  live.ok
                    ? "bg-emerald-50 text-emerald-800 ring-emerald-600/20"
                    : "bg-red-50 text-red-800 ring-red-600/30"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${live.ok ? "bg-emerald-500" : "bg-red-500"}`}
                  aria-hidden
                />
                {live.ok ? "Healthy" : "Unhealthy"}
              </div>
              <dl className="grid grid-cols-2 gap-4 mt-4 text-sm">
                <div>
                  <dt className="text-xs text-slate-500 uppercase tracking-wide">Database</dt>
                  <dd className="font-mono">{live.db}</dd>
                </div>
                {live.uptime_ms != null && (
                  <div>
                    <dt className="text-xs text-slate-500 uppercase tracking-wide">DB ping (ms)</dt>
                    <dd className="font-mono tabular">{live.uptime_ms}</dd>
                  </div>
                )}
                {live.reason && (
                  <div className="col-span-2">
                    <dt className="text-xs text-slate-500 uppercase tracking-wide">Reason</dt>
                    <dd className="font-mono text-red-700">{live.reason}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
