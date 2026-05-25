/**
 * /settings/integrations — third-party connections (Phase E).
 *
 * Today: Google Calendar (per-clinician two-way sync). One row per
 * clinician — each user connects their own Google account. The org
 * admin doesn't connect on behalf of others (that's a different
 * consent model entirely).
 */
"use client";

import { CheckCircle2, AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface GoogleStatus {
  connected: boolean;
  scopes?: string[];
  lastPullAt?: string | null;
  lastPushAt?: string | null;
  status?: string;
}

export default function IntegrationsPage() {
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const r = await fetch("/api/integrations/google");
    const data = await r.json();
    if (data.success) setGoogle(data.data);
    else setError(data.error ?? "Failed to load.");
  }

  useEffect(() => {
    refresh();
    // Surface success / error from the OAuth round-trip via query params.
    const p = new URLSearchParams(window.location.search);
    if (p.get("google_connected")) {
      window.history.replaceState({}, "", "/settings/integrations");
    } else if (p.get("google_error")) {
      setError(`Google returned: ${p.get("google_error")}`);
      window.history.replaceState({}, "", "/settings/integrations");
    }
  }, []);

  async function disconnect() {
    if (!confirm("Disconnect your Google Calendar from Pallio?")) return;
    setBusy(true);
    await fetch("/api/integrations/google", { method: "DELETE" });
    setBusy(false);
    refresh();
  }

  return (
    <div className="px-8 py-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Integrations</h1>
        <p className="text-slate-600 mt-1 text-sm">
          Connect Pallio with the tools you already use.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Google Calendar</CardTitle>
          <CardDescription>
            Two-way sync of your visit schedule + conflict check before booking.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <p className="text-red-700 text-sm mb-3 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> {error}
            </p>
          )}
          {google?.connected ? (
            <>
              <p className="text-sm flex items-center gap-2 text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                Connected · status {google.status}
              </p>
              <dl className="mt-3 text-xs text-slate-500 space-y-1 tabular">
                <div>
                  <dt className="inline">Last pull:</dt>{" "}
                  <dd className="inline">{google.lastPullAt ?? "—"}</dd>
                </div>
                <div>
                  <dt className="inline">Last push:</dt>{" "}
                  <dd className="inline">{google.lastPushAt ?? "—"}</dd>
                </div>
                <div>
                  <dt className="inline">Scopes:</dt>{" "}
                  <dd className="inline">{google.scopes?.join(", ") ?? "—"}</dd>
                </div>
              </dl>
              <Button
                variant="secondary"
                className="mt-4"
                onClick={disconnect}
                loading={busy}
              >
                Disconnect
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                Connect your Google account so Pallio can sync your visit schedule
                and warn you before double-booking.
              </p>
              <a
                href="/api/integrations/google/connect"
                className="inline-flex mt-3"
              >
                <Button>Connect Google Calendar</Button>
              </a>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
