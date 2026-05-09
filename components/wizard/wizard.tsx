/**
 * Multi-step wizard shell.
 *
 * Source: pallio_ui_playbook §10.1 + §10.2.
 *
 *   - Progress bar starts at 20% on step 1 (Zeigarnik effect, +30-50%
 *     completion).
 *   - Cancel always visible top-right (forced wizards churn users).
 *   - Skip rendered as a ghost button when the step is optional.
 *   - Back disabled on step 0; Next becomes "Get started" on the last step.
 *
 * Designed for the 5-step patient intake flow (vision §6.2) but
 * generic enough for the org onboarding wizard later (Phase 5).
 */
"use client";

import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";

export type WizardStep = {
  key: string;
  title: string;
  description?: string;
  optional?: boolean;
  /**
   * Closure over the consumer's form state — returns true when the
   * step's required fields are filled. Wizard polls this each render
   * to enable/disable the Next button. NEVER call setState here; this
   * runs during render.
   */
  isValid?: () => boolean;
  /** Renders the step body. */
  render: () => ReactNode;
};

type WizardProps = {
  steps: WizardStep[];
  onCancel: () => void;
  onComplete: () => Promise<void> | void;
  finishLabel?: string;
  /** Optional className applied to the dialog content wrapper. */
  className?: string;
};

export function Wizard({
  steps,
  onCancel,
  onComplete,
  finishLabel = "Get started",
}: WizardProps) {
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = steps.length;
  const current = steps[step]!;
  const isLast = step === total - 1;
  // Optional steps are always next-able; required steps poll isValid().
  const stepValid = current.optional ? true : (current.isValid?.() ?? true);

  // Progress: 20% on step 1, then ramp to 100% on the final step's
  // completion. (Renders 100% only after onComplete resolves, but
  // visual at last step lands at ~96% for "almost there" feel.)
  const progress = total <= 1 ? 100 : 20 + (step / (total - 1)) * 80;

  async function next() {
    setError(null);
    if (isLast) {
      setSubmitting(true);
      try {
        await onComplete();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Completion failed.");
      } finally {
        setSubmitting(false);
      }
      return;
    }
    setStep((s) => Math.min(s + 1, total - 1));
  }

  function back() {
    setError(null);
    setStep((s) => Math.max(s - 1, 0));
  }

  function skip() {
    if (!current.optional) return;
    next();
  }

  return (
    <div
      role="dialog"
      aria-labelledby="wizard-title"
      className="bg-white rounded-xl shadow-lg ring-1 ring-slate-900/5 max-w-2xl mx-auto p-6"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-slate-600 tabular">
          Step {step + 1} of {total}
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <div
        className="h-1.5 bg-slate-200 rounded-full overflow-hidden mb-5"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div
          className="h-full bg-[var(--color-brand-600)] transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      <header className="mb-4">
        <h2
          id="wizard-title"
          className="font-display text-2xl tracking-tight text-slate-900"
        >
          {current.title}
        </h2>
        {current.description && (
          <p className="text-sm text-slate-600 mt-1">{current.description}</p>
        )}
      </header>

      <div className="py-2 min-h-[280px]">{current.render()}</div>

      {error && (
        <p
          role="alert"
          className="mt-4 text-sm text-red-700 bg-red-50 px-3 py-2 rounded-md ring-1 ring-inset ring-red-600/20"
        >
          {error}
        </p>
      )}

      <div className="mt-6 flex justify-between items-center">
        <div>
          {current.optional ? (
            <Button variant="ghost" onClick={skip}>
              Skip for now
            </Button>
          ) : (
            <span aria-hidden />
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={back}
            disabled={step === 0 || submitting}
          >
            Back
          </Button>
          <Button onClick={next} loading={submitting} disabled={!stepValid}>
            {isLast ? finishLabel : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
