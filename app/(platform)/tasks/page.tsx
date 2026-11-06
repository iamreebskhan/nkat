/**
 * /tasks — tasks to the interdisciplinary team (0116; Level-1 doc:40, :54):
 * mine, the ones nobody has taken yet (by discipline), and the ones I gave.
 * A task about a patient is given from the chart, a visit, a call or an
 * escalation alert; one given here is administrative, about no patient.
 */
"use client";

import { useEffect, useState } from "react";

import { TaskForm, TaskList } from "@/components/care/tasks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TaskView } from "@/lib/features/care-coordination/care-coordination.types";
import { DISCIPLINES, DISCIPLINE_LABEL, type Discipline } from "@/lib/features/care-plans/care-plan.types";

const VIEWS = [
  { key: "mine", label: "Assigned to me" },
  { key: "unassigned", label: "Not taken yet" },
  { key: "created", label: "Given by me" },
] as const;
type ViewKey = (typeof VIEWS)[number]["key"];

export default function TasksPage() {
  const [view, setView] = useState<ViewKey>("mine");
  const [status, setStatus] = useState<"open" | "all">("open");
  const [discipline, setDiscipline] = useState<Discipline | "">("");
  const [version, setVersion] = useState(0);
  // Each answer is kept with the question it answers. A failed load used to
  // set the list to empty, so the page said "0 tasks · Nothing assigned to
  // you." over tasks it could not read; and a tab's answer could land under
  // another tab after a quick switch.
  const query = `${view}|${status}|${view === "unassigned" ? discipline : ""}|${version}`;
  const [answer, setAnswer] = useState<
    { query: string; rows: TaskView[]; today: string | null } | { query: string; error: string } | null
  >(null);
  const current = answer?.query === query ? answer : null;
  const rows = current && "rows" in current ? current.rows : null;
  const error = current && "error" in current ? current.error : null;
  // Due days are the practice's; kept from the last answer for the form.
  const [today, setToday] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [canSeePatients, setCanSeePatients] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return;
        setMe(d.data?.userId ?? null);
        const perms: string[] = d.data?.permissions ?? [];
        setCanEdit(perms.includes("patients.edit"));
        setCanSeePatients(perms.includes("patients.view"));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let abandoned = false;
    const asked = query;
    const q = new URLSearchParams({ scope: view, status });
    if (view === "unassigned" && discipline) q.set("discipline", discipline);
    fetch(`/api/tasks?${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (!d.success) {
          setAnswer({ query: asked, error: d.error ?? "The tasks could not be loaded." });
          return;
        }
        setAnswer({ query: asked, rows: d.data.rows, today: d.data.today });
        setToday(d.data.today);
      })
      .catch(() => {
        if (!abandoned) setAnswer({ query: asked, error: "Network error: the tasks could not be loaded." });
      });
    return () => {
      abandoned = true;
    };
  }, [view, status, discipline, version, query]);

  return (
    <div className="px-8 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Tasks</h1>
          <p className="mt-1 text-slate-600">Work for the team between visits: nursing, social work, chaplaincy, administration.</p>
        </div>
        {canEdit && !adding && (
          <Button onClick={() => setAdding(true)} variant="secondary">
            Give an administrative task
          </Button>
        )}
      </header>

      {adding && (
        <div className="mb-4">
          <TaskForm
            today={today}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              setVersion((v) => v + 1);
            }}
          />
          <p className="mt-1 text-xs text-slate-500">A task about a patient is given from their chart, a visit, a call or an alert.</p>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="tablist" aria-label="Which tasks">
          {VIEWS.filter((v) => v.key !== "unassigned" || canSeePatients).map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={view === v.key}
              onClick={() => setView(v.key)}
              className={`rounded px-3 py-1.5 text-sm ${view === v.key ? "bg-slate-200 font-medium" : "text-slate-600 hover:bg-slate-100"}`}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view === "unassigned" && (
          <select
            aria-label="Discipline"
            value={discipline}
            onChange={(e) => setDiscipline(e.target.value as Discipline | "")}
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
          >
            <option value="">Every discipline</option>
            {DISCIPLINES.map((d) => (
              <option key={d} value={d}>
                {DISCIPLINE_LABEL[d]}
              </option>
            ))}
          </select>
        )}
        <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={status === "all"} onChange={(e) => setStatus(e.target.checked ? "all" : "open")} />
          Show done and cancelled
        </label>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {error ? "Tasks not loaded" : rows === null ? "Loading…" : `${rows.length} task${rows.length === 1 ? "" : "s"}`}
          </CardTitle>
          <CardDescription>Overdue first, then by due day.</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}{" "}
              <button type="button" className="underline" onClick={() => setVersion((v) => v + 1)}>
                Try again
              </button>
            </div>
          )}
          {rows !== null && (
            <TaskList
              tasks={rows}
              me={me}
              canEditAny={canEdit}
              showPatient
              onChanged={() => setVersion((v) => v + 1)}
              emptyText={view === "mine" ? "Nothing assigned to you." : view === "unassigned" ? "Nothing waiting to be taken." : "You have given no tasks."}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
