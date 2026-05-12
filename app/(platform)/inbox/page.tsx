/**
 * /inbox — task feed routed to the current user.
 *
 * Aggregates: open visits the user is the clinician for, attestation
 * requests the user has claimed, and pending denials (if billing.denials.view).
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface InboxItem {
  key: string;
  kind: "visit" | "attestation_request" | "denial";
  title: string;
  subtitle: string;
  href: string;
  occurredAt: string;
}

const KIND_LABEL: Record<InboxItem["kind"], string> = {
  visit: "Visit",
  attestation_request: "Attestation",
  denial: "Denial",
};

const KIND_COLORS: Record<InboxItem["kind"], string> = {
  visit: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
  attestation_request: "bg-amber-50 text-amber-800 ring-amber-600/30",
  denial: "bg-red-50 text-red-800 ring-red-600/30",
};

export default function InboxPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/inbox")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          setError(d.error ?? "Failed to load.");
          return;
        }
        setItems(d.data?.rows ?? []);
      })
      .catch(() => setError("Network error."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Inbox</h1>
        <p className="text-slate-600 mt-1">
          Visits to document, attestations you've claimed, denials awaiting decision.
        </p>
      </header>

      {error && (
        <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded mb-4">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{loading ? "Loading…" : `${items.length} item${items.length === 1 ? "" : "s"}`}</CardTitle>
          <CardDescription>Newest first.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!loading && items.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-500">
              Nothing waiting. Schedule a visit, claim an attestation, or wait for a denial.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {items.map((it) => (
                <li key={it.key}>
                  <Link
                    href={it.href}
                    className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <span
                        className={`inline-flex shrink-0 items-center px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset mt-0.5 ${KIND_COLORS[it.kind]}`}
                      >
                        {KIND_LABEL[it.kind]}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{it.title}</p>
                        <p className="text-xs text-slate-500 truncate">{it.subtitle}</p>
                      </div>
                    </div>
                    <time className="text-xs text-slate-500 tabular shrink-0">
                      {it.occurredAt.replace("T", " ").slice(0, 16)}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
