/**
 * /cheat-sheets — generate branded payer-rule PDFs.
 *
 * Source: pallio_complete_vision_v3 §6.7. Mark's primary deliverable.
 */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface PayerOption {
  id: string;
  name: string;
}

export default function CheatSheetsPage() {
  const [payers, setPayers] = useState<PayerOption[]>([]);
  const [state, setState] = useState("");
  const [payerId, setPayerId] = useState("");
  const [cptInput, setCptInput] = useState("");
  const [orgName, setOrgName] = useState("My Organization");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/billing/payers")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setPayers(d.data.rows ?? d.data ?? []);
      })
      .catch(() => undefined);
    fetch("/api/settings/branding")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data?.displayName) setOrgName(d.data.displayName);
      })
      .catch(() => undefined);
  }, []);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const cptCodes = cptInput
        .split(/[\s,]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const res = await fetch("/api/cheatsheets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: state ? state.toUpperCase() : null,
          payerId: payerId || null,
          cptCodes,
          orgName,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? `Failed (${res.status})`);
        setGenerating(false);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cheatsheet-${Date.now()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Network error.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="px-8 py-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Cheat sheets</h1>
        <p className="text-slate-600 mt-1">
          Generate a branded PDF of your rulebook for state × payer × CPT subset.
        </p>
      </header>

      <Card>
        <CardContent className="p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-xs font-medium text-slate-700 mb-1">State (blank = all)</span>
              <input
                value={state}
                onChange={(e) => setState(e.target.value)}
                maxLength={2}
                placeholder="OH"
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm uppercase"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-slate-700 mb-1">Payer (blank = all)</span>
              <select
                value={payerId}
                onChange={(e) => setPayerId(e.target.value)}
                className="w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white"
              >
                <option value="">All payers</option>
                {payers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="block text-xs font-medium text-slate-700 mb-1">
              CPT codes (comma or space separated; blank = all)
            </span>
            <input
              value={cptInput}
              onChange={(e) => setCptInput(e.target.value)}
              placeholder="99347 99348 99349 G0317"
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono"
            />
          </label>

          {error && (
            <div role="alert" className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={generate} disabled={generating}>
              {generating ? "Generating PDF…" : "Generate cheat sheet"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
