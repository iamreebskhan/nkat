/** /care-plans — index of patients with care plans. */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Row {
  id: string;
  firstName: string;
  lastName: string;
}

export default function CarePlansIndex() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/patients?limit=200")
      .then((r) => r.json())
      .then((d) => setRows(d.success ? d.data?.rows ?? [] : []))
      .finally(() => setLoading(false));
  }, []);

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
          <CardDescription>{rows.length} patient{rows.length === 1 ? "" : "s"}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <p className="px-4 py-3 text-sm text-slate-500">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-500">No patients yet.</p>
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
        </CardContent>
      </Card>
    </div>
  );
}
