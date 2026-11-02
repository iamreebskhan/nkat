/**
 * /settings/fees — the practice's own fee schedule (0118; Level-1 doc:74; Mark
 * Q4 default). A code with a fee bills at it, and the payer's rate becomes what
 * the payment is expected to be; a code without one bills at the payer's rate,
 * as every code did before. Empty until the practice enters its fees.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import { Field, TextInput } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PracticeFeeView } from "@/lib/features/billing/practice-fee.service";

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
/** "125" or "125.50" → cents; null when it is not an amount. */
function toCents(s: string): number | null {
  const t = s.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export default function FeesPage() {
  const [data, setData] = useState<{ today: string; rows: PracticeFeeView[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [f, setF] = useState({ code: "", fee: "", from: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ending, setEnding] = useState<{ id: string; on: string } | null>(null);
  const [endMsg, setEndMsg] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetch("/api/settings/fees")
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return setFailed(d.error ?? "Could not load the fees.");
        setData(d.data);
        setF((x) => (x.from ? x : { ...x, from: d.data.today }));
      })
      .catch(() => setFailed("Network error."));
  }, []);
  useEffect(() => reload(), [reload]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const code = f.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return setMsg("A CPT or HCPCS code is five characters.");
    const feeCents = toCents(f.fee);
    if (feeCents === null || feeCents < 1) return setMsg("The fee is an amount in dollars, e.g. 150 or 150.00.");
    if (!f.from) return setMsg("From which day?");
    setBusy(true);
    try {
      const r = await fetch("/api/settings/fees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, feeCents, effectiveFrom: f.from }),
      });
      const d = await r.json();
      if (!d.success) return setMsg(d.error ?? "Not saved.");
      setF((x) => ({ ...x, code: "", fee: "" }));
      reload();
    } catch {
      setMsg("Network error — not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    if (!ending) return;
    setEndMsg(null);
    try {
      const r = await fetch(`/api/settings/fees/${ending.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endOn: ending.on }),
      });
      const d = await r.json();
      if (!d.success) return setEndMsg(d.error ?? "Not saved.");
      setEnding(null);
      reload();
    } catch {
      setEndMsg("Network error — not saved.");
    }
  }

  const inForce = (data?.rows ?? []).filter((r) => r.effectiveTo === null || r.effectiveTo > (data?.today ?? ""));
  const past = (data?.rows ?? []).filter((r) => !inForce.includes(r));

  return (
    <div className="px-8 py-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Fee schedule</h1>
        <p className="text-slate-600 mt-1">
          The practice&rsquo;s own charge for a code. A code with a fee bills at it, and the payer&rsquo;s rate is what the
          payment is expected to be — the difference is the contractual adjustment. A code without one bills at the
          payer&rsquo;s rate.
        </p>
      </header>
      {failed && (
        <p role="alert" className="text-sm text-red-700">
          {failed}
        </p>
      )}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Set a fee</CardTitle>
          <CardDescription>
            A new fee for a code starts on its day and ends the one before it. Bills already raised keep their price until
            they are edited.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} noValidate className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end" aria-label="Set a fee">
            <Field id="fee-code" label="Code" required>
              <TextInput id="fee-code" maxLength={5} placeholder="99349" value={f.code} onChange={(e) => { setF((x) => ({ ...x, code: e.target.value })); setMsg(null); }} />
            </Field>
            <Field id="fee-amt" label="Fee" required>
              <TextInput id="fee-amt" inputMode="decimal" placeholder="150.00" value={f.fee} onChange={(e) => { setF((x) => ({ ...x, fee: e.target.value })); setMsg(null); }} />
            </Field>
            <Field id="fee-from" label="From" required>
              <TextInput id="fee-from" type="date" value={f.from} onChange={(e) => { setF((x) => ({ ...x, from: e.target.value })); setMsg(null); }} />
            </Field>
            <Button type="submit" loading={busy} disabled={!data}>
              Save the fee
            </Button>
            {msg && (
              <p role="alert" className="md:col-span-4 text-sm text-red-700">
                {msg}
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Fees in force</CardTitle>
          <CardDescription>{inForce.length === 0 ? "None yet: every code bills at the payer's rate." : `${inForce.length} code${inForce.length === 1 ? "" : "s"}.`}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {inForce.length > 0 && (
            <ul className="divide-y divide-slate-100" aria-label="Fees in force">
              {inForce.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span>
                    <span className="font-mono">{r.code}</span> · <strong>{money(r.feeCents)}</strong>
                    <span className="text-slate-500">
                      {" "}
                      from {r.effectiveFrom}
                      {r.effectiveTo && ` to ${r.effectiveTo}`}
                    </span>
                  </span>
                  {ending?.id === r.id ? (
                    <span className="flex flex-wrap items-center gap-2" role="group" aria-label={`End the ${r.code} fee`}>
                      <TextInput aria-label="Ends on" type="date" value={ending.on} onChange={(e) => setEnding({ id: r.id, on: e.target.value })} className="h-8 text-sm" />
                      <Button type="button" variant="secondary" size="sm" onClick={() => { setEnding(null); setEndMsg(null); }}>
                        Cancel
                      </Button>
                      <Button type="button" variant="danger" size="sm" onClick={() => void end()}>
                        End it
                      </Button>
                    </span>
                  ) : (
                    !r.effectiveTo && (
                      <button type="button" className="text-xs text-slate-500 hover:text-red-700" onClick={() => setEnding({ id: r.id, on: data!.today })}>
                        End
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
          {endMsg && (
            <p role="alert" className="text-sm text-red-700">
              {endMsg}
            </p>
          )}
          {past.length > 0 && (
            <details>
              <summary className="cursor-pointer text-slate-600">Earlier fees ({past.length})</summary>
              <ul className="mt-2 divide-y divide-slate-100 text-slate-600">
                {past.map((r) => (
                  <li key={r.id} className="py-1">
                    <span className="font-mono">{r.code}</span> · {money(r.feeCents)} from {r.effectiveFrom} to {r.effectiveTo}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
