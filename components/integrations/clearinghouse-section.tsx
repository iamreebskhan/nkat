/**
 * Settings → Integrations → Clearinghouses (0120): the four Mark named
 * [v1 10:58] — Availity, Waystar, TriZetto, Inovalon — each with the
 * practice's connections to it, and setting one up, testing it, and the
 * payer IDs it uses.
 *
 * For org admins (settings.integrations). Billing staff see the connections
 * by name on the billing screens; the IDs, hosts and secrets stay here.
 */
"use client";

import { CheckCircle2, CircleAlert, KeyRound, Plug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConnectionView, TestStep } from "@/lib/features/clearinghouse/connection.service";
import { CLEARINGHOUSE_VENDORS, VENDOR_PROFILES, type ClearinghouseVendor } from "@/lib/features/clearinghouse/vendors";
import { usePracticeTime } from "@/lib/features/schedule/use-practice-zone";

import { ClearinghouseForm } from "./clearinghouse-form";
import { PayerIdsEditor } from "./payer-ids-editor";

const BLURB: Record<ClearinghouseVendor, string> = {
  availity: "Claims by SFTP; eligibility and claim status by Availity's API or CAQH CORE. Free for many payers.",
  waystar: "Claims by SFTP with your Client Account ID; eligibility and claim status by CAQH CORE.",
  trizetto: "Claims by SFTP once TriZetto's support turns it on for your Site ID; real-time checks if your enrollment includes them.",
  inovalon: "No public setup guide: Inovalon gives you every ID, server and folder when you enroll.",
};

type Panel =
  | { kind: "form"; vendor: ClearinghouseVendor; existing: ConnectionView | null }
  | { kind: "payers"; connection: ConnectionView }
  | null;

