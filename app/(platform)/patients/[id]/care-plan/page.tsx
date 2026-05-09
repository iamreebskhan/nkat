/**
 * /patients/[id]/care-plan — living TipTap document.
 *
 * Source: pallio_complete_vision_v3 §6.2 + §7.3.
 *
 * Auto-saves on blur. Version snapshots happen on visit-tied saves
 * (when the user is in a visit's documentation flow); standalone saves
 * here just bump current_version on the row without snapshotting.
 */
"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
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

interface CarePlan {
  id: string;
  patientId: string;
  document: JSONContent | null;
  goalsOfCareSummary: string | null;
  primarySymptoms: string[];
  activeMedications: string[];
  currentVersion: number;
  updatedAt: string;
}

export default function CarePlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: patientId } = use(params);
  const [plan, setPlan] = useState<CarePlan | null>(null);
  const [doc, setDoc] = useState<JSONContent | null>(null);
  const [goals, setGoals] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const r = await fetch(`/api/care-plans/${patientId}`);
        const data = await r.json();
        if (abandoned) return;
        if (!data.success) {
          setError(data.error ?? "Failed to load.");
          return;
        }
        if (data.data.carePlan) {
          setPlan(data.data.carePlan);
          setDoc(data.data.carePlan.document ?? null);
          setGoals(data.data.carePlan.goalsOfCareSummary ?? "");
        }
      } catch {
        if (!abandoned) setError("Network error.");
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [patientId]);

  async function save(documentJson?: JSONContent | null) {
    setSaving(true);
    setError(null);
    try {
      const body = {
        document: documentJson ?? doc ?? { type: "doc", content: [] },
        goalsOfCareSummary: goals || null,
      };
      const r = await fetch(`/api/care-plans/${patientId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!data.success) {
        setError(data.error ?? "Save failed.");
        return;
      }
      setSaved(new Date().toLocaleTimeString());
      setPlan((p) =>
        p
          ? { ...p, currentVersion: data.data.version }
          : {
              id: "",
              patientId,
              document: body.document as JSONContent,
              goalsOfCareSummary: body.goalsOfCareSummary,
              primarySymptoms: [],
              activeMedications: [],
              currentVersion: data.data.version,
              updatedAt: new Date().toISOString(),
            },
      );
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="px-8 py-8 text-slate-500">Loading…</div>;

  return (
    <div className="px-8 py-8 max-w-4xl">
      <header className="mb-6">
        <Link
          href={`/patients/${patientId}`}
          className="text-xs text-slate-500 hover:underline"
        >
          ← Patient
        </Link>
        <h1 className="font-display text-3xl tracking-tight mt-1">Care plan</h1>
        <p className="text-slate-600 mt-1 tabular">
          {plan
            ? `v${plan.currentVersion} · last saved ${new Date(plan.updatedAt).toLocaleString()}`
            : "No saves yet"}
        </p>
      </header>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Goals of care</CardTitle>
          <CardDescription>One-paragraph summary updated each visit.</CardDescription>
        </CardHeader>
        <CardContent>
          <textarea
            rows={3}
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
            onBlur={() => save()}
            className="w-full px-3 py-2 rounded-md border border-slate-300 text-base focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2"
            placeholder="Patient prefers comfort-focused care at home…"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Care plan document</CardTitle>
          <CardDescription>
            Living document. Auto-saves on blur. Visit-tied saves create a versioned snapshot.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TipTapEditor
            initial={doc ?? null}
            onChange={(d) => setDoc(d)}
            onBlurSave={(d) => save(d)}
            placeholder="Document the care plan…"
          />
        </CardContent>
      </Card>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-slate-500" aria-live="polite">
          {saving ? "Saving…" : saved ? `Saved at ${saved}` : ""}
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <Button variant="secondary" onClick={() => save()} loading={saving}>
          Save now
        </Button>
      </div>
    </div>
  );
}
