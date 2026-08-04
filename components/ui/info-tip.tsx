/**
 * InfoTip — an ⓘ affordance that reveals an explanation on hover, focus or
 * click.
 *
 * Client walkthrough [01:16–01:24]: "to woh jo icon hai… us pe jab click karo
 * to phir details aa jaate hain" — and [02:03] about the inline consent
 * explanation: "is ko hi remove kar dena, taake koi is par hover kare to phir
 * aayein." Long explanations shouldn't sit permanently under every field; they
 * should be one gesture away.
 *
 * Accessibility: it's a real <button> (keyboard reachable), the panel is
 * role="tooltip" and wired via aria-describedby, hover AND focus both open it,
 * and Escape closes it. Touch users get it on tap since click toggles.
 */
"use client";

import { useId, useState } from "react";

export function InfoTip({
  label,
  children,
}: {
  /** Accessible name, e.g. "About telehealth consent". */
  label: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex items-center align-middle">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 text-[10px] font-semibold leading-none text-slate-500 hover:border-slate-400 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
      >
        i
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-5 top-0 z-30 w-64 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-normal leading-relaxed text-slate-700 shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}