export function ClearinghouseSection() {
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  // When each connection was last tested, on the practice's clock.
  const atPractice = usePracticeTime();
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; steps: TestStep[] }>>({});
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch("/api/integrations/clearinghouses").then((r) => r.json());
      if (!d.success) {
        setError(d.error ?? "Couldn't load the connections. Reload the page.");
        return;
      }
      setConnections(d.data.connections as ConnectionView[]);
      setError(null);
    } catch {
      setError("Couldn't reach Pallio. Check your connection and reload the page.");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function call(id: string, path: string, init: RequestInit, done: (data: unknown) => void) {
    setBusy(`${id}:${path}`);
    setNote(null);
    try {
      const d = await fetch(`/api/integrations/clearinghouses/${id}${path}`, init).then((r) => r.json());
      if (!d.success) setNote(d.error ?? "That didn't work. Try again.");
      else done(d.data);
    } catch {
      setNote("Couldn't reach Pallio. Try again.");
    } finally {
      setBusy(null);
      void load();
    }
  }

  const test = (c: ConnectionView) =>
    call(c.id, "/test", { method: "POST" }, (data) => {
      const r = data as { ok: boolean; steps: TestStep[] };
      setTests((cur) => ({ ...cur, [c.id]: { ok: r.ok, steps: r.steps } }));
    });
  const toggle = (c: ConnectionView) =>
    call(c.id, "", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: c.status === "active" ? "disabled" : "active" }) }, () => {});
  const remove = (c: ConnectionView) => {
    if (!confirm(`Remove "${c.label}"?\n\nIts saved passwords are deleted, and this can't be undone. Claim files already sent through it keep their history.`)) return;
    void call(c.id, "", { method: "DELETE" }, () => setPanel(null));
  };
  const resetKey = (c: ConnectionView) => {
    if (!confirm(`Forget the saved host key for ${c.settings.sftp?.host ?? "the server"}?\n\nDo this only if ${c.vendorName} told you their server's key changed. The next "Test connection" saves the new one.`)) return;
    void call(c.id, "/host-key", { method: "DELETE" }, () => {});
  };

  return (
    <section className="mb-8">
      <h2 className="font-display text-xl">Clearinghouses</h2>
      <p className="mt-1 text-sm text-slate-600">
        Send claims to your clearinghouse and read its responses back automatically: acknowledgments (999, 277CA) and
        payments (835). You can also check a patient&rsquo;s eligibility and a claim&rsquo;s status with the payer. Start
        with a test connection: test files never reach a payer.
      </p>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {note && <p role="alert" className="mt-3 whitespace-pre-line text-sm text-red-700">{note}</p>}

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        {CLEARINGHOUSE_VENDORS.map((v) => {
          const mine = (connections ?? []).filter((c) => c.vendor === v);
          return (
            <Card key={v}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Plug aria-hidden="true" className="h-4 w-4" /> {VENDOR_PROFILES[v].name}
                </CardTitle>
                <CardDescription>{BLURB[v]}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {connections === null && <p className="text-sm text-slate-500">Loading…</p>}
                {mine.map((c) => (
                  <div key={c.id} className="rounded-md border border-slate-200 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-medium">{c.label}</span>
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{c.environment}</span>
                        {c.isPrimary && <span className="ml-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">default</span>}
                        {c.status === "disabled" && <span className="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900">switched off</span>}
                        <span className="block text-xs text-slate-500">
                          {c.batchChannel === "sftp" ? `Claims by SFTP (${c.settings.sftp?.host ?? ""})` : "Claim files downloaded and uploaded by hand"}
                          {c.realtimeChannel === "core_soap" ? " · real-time checks by CAQH CORE" : c.realtimeChannel === "availity_api" ? " · real-time checks by Availity's API" : ""}
                        </span>
                        {c.secretsUnreadable && (
                          <span className="block text-xs text-red-700">
                            Its passwords are saved, but the server&rsquo;s encryption key (PALLIO_TOKEN_KEY) is missing, so it can&rsquo;t
                            connect. Ask whoever runs the server to restore the key.
                          </span>
                        )}
                        {c.lastTest && (
                          <span className={`block text-xs ${c.lastTest.ok ? "text-emerald-800" : "text-red-700"}`}>
                            {c.lastTest.ok ? <CheckCircle2 aria-hidden="true" className="mr-1 inline h-3 w-3" /> : <CircleAlert aria-hidden="true" className="mr-1 inline h-3 w-3" />}
                            Tested {atPractice(c.lastTest.at)}: {c.lastTest.ok ? "passed" : "failed"}
                          </span>
                        )}
                        {c.hostKeySha256 && (
                          <span className="block text-xs text-slate-500">
                            <KeyRound aria-hidden="true" className="mr-1 inline h-3 w-3" />
                            Server&rsquo;s host key saved: a different server is refused
                          </span>
                        )}
                      </div>
                    </div>
                    {tests[c.id] && (
                      <ul className="mt-2 space-y-1 text-xs">
                        {tests[c.id]!.steps.map((st) => (
                          <li key={st.channel} className={st.ok ? "text-emerald-800" : "text-red-700"}>
                            {st.channel === "sftp" ? "SFTP" : st.channel === "core_soap" ? "CORE" : "API"}: {st.message}
                          </li>
                        ))}
                        {tests[c.id]!.steps.length === 0 && <li className="text-slate-600">Nothing to test: this connection has no SFTP or real-time channel.</li>}
                      </ul>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => setPanel({ kind: "form", vendor: v, existing: c })}>Edit</Button>
                      <Button size="sm" variant="secondary" loading={busy === `${c.id}:/test`} disabled={busy !== null || c.status !== "active"} onClick={() => void test(c)}>
                        Test connection
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setPanel({ kind: "payers", connection: c })}>Payer IDs</Button>
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void toggle(c)}>
                        {c.status === "active" ? "Switch off" : "Switch on"}
                      </Button>
                      {c.hostKeySha256 && (
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => resetKey(c)}>Reset host key</Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => remove(c)}>Remove</Button>
                    </div>
                  </div>
                ))}
                <Button size="sm" variant={mine.length === 0 ? "primary" : "secondary"} onClick={() => setPanel({ kind: "form", vendor: v, existing: null })}>
                  {mine.length === 0 ? `Set up ${VENDOR_PROFILES[v].name}` : `Add another ${VENDOR_PROFILES[v].name} connection`}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {panel && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">
              {panel.kind === "form"
                ? panel.existing
                  ? `Edit ${panel.existing.label}`
                  : `New ${VENDOR_PROFILES[panel.vendor].name} connection`
                : `${panel.connection.label}: payer IDs`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {panel.kind === "form" ? (
              <ClearinghouseForm
                key={panel.existing?.id ?? `new-${panel.vendor}`}
                vendor={panel.vendor}
                existing={panel.existing}
                onCancel={() => setPanel(null)}
                onSaved={(c) => {
                  setPanel(null);
                  void load();
                  setNote(null);
                  setTests((cur) => {
                    const next = { ...cur };
                    delete next[c.id];
                    return next;
                  });
                }}
              />
            ) : (
              <PayerIdsEditor connectionId={panel.connection.id} vendorName={panel.connection.vendorName} onClose={() => setPanel(null)} />
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
