/**
 * /admin/cheatsheets — operator review queue for cheat-sheet templates.
 *
 * Phase G: until a (payer, state) combo is "Published" here, org-side
 * users don't see it in any browse list. Hamda reviews + clicks publish
 * to make a sheet available across all orgs.
 */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Template {
  id: string;
  payerId: string;
  payerName: string;
  state: string;
  status: "pending_review" | "published" | "withdrawn";
  ruleCountAtCreation: number;
  ruleCountNow: number;
  notes: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export default function CheatsheetTemplatesPage() {
  const [rows, setRows] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    const r = await fetch("/api/admin/cheatsheet-templates");
    const data = await r.json();
    if (data.success) setRows(data.data.rows);
    else setError(data.error ?? "Failed to load.");
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function rescan() {
    setBusy("scan");
    await fetch("/api/admin/cheatsheet-templates", { method: "POST" });
    await refresh();
    setBusy(null);
  }

  async function publish(id: string) {
    setBusy(id);
    await fetch(`/api/admin/cheatsheet-templates/${id}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await refresh();
    setBusy(null);
  }

  async function withdraw(id: string) {
    if (!confirm("Withdraw this cheat sheet from all orgs?")) return;
    setBusy(id);
    await fetch(`/api/admin/cheatsheet-templates/${id}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await refresh();
    setBusy(null);
  }

  const pending = rows.filter((r) => r.status === "pending_review");
  const published = rows.filter((r) => r.status === "published");
  const withdrawn = rows.filter((r) => r.status === "withdrawn");

  return (
    <div className="px-8 py-8 max-w-5xl">
      <header className="flex items-end justify-between mb-6">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Cheat-sheet review queue</h1>
          <p className="text-slate-600 mt-1 text-sm">
            Approve each (payer, state) before it&rsquo;s visible to orgs.
          </p>
        </div>
        <Button onClick={rescan} loading={busy === "scan"} variant="secondary">
          Re-scan candidates
        </Button>
      </header>

      {error && (
        <p className="text-red-700 text-sm">{error}</p>
      )}
      {loading && <p className="text-slate-500 text-sm">Loading…</p>}

      <Section title={`Pending review (${pending.length})`} accent="amber">
        <TemplateTable
          rows={pending}
          busy={busy}
          actions={[
            { label: "Publish", run: publish, primary: true },
          ]}
        />
      </Section>

      <Section title={`Published (${published.length})`} accent="emerald">
        <TemplateTable
          rows={published}
          busy={busy}
          actions={[
            { label: "Withdraw", run: withdraw },
          ]}
        />
      </Section>

      <Section title={`Withdrawn (${withdrawn.length})`} accent="slate">
        <TemplateTable
          rows={withdrawn}
          busy={busy}
          actions={[
            { label: "Re-publish", run: publish, primary: true },
          ]}
        />
      </Section>
    </div>
  );
}

function Section({
  title,
  accent,
  children,
}: {
  title: string;
  accent: "amber" | "emerald" | "slate";
  children: React.ReactNode;
}) {
  const accentCls = {
    amber: "border-amber-200 bg-amber-50/30",
    emerald: "border-emerald-200 bg-emerald-50/30",
    slate: "border-slate-200 bg-slate-50/30",
  }[accent];
  return (
    <Card className={`mb-4 ${accentCls}`}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

interface Action {
  label: string;
  run: (id: string) => void;
  primary?: boolean;
}

function TemplateTable({
  rows,
  busy,
  actions,
}: {
  rows: Template[];
  busy: string | null;
  actions: Action[];
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-3 text-xs text-slate-500">None.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="bg-slate-50/50 text-xs uppercase text-slate-600">
        <tr>
          <th className="px-4 py-2 text-left">Payer</th>
          <th className="px-4 py-2 text-left">State</th>
          <th className="px-4 py-2 text-left">Rules (then / now)</th>
          <th className="px-4 py-2 text-left">Created</th>
          <th className="px-4 py-2" />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-white/40">
            <td className="px-4 py-2">{r.payerName}</td>
            <td className="px-4 py-2 font-mono tabular text-xs">{r.state}</td>
            <td className="px-4 py-2 tabular text-xs">
              {r.ruleCountAtCreation} → {r.ruleCountNow}
            </td>
            <td className="px-4 py-2 tabular text-xs text-slate-600">
              {new Date(r.createdAt).toLocaleDateString()}
            </td>
            <td className="px-4 py-2 text-right">
              <div className="flex justify-end gap-2">
                {actions.map((a) => (
                  <Button
                    key={a.label}
                    size="sm"
                    variant={a.primary ? "primary" : "secondary"}
                    onClick={() => a.run(r.id)}
                    loading={busy === r.id}
                  >
                    {a.label}
                  </Button>
                ))}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
