/**
 * /settings/billing — current plan + upgrade flow.
 *
 * Source: pallio_complete_vision_v3 §6.8.
 */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface Plan {
  tier: "solo" | "team" | "org" | "enterprise";
  label: string;
  seats: number;
  monthlyUsd: number;
  stripePriceId: string;
}

interface Subscription {
  tier: string;
  seats: number;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

const CATALOG: Plan[] = [
  { tier: "solo", label: "Solo", seats: 1, monthlyUsd: 79, stripePriceId: "" },
  { tier: "team", label: "Team", seats: 5, monthlyUsd: 299, stripePriceId: "" },
  { tier: "org", label: "Organization", seats: 25, monthlyUsd: 999, stripePriceId: "" },
];

export default function BillingPage() {
  const [sub, setSub] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/billing/subscription")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setSub(d.data);
      })
      .catch(() => undefined);
  }, []);

  async function checkout(tier: Plan["tier"]) {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier }),
    });
    const data = await res.json();
    setLoading(false);
    if (!data.success) {
      setError(data.error ?? "Checkout failed.");
      return;
    }
    window.location.href = data.data.url;
  }

  return (
    <div className="px-8 py-8 max-w-4xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Billing</h1>
        <p className="text-slate-600 mt-1">
          {sub
            ? `Currently on ${sub.tier}, ${sub.seats} seat${sub.seats === 1 ? "" : "s"}, status ${sub.status}.`
            : "No active subscription. Pick a plan below."}
        </p>
        {sub?.cancelAtPeriodEnd && (
          <p className="mt-2 text-amber-700 text-sm">
            Subscription cancels at end of current period
            {sub.currentPeriodEnd ? ` (${sub.currentPeriodEnd.slice(0, 10)})` : ""}.
          </p>
        )}
      </header>

      {error && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {CATALOG.map((p) => (
          <Card key={p.tier} className={sub?.tier === p.tier ? "ring-2 ring-[var(--color-brand-600)]" : ""}>
            <CardContent className="p-6">
              <h2 className="font-display text-xl">{p.label}</h2>
              <p className="text-3xl font-bold tabular mt-2">${p.monthlyUsd}<span className="text-sm font-normal text-slate-500">/mo</span></p>
              <p className="text-xs text-slate-500 mt-1">
                {p.seats} seat{p.seats === 1 ? "" : "s"}
              </p>
              <Button
                className="w-full mt-4"
                disabled={loading || sub?.tier === p.tier}
                variant={sub?.tier === p.tier ? "secondary" : "primary"}
                onClick={() => checkout(p.tier)}
              >
                {sub?.tier === p.tier ? "Current plan" : `Switch to ${p.label}`}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="mt-6 text-xs text-slate-500">
        Need enterprise pricing or per-state add-ons? Email <a href="mailto:sales@pallio.io" className="underline">sales@pallio.io</a>.
      </p>
    </div>
  );
}
