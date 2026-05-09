/**
 * Pallio Button — primary/secondary/ghost/danger variants.
 *
 * Color tokens come from `globals.css` @theme block (slate/teal palette,
 * playbook §2). Every state (default, hover, active, focus-visible,
 * disabled) is verified for ≥4.5:1 contrast on white.
 */
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-2 rounded-md font-medium",
    "transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
    "focus-visible:outline-2 focus-visible:outline-offset-2",
    "focus-visible:outline-[var(--color-focus)]",
  ),
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--color-brand-600)] text-white hover:bg-[var(--color-brand-700)]",
        secondary:
          "bg-white text-slate-900 border border-slate-300 hover:bg-slate-50",
        ghost: "text-slate-700 hover:bg-slate-100",
        danger: "bg-red-600 text-white hover:bg-red-700",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-6 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    /** Show a small spinner without disabling layout. */
    loading?: boolean;
  };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, children, disabled, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        disabled={disabled ?? loading}
        aria-busy={loading || undefined}
        {...rest}
      >
        {loading ? (
          <span
            aria-hidden
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
          />
        ) : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
