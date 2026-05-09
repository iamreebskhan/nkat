/**
 * Layered-depth Card.
 *
 * Source: pallio_ui_playbook §1.2.
 *
 * True 3D (preserve-3d + rotateX/Y) silently flattens on any element
 * with overflow:hidden, opacity<1, or backdrop-filter. Dashboard cards
 * always have these. We use layered depth instead — border + ring +
 * shadow + small translateY on hover. Works in every browser, doesn't
 * trigger vestibular sensitivity.
 *
 * Always wrap motion in prefers-reduced-motion (handled globally in
 * `globals.css`, but the hover transform is also conservative).
 */
import { cn } from "@/lib/utils";

type Severity = "info" | "warn" | "error" | "success";

const SEVERITY_RING: Record<Severity, string> = {
  info: "ring-slate-900/5",
  warn: "ring-amber-600/30",
  error: "ring-red-600/40",
  success: "ring-emerald-600/30",
};

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Heightens border weight to telegraph severity without color overuse. */
  severity?: Severity;
  /** Disable the lift-on-hover affordance for static cards. */
  interactive?: boolean;
};

export function Card({
  className,
  severity = "info",
  interactive = false,
  ...rest
}: CardProps) {
  return (
    <div
      className={cn(
        "group relative rounded-xl bg-white shadow-sm border border-slate-200/70",
        "ring-1 ring-inset",
        SEVERITY_RING[severity],
        interactive &&
          "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:ring-slate-900/10",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 px-5 pt-5 pb-3 border-b border-slate-100",
        className,
      )}
      {...rest}
    />
  );
}

export function CardTitle({
  className,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-lg font-semibold tracking-tight text-slate-900", className)}
      {...rest}
    />
  );
}

export function CardDescription({
  className,
  ...rest
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-sm text-slate-600", className)} {...rest} />
  );
}

export function CardContent({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...rest} />;
}

export function CardFooter({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-5 py-3 border-t border-slate-100",
        className,
      )}
      {...rest}
    />
  );
}
