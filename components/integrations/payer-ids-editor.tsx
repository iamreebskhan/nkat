/**
 * The payer IDs one clearinghouse knows the practice's payers by (0120): a
 * claim names its payer by this ID (837P 2010BB NM109), and an eligibility or
 * status question is routed by it. They differ by clearinghouse, so each
 * connection has its own list; the payers the practice bills most come first.
 *
 * The filing indicator (SBR09) starts from the payer's type and is changed
 * here only when the clearinghouse wants another (Medicaid managed care is
 * MC to most and HM to some).
 */
"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { PayerIdRow } from "@/lib/features/clearinghouse/connection.service";
import { FILING_INDICATORS } from "@/lib/features/clearinghouse/vendors";
import { PAYER_TYPE_LABELS, type PayerType } from "@/lib/features/billing/payer-types";

interface Edit {
  externalPayerId: string;
  claimFilingIndicator: string;
}

export function PayerIdsEditor({ connectionId, vendorName, onClose }: { connectionId: string; vendorName: string; onClose: () => void }) {
  const [rows, setRows] = useState<PayerIdRow[] | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let abandoned = false;
    fetch(`/api/integrations/clearinghouses/${connectionId}/payers`)
      .then((r) => r.json())
      .then((d) => {
        if (abandoned) return;
        if (!d.success) setMsg({ ok: false, text: d.error ?? "Could not load the payers." });
        else setRows(d.data.payers as PayerIdRow[]);
      })
      .catch(() => {
        if (!abandoned) setMsg({ ok: false, text: "Couldn't reach Pallio. Close this and try again." });
      });
    return () => {
      abandoned = true;
    };
  }, [connectionId]);

  const value = (r: PayerIdRow): Edit =>
    edits[r.payerId] ?? { externalPayerId: r.externalPayerId ?? "", claimFilingIndicator: r.claimFilingIndicator ?? "" };
  const changed = rows?.filter((r) => {
    const v = value(r);
    return v.externalPayerId.trim() !== (r.externalPayerId ?? "") || v.claimFilingIndicator !== (r.claimFilingIndicator ?? "");
  }) ?? [];

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const d = await fetch(`/api/integrations/clearinghouses/${connectionId}/payers`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rows: changed.map((r) => {
            const v = value(r);
            return { payerId: r.payerId, externalPayerId: v.externalPayerId.trim() || null, claimFilingIndicator: v.claimFilingIndicator || null };
          }),
        }),
      }).then((r) => r.json());
      if (!d.success) {
        setMsg({ ok: false, text: d.error ?? "Not saved." });
        return;
      }
      setRows(d.data.payers as PayerIdRow[]);
      setEdits({});
      setMsg({ ok: true, text: `Saved ${changed.length} payer ID${changed.length === 1 ? "" : "s"} for ${vendorName}.` });
    } catch {
      setMsg({ ok: false, text: "Couldn't reach Pallio, so nothing was saved. Try again." });
    } finally {
      setBusy(false);
    }
  }

  const shown = rows ? (showAll ? rows : rows.filter((r) => r.claims > 0 || r.externalPayerId)) : [];
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Enter each payer&rsquo;s ID from {vendorName}&rsquo;s payer list. Claims to a payer without an ID here can&rsquo;t be
        sent through {vendorName}.
      </p>
      {rows === null && !msg && <p className="text-sm text-slate-500">Loading…</p>}
      {rows && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Payer</th>
                <th className="px-3 py-2 text-right font-semibold">Claims</th>
                <th className="px-3 py-2 text-left font-semibold">{vendorName} payer ID</th>
                <th className="px-3 py-2 text-left font-semibold">Filing indicator</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((r) => {
                const v = value(r);
                return (
                  <tr key={r.payerId}>
                    <td className="px-3 py-2">
                      {r.payerName}
                      <span className="block text-xs text-slate-500">
                        {PAYER_TYPE_LABELS[r.payerType as PayerType] ?? r.payerType}
                        {r.states.length > 0 ? ` · ${r.states.join(", ")}` : ""}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular text-slate-600">{r.claims}</td>
                    <td className="px-3 py-2">
                      <input
                        aria-label={`${vendorName} payer ID for ${r.payerName}`}
                        className="h-9 w-40 rounded-md border border-slate-300 px-2 font-mono text-sm"
                        maxLength={80}
                        placeholder={r.rosterPayerId ?? ""}
                        value={v.externalPayerId}
                        onChange={(e) => setEdits((cur) => ({ ...cur, [r.payerId]: { ...v, externalPayerId: e.target.value } }))}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <select
                        aria-label={`Claim filing indicator for ${r.payerName}`}
                        className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
                        value={v.claimFilingIndicator}
                        onChange={(e) => setEdits((cur) => ({ ...cur, [r.payerId]: { ...v, claimFilingIndicator: e.target.value } }))}
                      >
                        <option value="">From its type ({r.defaultFilingIndicator})</option>
                        {Object.entries(FILING_INDICATORS).map(([code, labelText]) => (
                          <option key={code} value={code}>
                            {code} — {labelText}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!showAll && rows.length > shown.length && (
            <button type="button" className="mt-2 text-xs text-[var(--color-brand-700)] hover:underline" onClick={() => setShowAll(true)}>
              Show all {rows.length} payers (only those with claims or an ID are listed)
            </button>
          )}
        </div>
      )}
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-emerald-800" : "text-red-700"}`}>
          {msg.text}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" loading={busy} disabled={changed.length === 0} onClick={() => void save()}>
          Save {changed.length > 0 ? `${changed.length} ` : ""}payer ID{changed.length === 1 ? "" : "s"}
        </Button>
        <Button size="sm" variant="secondary" onClick={onClose} disabled={busy}>
          Close
        </Button>
      </div>
    </div>
  );
}
