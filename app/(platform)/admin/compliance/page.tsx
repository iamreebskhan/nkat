/** /admin/compliance — live HIPAA / RLS / retention status board. */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export default function CompliancePage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [runAt, setRunAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compliance", { cache: "no-store" });
      const d = await res.json();
      if (!d.success) {
        setError(d.error ?? "Failed.");
        return;
      }
      setChecks(d.data.checks);
      setRunAt(d.data.runAt);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const okCount = checks.filter((c) => c.ok).length;

  return (
    <div className="px-8 py-8">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Compliance</h1>
          <p className="text-slate-600 mt-1">
            Live RLS, retention triggers, pgcrypto helpers, and runtime keys.
            {runAt && <span className="ml-2 text-xs text-slate-400">Run at {runAt.replace("T", " ").slice(0, 19)}Z</span>}
          </p>
        </div>
        <Button onClick={load} disabled={loading} variant="secondary" size="sm">
          {loading ? "Probing…" : "Re-run"}
        </Button>
      </header>

      {error && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded mb-4">
          {error}
        </div>
      )}

      {checks.length > 0 && (
        <Card className="mb-4">
          <CardContent className="p-4">
            <p className="text-sm">
              <strong className={okCount === checks.length ? "text-emerald-700" : "text-amber-700"}>
                {okCount} / {checks.length}
              </strong>{" "}
              checks passing.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Probes</CardTitle>
          <CardDescription>Each runs against the running database + process env.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y divide-slate-100">
            {checks.map((c) => (
              <li key={c.id} className="px-4 py-3 flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{c.label}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{c.detail}</p>
                </div>
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${
                    c.ok
                      ? "bg-emerald-50 text-emerald-800 ring-emerald-600/20"
                      : "bg-amber-50 text-amber-800 ring-amber-600/30"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${c.ok ? "bg-emerald-500" : "bg-amber-500"}`}
                    aria-hidden
                  />
                  {c.ok ? "Pass" : "Action"}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
