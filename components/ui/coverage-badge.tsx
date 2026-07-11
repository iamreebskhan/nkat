/**
 * CoverageBadge — billing rule coverage status pill.
 *
 * Source: pallio_ui_playbook §5 (status indicators).
 *
 * Color alone fails for ~8% of male users (color blindness). Every
 * badge combines icon + color + text label — three of the four Carbon
 * elements. Do not strip the icon or the label "for cleanliness".
 */
import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";

export type CoverageStatus = "covered" | "not_covered" | "varies" | "unknown";

const STATUS_MAP: Record<
  CoverageStatus,
  {
    label: string;
    icon: typeof CheckCircle2;
    cls: string;
  }
> = {
  covered: {
    label: "Covered",
    icon: CheckCircle2,
    cls: "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-600/20",
  },
  not_covered: {
    label: "Not covered",
    icon: XCircle,
    cls: "bg-red-50 text-red-800 ring-1 ring-inset ring-red-600/20",
  },
  varies: {
    label: "Varies by plan",
    icon: AlertTriangle,
    cls: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/30",
  },
  unknown: {
    label: "Unknown",
    icon: HelpCircle,
    cls: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-600/20",
  },
};

type Props = {
  status: CoverageStatus;
  size?: "sm" | "md";
  /** Override the default label (e.g. "Pending review") while keeping the icon + color. */
  label?: string;
};

export function CoverageBadge({ status, size = "md", label }: Props) {
  const s = STATUS_MAP[status];
  const Icon = s.icon;
  return (
    <span
      role="status"
      aria-label={label ?? s.label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md font-medium tabular",
        size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-sm",
        s.cls,
      )}
    >
      <Icon
        className={cn(size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")}
        aria-hidden
      />
      {label ?? s.label}
    </span>
  );
}

