/**
 * /onboarding — 5-step org onboarding wizard.
 *
 * Source: pallio_complete_vision_v3 §9.2.
 *
 *   1. Org profile  → POST /api/onboarding/profile
 *   2. Active states → POST /api/onboarding/states
 *   3. Active payers → POST /api/onboarding/payers
 *   4. CPT code set  → POST /api/onboarding/cpt-codes
 *   5. Rulebook path → /settings/rulebook with ?init=generate or ?init=upload
 *
 * The wizard reads + writes `onboarding_status`. Returning users land
 * on the first incomplete step.
 */
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/forms/field";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import {
  ORG_TYPES,
  type OnboardingStatusView,
  type OrgType,
} from "@/lib/features/onboarding/onboarding.types";

type RulebookPath = "generate" | "upload" | null;

const PALLIATIVE_CPT_DEFAULTS = [
  "99341", "99342", "99344", "99345",
  "99347", "99348", "99349", "99350",
  "G0318", "99417",
  "99497", "99498",
];

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

interface PayerOption {
  id: string;
  name: string;
  type: string;
  states: string[];
}

export default function OnboardingPage() {
  const router = useRouter();
  const [status, setStatus] = useState<OnboardingStatusView | null>(null);
  const [loading, setLoading] = useState(true);

  // Step 1 — profile
  const [orgName, setOrgName] = useState("");
  const [npi, setNpi] = useState("");
  const [orgType, setOrgType] = useState<OrgType>("palliative");
  const [customDomain, setCustomDomain] = useState("");
  const [notes, setNotes] = useState("");

  // Step 2 — states
  const [selectedStates, setSelectedStates] = useState<Set<string>>(new Set(["OH"]));

  // Step 3 — payers
  const [payerOptions, setPayerOptions] = useState<PayerOption[]>([]);
  const [selectedPayers, setSelectedPayers] = useState<Set<string>>(new Set());

  // Step 4 — CPT
  const [selectedCpts, setSelectedCpts] = useState<Set<string>>(
    new Set(PALLIATIVE_CPT_DEFAULTS),
  );

  // Step 5 — rulebook path
  const [rulebookPath, setRulebookPath] = useState<RulebookPath>(null);

  // Load onboarding status once.
  useEffect(() => {
    let abandoned = false;
    (async () => {
      try {
        const r = await fetch("/api/onboarding");
        const data = await r.json();
        if (abandoned) return;
        if (data.success) {
          const s = data.data as OnboardingStatusView;
          setStatus(s);
          if (s.activeStates.length > 0) setSelectedStates(new Set(s.activeStates));
          if (s.activePayerIds.length > 0) setSelectedPayers(new Set(s.activePayerIds));
          if (s.orgType) setOrgType(s.orgType);
          if (s.customDomain) setCustomDomain(s.customDomain);
          if (s.notes) setNotes(s.notes);
        }
      } catch {
        /* ok — wizard works fine starting fresh */
      } finally {
        if (!abandoned) setLoading(false);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, []);

  // Load payer options when entering step 3.
  async function loadPayers() {
    if (payerOptions.length > 0) return;
    try {
      const r = await fetch("/api/billing/payers");
      const data = await r.json();
      if (data.success) setPayerOptions(data.data.payers ?? []);
    } catch {
      /* surface on the step */
    }
  }

  async function postJson(path: string, body: unknown) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!data.success) throw new Error(data.error ?? "Save failed.");
    return data.data;
  }

  const visiblePayers = useMemo(() => {
    if (selectedStates.size === 0) return payerOptions;
    return payerOptions.filter((p) =>
      p.states.some((s) => selectedStates.has(s)),
    );
  }, [payerOptions, selectedStates]);

  const steps: WizardStep[] = [
    {
      key: "profile",
      title: "Organization profile",
      description: "Confirm your name, NPI, and org type. Custom domain is optional.",
      isValid: () => orgName.length >= 2 && npi.length === 10,
      render: () => (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field id="org" label="Organization name" required>
            <TextInput
              id="org"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
            />
          </Field>
          <Field id="npi" label="NPI" required hint="10 digits">
            <TextInput
              id="npi"
              value={npi}
              onChange={(e) => setNpi(e.target.value.replace(/\D/g, "").slice(0, 10))}
              className="tabular"
            />
          </Field>
          <Field id="type" label="Organization type" required>
            <Select
              id="type"
              value={orgType}
              onChange={(e) => setOrgType(e.target.value as OrgType)}
            >
              {ORG_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace("_", " ")}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="dom" label="Custom domain" optional hint="e.g. billing.acmehospice.com">
            <TextInput
              id="dom"
              value={customDomain}
              onChange={(e) => setCustomDomain(e.target.value.toLowerCase())}
              className="font-mono text-sm"
            />
          </Field>
          <div className="md:col-span-2">
            <Field id="notes" label="Notes" optional>
              <TextArea
                id="notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </div>
        </div>
      ),
    },
    {
      key: "states",
      title: "Active states",
      description: "Pick every state your org operates in. Drives payer suggestions.",
      isValid: () => selectedStates.size > 0,
      render: () => (
        <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
          {US_STATES.map((s) => {
            const sel = selectedStates.has(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSelectedStates((prev) => {
                    const next = new Set(prev);
                    if (next.has(s)) next.delete(s);
                    else next.add(s);
                    return next;
                  });
                }}
                className={`h-10 rounded-md text-sm font-mono tabular border transition-colors ${
                  sel
                    ? "bg-[var(--color-brand-600)] text-white border-[var(--color-brand-700)]"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                }`}
              >
                {s}
              </button>
            );
          })}
        </div>
      ),
    },
    {
      key: "payers",
      title: "Active payers",
      description:
        "Pick the insurance companies your patients use. Filtered by your active states.",
      isValid: () => selectedPayers.size > 0,
      render: () => (
        <div className="space-y-2">
          {payerOptions.length === 0 && (
            <p className="text-sm text-slate-500">
              Loading payers… (DB unavailable in dev returns an empty list).
            </p>
          )}
          {visiblePayers.length === 0 && payerOptions.length > 0 && (
            <p className="text-sm text-slate-500">
              No payers match the selected states.
            </p>
          )}
          <ul className="space-y-1">
            {visiblePayers.map((p) => {
              const sel = selectedPayers.has(p.id);
              return (
                <li key={p.id}>
                  <label
                    className={`flex items-center gap-3 px-3 py-2 rounded-md border cursor-pointer ${
                      sel
                        ? "bg-[var(--color-brand-50)] border-[var(--color-brand-600)]"
                        : "bg-white border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={sel}
                      onChange={(e) => {
                        setSelectedPayers((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(p.id);
                          else next.delete(p.id);
                          return next;
                        });
                      }}
                    />
                    <span className="flex-1 text-sm font-medium text-slate-900">
                      {p.name}
                    </span>
                    <span className="text-xs text-slate-500 capitalize">
                      {p.type.replace(/_/g, " ")}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ),
    },
    {
      key: "cpt",
      title: "CPT code set",
      description:
        "We pre-selected the palliative-care core set from Mark's cheat sheet. Deselect codes you don't bill.",
      isValid: () => selectedCpts.size > 0,
      render: () => (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {PALLIATIVE_CPT_DEFAULTS.map((c) => {
            const sel = selectedCpts.has(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setSelectedCpts((prev) => {
                    const next = new Set(prev);
                    if (next.has(c)) next.delete(c);
                    else next.add(c);
                    return next;
                  });
                }}
                className={`h-12 rounded-md text-sm font-mono tabular border ${
                  sel
                    ? "bg-[var(--color-brand-600)] text-white border-[var(--color-brand-700)]"
                    : "bg-white text-slate-700 border-slate-300"
                }`}
              >
                {c}
              </button>
            );
          })}
        </div>
      ),
    },
    {
      key: "rulebook",
      title: "Billing rulebook",
      description:
        "Choose how to set up your billing rulebook. You can edit it any time after.",
      isValid: () => rulebookPath !== null,
      render: () => (
        <div className="space-y-3">
          <PathChoice
            label="Generate from sources"
            sub="Pallio queries every payer × state × CPT combo and builds your rulebook automatically. Fastest path — recommended."
            selected={rulebookPath === "generate"}
            onClick={() => setRulebookPath("generate")}
          />
          <PathChoice
            label="Upload our existing rulebook"
            sub="Upload a PDF / DOCX / XLSX. Pallio compares it against the source library and surfaces any differences for you to resolve."
            selected={rulebookPath === "upload"}
            onClick={() => setRulebookPath("upload")}
          />
        </div>
      ),
    },
  ];

  async function complete() {
    // Step 1
    await postJson("/api/onboarding/profile", {
      name: orgName,
      npi,
      orgType,
      customDomain: customDomain || undefined,
      notes: notes || undefined,
    });
    // Step 2
    await postJson("/api/onboarding/states", { states: Array.from(selectedStates) });
    // Step 3
    await postJson("/api/onboarding/payers", {
      payerIds: Array.from(selectedPayers),
    });
    // Step 4
    await postJson("/api/onboarding/cpt-codes", {
      cptCodes: Array.from(selectedCpts),
    });
    // Step 5 — redirect to rulebook editor with init param.
    router.push(`/settings/rulebook?init=${rulebookPath ?? "generate"}`);
  }

  // Trigger payer load when reaching step 3 — cheap enough to call eagerly.
  useEffect(() => {
    void loadPayers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="px-8 py-8 text-slate-500">Loading…</div>;

  return (
    <div className="px-8 py-8 max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Welcome to Pallio</h1>
        <p className="text-slate-600 mt-1">
          Five steps. Five minutes. You&rsquo;ll have a working billing rulebook
          when you finish.
        </p>
      </header>

      {status?.completedAt && (
        <p className="mb-4 px-3 py-2 rounded-md bg-emerald-50 ring-1 ring-inset ring-emerald-600/20 text-sm text-emerald-800">
          You&rsquo;ve already completed onboarding — feel free to revisit any step.
        </p>
      )}

      <Wizard
        steps={steps}
        onCancel={() => router.push("/")}
        onComplete={complete}
        finishLabel="Build rulebook"
      />
    </div>
  );
}

function PathChoice({
  label,
  sub,
  selected,
  onClick,
}: {
  label: string;
  sub: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full text-left px-4 py-3 rounded-lg border transition-all ${
        selected
          ? "bg-[var(--color-brand-50)] border-[var(--color-brand-600)] ring-2 ring-[var(--color-brand-600)]/20"
          : "bg-white border-slate-200 hover:border-slate-300"
      }`}
    >
      <div className="font-medium text-slate-900">{label}</div>
      <div className="text-sm text-slate-600 mt-1">{sub}</div>
    </button>
  );
}
