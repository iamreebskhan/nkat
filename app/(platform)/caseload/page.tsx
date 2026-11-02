/**
 * /caseload — my caseload (0116; Level-1 doc:48, :51): the patients under
 * care whose care team I am on, the ones that need something first: an
 * escalation alert, monitoring overdue or due, a plan review due. Days are the
 * practice's.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CARE_PROGRAM_SHORT } from "@/lib/features/care-coordination/care-coordination.types";
import type { CareTeamSeat, CaseloadRow } from "@/lib/features/care-coordination/caseload.service";
import { MONITORING_HOW_LABEL } from "@/lib/features/care-plans/care-plan.types";
import { PATIENT_ACUITY_LABEL } from "@/lib/features/patients/patient.types";

const SEAT_LABEL: Record<CareTeamSeat, string> = {
  primary_np: "Primary NP",
  rn: "RN",
  social_worker: "Social worker",
  chaplain: "Chaplain",
  billing_agent: "Billing",
};

export default function CaseloadPage() {
  const [data, setData] = useState<{ today: string; rows: CaseloadRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    fetch("/api/caseload")
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (d.success) setData(d.data);
        else setError(d.error ?? "Could not load your caseload.");
      })
      .catch(() => {
        if (!abandoned) setError("Network error.");
      });
    return () => {
      abandoned = true;
    };
  }, []);

  const rows = data?.rows ?? [];
  const needing = rows.filter((r) => r.openAlerts > 0 || r.due.length > 0 || r.reviewDue).length;
  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">My caseload</h1>
        <p className="mt-1 text-slate-600">
          The patients whose care team you are on.{" "}
          {data && (needing > 0 ? `${needing} need something now.` : "Nothing is due.")}
        </p>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{data === null ? "Loading…" : `${rows.length} patient${rows.length === 1 ? "" : "s"}`}</CardTitle>
          <CardDescription>Alerts first, then what is overdue or due, then by acuity.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data !== null && rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-500">
              You are on no patient&rsquo;s care team. A chart&rsquo;s Overview names its care team.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs uppercase text-slate-500">
                    <th className="px-4 py-2 font-medium">Patient</th>
                    <th className="px-4 py-2 font-medium">Acuity</th>
                    <th className="px-4 py-2 font-medium">Needs</th>
                    <th className="px-4 py-2 font-medium">Last visit</th>
                    <th className="px-4 py-2 font-medium">Last call</th>
                    <th className="px-4 py-2 font-medium">Next visit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.patientId} className="align-top">
                      <td className="px-4 py-2">
                        <Link href={`/patients/${r.patientId}`} className="font-medium text-[var(--color-brand-700)] hover:underline">
                          {r.name}
                        </Link>
                        <p className="text-xs text-slate-500">
                          {r.seats.map((s) => SEAT_LABEL[s]).join(", ")}
                          {r.programs.length > 0 && ` · ${r.programs.map((p) => CARE_PROGRAM_SHORT[p]).join(", ")}`}
                        </p>
                      </td>
                      <td className="px-4 py-2">{r.acuity ? PATIENT_ACUITY_LABEL[r.acuity] : "—"}</td>
                      <td className="px-4 py-2">
                        <ul className="space-y-0.5">
                          {r.openAlerts > 0 && (
                            <li>
                              <Link href={`/patients/${r.patientId}`} className="font-medium text-red-700 hover:underline">
                                {r.openAlerts} escalation alert{r.openAlerts === 1 ? "" : "s"}
                              </Link>
                            </li>
                          )}
                          {r.due.map((d) => (
                            <li key={d.item}>
                              <Link
                                href={`/patients/${r.patientId}?tab=calls`}
                                className={d.overdue ? "text-red-700 hover:underline" : "text-amber-800 hover:underline"}
                              >
                                {d.item}, {MONITORING_HOW_LABEL[d.how]} — {d.overdue ? `overdue since ${d.dueOn}` : "due today"}
                              </Link>
                            </li>
                          ))}
                          {r.reviewDue && (
                            <li>
                              <Link href={`/patients/${r.patientId}/care-plan`} className="text-amber-800 hover:underline">
                                Care plan review due ({r.reviewOn})
                              </Link>
                            </li>
                          )}
                          {r.openTasks > 0 && (
                            <li>
                              <Link href={`/patients/${r.patientId}?tab=tasks`} className="text-slate-700 hover:underline">
                                {r.openTasks} open task{r.openTasks === 1 ? "" : "s"}
                              </Link>
                            </li>
                          )}
                          {r.openAlerts === 0 && r.due.length === 0 && !r.reviewDue && r.openTasks === 0 && (
                            <li className="text-slate-400">Nothing</li>
                          )}
                        </ul>
                      </td>
                      <td className="px-4 py-2 tabular text-slate-700">{r.lastVisitOn ?? "—"}</td>
                      <td className="px-4 py-2 tabular text-slate-700">{r.lastCallOn ?? "—"}</td>
                      <td className="px-4 py-2 tabular text-slate-700">{r.nextVisitOn ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
