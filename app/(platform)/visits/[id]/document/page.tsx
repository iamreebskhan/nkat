/**
 * /visits/[id]/document — clinician's primary tool.
 *
 * Source: pallio_complete_vision_v3 §6.4 + §7.2.
 *
 * Single screen with:
 *   - Time tracker (start / stop, total minutes computed live)
 *   - Telehealth toggle + modality select + consent acknowledgment
 *   - CPT suggestion panel (live, from `suggestCodes` pure function)
 *   - TipTap document body
 *   - "Save draft" + "Sign + submit for billing" buttons
 *
 * The CPT suggester runs entirely client-side from the pure function
 * — no API call needed for the preview. The suggested codes are
 * persisted into `cpt_codes_assigned` only when the clinician saves.
 */
"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import type { JSONContent } from "@tiptap/react";

import { TipTapEditor } from "@/components/editor/tiptap-editor";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { suggestCodes, type ProviderType } from "@/lib/features/visits/cpt-suggester";
import { computeTotalMinutes } from "@/lib/features/visits/visit-pure";
import type {
  TelehealthModality,
  VisitType,
  VisitView,
} from "@/lib/features/visits/visit.types";

type Doc = JSONContent | null;

export default function VisitDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [visit, setVisit] = useState<VisitView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Local form state
  const [doc, setDoc] = useState<Doc>(null);
  const [startTime, setStartTime] = useState<string>("");
  const [stopTime, setStopTime] = useState<string>("");
  const [acpMinutes, setAcpMinutes] = useState<number>(0);
  const [isTelehealth, setIsTelehealth] = useState(false);
  const [telehealthModality, setTelehealthModality] =
    useState<TelehealthModality>("audio_video");
  const [telehealthConsent, setTelehealthConsent] = useState(false);
  // Provider tier — in Phase 4 this comes from the user's profile.
  // For now we default to NP and let the clinician pick.
  const [providerType, setProviderType] = useState<ProviderType>("NP");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const r = await fetch(`/api/visits/${id}`);
        const data = await r.json();
        if (abandoned) return;
        if (!data.success) {
          setError(data.error ?? "Visit not found.");
          return;
        }
        const v = data.data as VisitView;
        setVisit(v);
        setStartTime(toLocalDatetime(v.startTime));
        setStopTime(toLocalDatetime(v.stopTime));
        setAcpMinutes(v.acpMinutes ?? 0);
        setIsTelehealth(v.isTelehealth);
        setTelehealthModality(v.telehealthModality ?? "audio_video");
        setTelehealthConsent(v.telehealthConsentDocumented);
        setDoc(parseDoc(v.documentText));
      } catch {
        if (!abandoned) setError("Network error.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [id]);

  // Live total minutes from start/stop. Falls back to whatever the user
  // typed manually (rare).
  const totalMinutes = useMemo(() => {
    const start = startTime ? new Date(startTime) : null;
    const stop = stopTime ? new Date(stopTime) : null;
    return computeTotalMinutes(start, stop) ?? visit?.totalMinutes ?? 0;
  }, [startTime, stopTime, visit?.totalMinutes]);

  // Live CPT suggestion — pure, client-side.
  const suggestion = useMemo(() => {
    if (!visit) return null;
    return suggestCodes({
      visitType: visit.visitType,
      totalMinutes,
      acpMinutes,
      providerType,
      // Phase 4 will derive payer category from the patient's primary
      // payer; today the default is Medicare-conservative.
      payerCategory: "non_medicare",
      isTelehealth,
    });
  }, [visit, totalMinutes, acpMinutes, providerType, isTelehealth]);

  if (loading) return <div className="px-8 py-8 text-slate-500">Loading…</div>;
  if (error || !visit)
    return (
      <div className="px-8 py-8">
        <p className="text-red-700">{error ?? "Visit not found."}</p>
        <Link
          href="/visits"
          className="mt-4 inline-block text-[var(--color-brand-700)] underline"
        >
          ← Back to visits
        </Link>
      </div>
    );

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const allCodes = suggestion
        ? [
            ...suggestion.base.map((c) => c.code),
            ...suggestion.prolongedAddOns.map((c) => c.code),
            ...suggestion.acpAddOns.map((c) => c.code),
          ]
        : (visit?.cptCodesAssigned ?? []);
      const allMods =
        (suggestion?.modifiers ?? []).map((m) => m.modifier);

      const body = {
        startTime: startTime ? new Date(startTime).toISOString() : undefined,
        stopTime: stopTime ? new Date(stopTime).toISOString() : undefined,
        totalMinutes,
        acpMinutes,
        documentText: JSON.stringify(doc ?? { type: "doc", content: [] }),
        cptCodesAssigned: allCodes,
        modifiers: allMods,
        isTelehealth,
        telehealthModality: isTelehealth ? telehealthModality : undefined,
        telehealthConsentDocumented: telehealthConsent,
      };
      const r = await fetch(`/api/visits/${id}/document`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Save failed.");
        return;
      }
      setSaved(new Date().toLocaleTimeString());
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  async function submitForBilling() {
    if (!suggestion || suggestion.inconclusive) {
      setError("Need at least one CPT code before submitting.");
      return;
    }
    if (isTelehealth && !telehealthConsent) {
      setError("Telehealth visit needs consent acknowledgment.");
      return;
    }
    setSubmitting(true);
    try {
      await save();
      const t1 = await fetch(`/api/visits/${id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "documented" }),
      });
      if (!(await t1.json()).success) throw new Error("documented transition failed");
      const t2 = await fetch(`/api/visits/${id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "pending_billing" }),
      });
      const data = await t2.json();
      if (!data.success) {
        setError(data.error ?? "Transition failed.");
        return;
      }
      setSaved(`Submitted ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-8 py-6 max-w-5xl">
      <header className="mb-5">
        <Link
          href={`/patients/${visit.patientId}`}
          className="text-xs text-slate-500 hover:underline"
        >
          ← Patient
        </Link>
        <h1 className="font-display text-2xl tracking-tight mt-1">
          Document visit · {prettyVisitType(visit.visitType)}
        </h1>
        <p className="text-slate-600 mt-1 tabular text-sm">
          {visit.status} · {totalMinutes} min documented
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Documentation</CardTitle>
              <CardDescription>
                Auto-saves on blur. Use the toolbar for headings + lists.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TipTapEditor
                initial={doc ?? undefined}
                onChange={(d) => setDoc(d)}
                onBlurSave={() => save()}
                placeholder="Document the visit…"
              />
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Time</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <label className="block">
                <span className="text-slate-700 font-medium">Start</span>
                <input
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-base"
                />
              </label>
              <label className="block">
                <span className="text-slate-700 font-medium">Stop</span>
                <input
                  type="datetime-local"
                  value={stopTime}
                  onChange={(e) => setStopTime(e.target.value)}
                  className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-base"
                />
              </label>
              <p className="text-2xl font-bold tabular">
                {totalMinutes} <span className="text-sm text-slate-500 font-normal">min</span>
              </p>
              <label className="block">
                <span className="text-slate-700 font-medium">ACP minutes</span>
                <input
                  type="number"
                  min={0}
                  max={180}
                  value={acpMinutes}
                  onChange={(e) => setAcpMinutes(Number(e.target.value))}
                  className="mt-1 w-24 h-9 px-2 border border-slate-300 rounded-md text-base tabular"
                />
              </label>
              <label className="block">
                <span className="text-slate-700 font-medium">Provider tier</span>
                <select
                  value={providerType}
                  onChange={(e) => setProviderType(e.target.value as ProviderType)}
                  className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-sm"
                >
                  <option value="NP">Nurse Practitioner</option>
                  <option value="PA">Physician Assistant</option>
                  <option value="MD">Physician (MD)</option>
                  <option value="RN">Registered Nurse</option>
                  <option value="SW">Social Worker</option>
                </select>
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Telehealth</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isTelehealth}
                  onChange={(e) => setIsTelehealth(e.target.checked)}
                />
                <span>This is a telehealth visit</span>
              </label>
              {isTelehealth && (
                <>
                  <label className="block">
                    <span className="text-slate-700 font-medium">Modality</span>
                    <select
                      value={telehealthModality}
                      onChange={(e) =>
                        setTelehealthModality(
                          e.target.value as TelehealthModality,
                        )
                      }
                      className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-sm"
                    >
                      <option value="audio_video">Audio + video (95 modifier)</option>
                      <option value="audio_only">Audio only (93 modifier)</option>
                    </select>
                  </label>
                  <label className="flex items-start gap-2 px-2 py-2 bg-amber-50 rounded-md ring-1 ring-inset ring-amber-600/30">
                    <input
                      type="checkbox"
                      checked={telehealthConsent}
                      onChange={(e) => setTelehealthConsent(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-amber-900 text-xs">
                      Patient consents to a telehealth visit. Required documentation per pallio §5.2.
                    </span>
                  </label>
                </>
              )}
            </CardContent>
          </Card>

          {suggestion && (
            <Card>
              <CardHeader>
                <CardTitle>Suggested codes</CardTitle>
                <CardDescription>
                  Live from <code className="text-xs">cpt-suggester</code> per vision §18.8.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {suggestion.base.map((c) => (
                  <CodeRow key={c.code} {...c} />
                ))}
                {suggestion.prolongedAddOns.map((c) => (
                  <CodeRow key={c.code} {...c} kind="add" />
                ))}
                {suggestion.acpAddOns.map((c) => (
                  <CodeRow key={c.code} {...c} kind="add" />
                ))}
                {suggestion.modifiers.map((m) => (
                  <div
                    key={m.modifier}
                    className="text-xs text-slate-600 px-2 py-1 bg-slate-50 rounded"
                  >
                    Modifier {m.modifier}: {m.reason}
                  </div>
                ))}
                {suggestion.inconclusive && (
                  <p className="text-xs text-amber-800 bg-amber-50 px-2 py-2 rounded">
                    No conclusive code yet — start the timer or pick a visit type.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </aside>
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500" aria-live="polite">
          {saving ? "Saving…" : saved ? saved : ""}
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={save} loading={saving}>
            Save draft
          </Button>
          <Button onClick={submitForBilling} loading={submitting}>
            Sign + submit for billing
          </Button>
        </div>
      </div>
    </div>
  );
}

function CodeRow({
  code,
  reason,
  confidence,
  kind = "base",
}: {
  code: string;
  reason: string;
  confidence: "edge" | "confirmed";
  kind?: "base" | "add";
}) {
  return (
    <div className="flex gap-2 items-start">
      <span
        className={`px-2 py-0.5 rounded text-xs font-mono font-semibold tabular ${
          kind === "base"
            ? "bg-[var(--color-brand-50)] text-[var(--color-brand-900)] ring-1 ring-inset ring-[var(--color-brand-600)]/30"
            : "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300"
        }`}
      >
        {code}
      </span>
      <span className="text-xs text-slate-600 flex-1">
        {reason}
        {confidence === "edge" && (
          <span className="ml-1 text-amber-700">(confirm before submit)</span>
        )}
      </span>
    </div>
  );
}

function toLocalDatetime(iso: string | null): string {
  if (!iso) return "";
  // datetime-local input format: YYYY-MM-DDTHH:MM
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDoc(text: string | null): Doc {
  if (!text) return null;
  try {
    return JSON.parse(text) as JSONContent;
  } catch {
    // Legacy plain-text — wrap as a single paragraph.
    return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
  }
}

function prettyVisitType(t: VisitType): string {
  return t.replace(/_/g, " ");
}
