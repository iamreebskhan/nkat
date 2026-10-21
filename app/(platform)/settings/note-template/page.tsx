/**
 * Settings → Note template.
 *
 * Mark's own caveat on the document he gave us [05:55]: "I developed it over
 * eight years ago. It's not quite current to current technology and current
 * rules, but it'll give you an idea." This is the screen that makes that true
 * — the shipped sections are version 1 of an org's template, and an admin can
 * rename them, change what is required, reorder, add and remove.
 *
 * Saving writes a new VERSION. A visit whose note is already started, signed
 * or not, stays pinned to the version it was written under, so an edit here
 * never restates what an attested note claimed its sections were, and never
 * reshapes a note someone is part-way through. New notes take the new version.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Kind = "prose" | "vitals" | "list";

interface Section {
  sectionKey: string;
  label: string;
  helpText: string | null;
  kind: Kind;
  isRequired: boolean;
  notRequiredForVisitTypes: string[];
}

const KIND_HELP: Record<Kind, string> = {
  prose: "Rich text — a narrative block.",
  list: "One item per line.",
  vitals: "The vitals capture. Stored as measurements, not as text.",
};

/** Turn a label into a stable machine key for a newly added section. */
const keyOf = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 63) || "section";

export default function NoteTemplateSettingsPage() {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [source, setSource] = useState<string>("default");
  const [visitTypes, setVisitTypes] = useState<{ slug: string; label: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let abandoned = false;
    (async () => {
      const r = await fetch("/api/settings/note-template").catch(() => null);
      const d = await r?.json().catch(() => null);
      if (!d || abandoned) return;
      if (!d.success) {
        setError(d.error ?? "Could not load the template.");
        return;
      }
      setSections(d.data.sections as Section[]);
      setVersion(d.data.version as number);
      setSource(d.data.source as string);

      const vr = await fetch("/api/settings/visit-types").catch(() => null);
      const vd = await vr?.json().catch(() => null);
      if (vd?.success && !abandoned) {
        const types = (vd.data?.types ?? []) as { slug: string; label: string }[];
        setVisitTypes(types.map((v) => ({ slug: v.slug, label: v.label })));
      }
    })();
    return () => {
      abandoned = true;
    };
  }, []);

  const patch = (i: number, next: Partial<Section>) =>
    setSections((ss) => ss!.map((s, j) => (j === i ? { ...s, ...next } : s)));

  const move = (i: number, by: number) =>
    setSections((ss) => {
      const next = [...ss!];
      const j = i + by;
      if (j < 0 || j >= next.length) return next;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  async function save() {
    if (!sections) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const r = await fetch("/api/settings/note-template", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections }),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error ?? "Could not save the template.");
        return;
      }
      setVersion(d.data.version);
      setSource("edited");
      setSaved(`Saved as version ${d.data.version}.`);
    } catch {
      setError("Network error saving the template.");
    } finally {
      setSaving(false);
    }
  }

  if (error && !sections) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    );
  }
  if (!sections) return <p className="text-sm text-slate-500">Loading the template…</p>;

  return (
    <div>
      <header className="mb-6">
        <Link href="/settings" className="text-sm text-slate-500 hover:underline">
          ← Settings
        </Link>
        <h1 className="font-display text-2xl tracking-tight mt-1">Note template</h1>
        <p className="text-slate-600 mt-1 text-sm">
          What every visit note in this organisation asks for.{" "}
          {version !== null && (
            <span className="tabular">
              Currently version {version}
              {source === "default" ? " — the shipped starting point." : "."}
            </span>
          )}
        </p>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {saved && (
        <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {saved} Notes already started keep the version they were written under.
        </p>
      )}

      <div className="space-y-3">
        {sections.map((s, i) => (
          <Card key={s.sectionKey}>
            <CardContent className="pt-5 space-y-3">
              <div className="flex flex-wrap items-start gap-3">
                <label className="flex-1 min-w-[14rem]">
                  <span className="block text-xs text-slate-600">Label</span>
                  <input
                    value={s.label}
                    onChange={(e) => patch(i, { label: e.target.value })}
                    className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-sm"
                  />
                </label>
                <div className="text-xs text-slate-500 pt-6">
                  <code>{s.sectionKey}</code>
                  <span className="ml-2">{KIND_HELP[s.kind]}</span>
                </div>
                <div className="flex gap-1 pt-5">
                  <button
                    type="button"
                    aria-label={`Move ${s.label} up`}
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    className="h-9 w-9 rounded-md ring-1 ring-inset ring-slate-300 disabled:opacity-40"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${s.label} down`}
                    onClick={() => move(i, 1)}
                    disabled={i === sections.length - 1}
                    className="h-9 w-9 rounded-md ring-1 ring-inset ring-slate-300 disabled:opacity-40"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${s.label}`}
                    onClick={() => setSections((ss) => ss!.filter((_, j) => j !== i))}
                    className="h-9 px-3 rounded-md text-xs ring-1 ring-inset ring-slate-300 hover:ring-red-400 hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="block text-xs text-slate-600">
                  Help text <span className="text-slate-400">— shown under the label</span>
                </span>
                <input
                  value={s.helpText ?? ""}
                  onChange={(e) => patch(i, { helpText: e.target.value || null })}
                  className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-sm"
                />
              </label>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={s.isRequired}
                    onChange={(e) => patch(i, { isRequired: e.target.checked })}
                    className="h-4 w-4"
                  />
                  Required before signing
                </label>

                {s.isRequired && visitTypes.length > 0 && (
                  <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <legend className="sr-only">{`Visit types where ${s.label} is not required`}</legend>
                    <span className="text-xs text-slate-500">…except on:</span>
                    {visitTypes.map((vt) => (
                      <label key={vt.slug} className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={s.notRequiredForVisitTypes.includes(vt.slug)}
                          onChange={(e) =>
                            patch(i, {
                              notRequiredForVisitTypes: e.target.checked
                                ? [...s.notRequiredForVisitTypes, vt.slug]
                                : s.notRequiredForVisitTypes.filter((x) => x !== vt.slug),
                            })
                          }
                          className="h-3.5 w-3.5"
                        />
                        {vt.label}
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Add a section</CardTitle>
          <CardDescription>
            Sections an org adds are its own. The shipped set is a starting point.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AddSection
            existing={sections.map((s) => s.sectionKey)}
            onAdd={(s) => setSections((ss) => [...ss!, s])}
          />
        </CardContent>
      </Card>

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save as new version"}
        </Button>
        <p className="text-xs text-slate-500">
          Saving supersedes version {version}. Notes already started, signed or not, keep their version.
        </p>
      </div>
    </div>
  );
}

function AddSection({
  existing,
  onAdd,
}: {
  existing: string[];
  onAdd: (s: Section) => void;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<Kind>("prose");
  const key = keyOf(label);
  const clash = existing.includes(key);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex-1 min-w-[14rem]">
        <span className="block text-xs text-slate-600">Label</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Wound assessment"
          className="mt-1 w-full h-9 px-2 border border-slate-300 rounded-md text-sm"
        />
      </label>
      <label>
        <span className="block text-xs text-slate-600">Kind</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          className="mt-1 h-9 px-2 border border-slate-300 rounded-md text-sm"
        >
          <option value="prose">Rich text</option>
          <option value="list">List</option>
        </select>
      </label>
      <Button
        variant="secondary"
        disabled={label.trim() === "" || clash}
        onClick={() => {
          onAdd({
            sectionKey: key,
            label: label.trim(),
            helpText: null,
            kind,
            isRequired: false,
            notRequiredForVisitTypes: [],
          });
          setLabel("");
        }}
      >
        Add
      </Button>
      {clash && (
        <p className="text-xs text-amber-800 w-full">
          This org already has a section called <code>{key}</code>.
        </p>
      )}
    </div>
  );
}
