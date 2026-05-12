/**
 * /payers — knowledge base hub.
 *
 * Source: pallio_complete_vision_v3 §6.6.
 *
 * Lists every payer the org has rules for, with quick links into:
 *   - Attestations queue (analyst rule confirmations)
 *   - Per-payer rule browse (lands in Phase 11 if needed)
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PayerOption {
  id: string;
  name: string;
  type: string;
  states: string[];
}

export default function PayersPage() {
  const [payers, setPayers] = useState<PayerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/billing/payers")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          setError(d.error ?? "Failed to load.");
          return;
        }
        const list = d.data?.payers ?? d.data?.rows ?? d.data;
        setPayers(Array.isArray(list) ? list : []);
      })
      .catch(() => setError("Network error."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Payers</h1>
        <p className="text-slate-600 mt-1">
          Knowledge base — every payer your org has rules for.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <Link href="/payers/attestations" className="block">
          <Card className="hover:ring-2 hover:ring-[var(--color-brand-600)] transition">
            <CardHeader>
              <CardTitle>Attestations queue →</CardTitle>
              <CardDescription>
                Analyst confirmations from payer phone calls. 90-day expiry.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/settings/rulebook" className="block">
          <Card className="hover:ring-2 hover:ring-[var(--color-brand-600)] transition">
            <CardHeader>
              <CardTitle>Org rulebook →</CardTitle>
              <CardDescription>
                Your saved single source of truth. Browse, edit, override.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active payers ({payers.length})</CardTitle>
          <CardDescription>States served pulled from the global payer table.</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
              {error}
            </div>
          )}
          {loading && <p className="text-sm text-slate-500">Loading…</p>}
          {!loading && payers.length === 0 && !error && (
            <p className="text-sm text-slate-500">No payers seeded yet.</p>
          )}
          {payers.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {payers.map((p) => (
                <li key={p.id} className="py-2 flex items-center justify-between text-sm">
                  <div>
                    <span className="font-medium">{p.name}</span>
                    <span className="ml-2 text-xs text-slate-500 uppercase tracking-wide">{p.type.replace(/_/g, " ")}</span>
                  </div>
                  <span className="text-xs text-slate-500 font-mono">{p.states.join(" · ") || "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
