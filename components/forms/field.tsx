/**
 * Standard form field — single-column, blur-time validation, accessible.
 *
 * Source: pallio_ui_playbook §8.1 (form layout) + §8.2 (component shape).
 *
 *   - Mark required + optional explicitly (Baymard +32% completion).
 *   - 16px+ input font (`text-base`) prevents iOS zoom on focus.
 *   - On error: `aria-describedby` connects the alert to the input;
 *     ring + border in red-600 (4.5:1 on white).
 */
import { type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/ui/info-tip";

type FieldProps = {
  id: string;
  label: ReactNode;
  /**
   * Terse format guidance shown inline (e.g. "YYYY-MM-DD"). Keep it short —
   * anything that reads like a sentence belongs in `explain` instead.
   */
  hint?: ReactNode;
  /**
   * Longer explanation, revealed from an ⓘ next to the label on hover / focus
   * / click rather than sitting permanently under the field
   * (client walkthrough 01:16 — "us pe jab click karo to details aa jaate hain").
   */
  explain?: ReactNode;
  error?: string;
  required?: boolean;
  optional?: boolean;
  /**
   * Not required to save, but the feature won't work without it — e.g. the
   * insurance payer, which every coverage rule keys on. Marking these
   * "(optional)" undersells them and leaving them unmarked is inconsistent
   * (client walkthrough 00:34 — every field should carry a marker).
   */
  recommended?: boolean;
  children: ReactNode;
};

export function Field({
  id,
  label,
  hint,
  explain,
  error,
  required,
  optional,
  recommended,
  children,
}: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
        {required && (
          <>
            <span className="text-red-600 ml-0.5" aria-hidden>
              *
            </span>
            <span className="sr-only"> required</span>
          </>
        )}
        {optional && (
          <span className="text-slate-500 font-normal ml-1">(optional)</span>
        )}
        {recommended && !required && !optional && (
          <span className="text-[var(--color-brand-700)] font-normal ml-1">
            (recommended)
          </span>
        )}
        {explain && (
          <InfoTip label={typeof label === "string" ? `About ${label}` : "More information"}>
            {explain}
          </InfoTip>
        )}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="text-xs text-red-700 flex items-center gap-1"
        >
          {error}
        </p>
      )}
    </div>
  );
}

type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

/**
 * Standard text input. Default sizing + focus ring per playbook §8.2.
 */
export function TextInput({ invalid, className, ...rest }: TextInputProps) {
  return (
    <input
      {...rest}
      className={cn(
        "w-full h-10 px-3 rounded-md border bg-white text-base",
        "focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2",
        invalid
          ? "border-red-600 ring-1 ring-red-600"
          : "border-slate-300",
        className,
      )}
    />
  );
}

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
};

export function Select({ invalid, className, children, ...rest }: SelectProps) {
  return (
    <select
      {...rest}
      className={cn(
        "w-full h-10 px-3 rounded-md border bg-white text-base",
        "focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2",
        invalid ? "border-red-600 ring-1 ring-red-600" : "border-slate-300",
        className,
      )}
    >
      {children}
    </select>
  );
}

type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export function TextArea({ invalid, className, ...rest }: TextAreaProps) {
  return (
    <textarea
      {...rest}
      className={cn(
        "w-full px-3 py-2 rounded-md border bg-white text-base",
        "focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2",
        invalid ? "border-red-600 ring-1 ring-red-600" : "border-slate-300",
        className,
      )}
    />
  );
}
