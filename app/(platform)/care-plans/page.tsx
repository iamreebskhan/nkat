/**
 * /care-plans — index of patients with care plans.
 *
 * Every patient under care, a page of 200 at a time. A failed load says so: it
 * used to read "No patients yet." And the list stopped at the first 200 with
 * nothing to say there were more.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Row {
  id: string;
  firstName: string;
  lastName: string;
}

/** One request's worth: GET /api/patients's limit. */
const PAGE = 200;

export default function CarePlansIndex() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // How many have been asked for so far; "Show more" asks for the next page.
  const [offset, setOffset] = useState(0);
  // Bumped by "Try again": the page that failed is asked for again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/patients?limit=${PAGE}&offset=${offset}`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (!d.success) {
          setError(d.error ?? "The patients could not be loaded.");
          return;
        }
        setError(null);
        setRows((prev) => (offset === 0 ? (d.data?.rows ?? []) : [...prev, ...(d.data?.rows ?? [])]));
        setTotal(typeof d.data?.total === "number" ? d.data.total : null);
      })
      .catch(() => {
        if (!abandoned) setError("Network error: the patients could not be loaded.");
      })
      .finally(() => {
        if (!abandoned) setLoading(false);
      });
    return () => {
      abandoned = true;
    };
  }, [offset, attempt]);

  const more = total !== null && rows.length < total;

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Care plans</h1>
        <p className="text-slate-600 mt-1">
          Open a patient to view or edit their living care plan document.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Patients</CardTitle>
          <CardDescription>
            {error && rows.length === 0
              ? "Not loaded"
              : total === null
                ? "…"
                : more
                  ? `${rows.length} of ${total} patients under care`
                  : `${total} patient${total === 1 ? "" : "s"} under care`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <p role="alert" className="px-4 py-3 text-sm text-red-700">
              {error}{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setError(null);
                  setLoading(true);
                  setAttempt((a) => a + 1);
                }}
              >
                Try again
              </button>
            </p>
          )}
          {loading && rows.length === 0 && !error ? (
            <p className="px-4 py-3 text-sm text-slate-500">Loading…</p>
          ) : !error && rows.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-500">No patients under care.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {rows.map((p) => (
                <li key={p.id} className="px-4 py-2 hover:bg-slate-50">
                  <Link
                    href={`/patients/${p.id}/care-plan`}
                    className="text-sm flex items-center justify-between"
                  >
                    <span>{p.firstName} {p.lastName}</span>
                    <span className="text-xs text-[var(--color-brand-700)]">Open →</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {more && !error && (
            <div className="px-4 py-3 border-t border-slate-100">
              <Button
                variant="secondary"
                size="sm"
                disabled={loading}
                onClick={() => {
                  setLoading(true);
                  setOffset(rows.length);
                }}
              >
                {loading ? "Loading…" : `Show ${Math.min(PAGE, total! - rows.length)} more`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
