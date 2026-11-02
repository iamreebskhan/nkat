/**
 * A password field with an eye, so what was typed can be checked before it
 * counts. Caps Lock cost five refused sign-ins and the lock that follows them
 * (lib/features/auth/login-throttle.ts), with nothing on screen to show why.
 *
 * Back to dots when the form is sent, and while the field is read-only: login
 * keeps the password on screen behind its code step, and a browser may remember
 * what was in a text field where it never would for a password field.
 */
"use client";

import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";

type Props = Omit<ComponentProps<"input">, "type">;

export function PasswordInput({ className = "", readOnly, ...rest }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const hide = () => setShown(false);
    form.addEventListener("submit", hide);
    return () => form.removeEventListener("submit", hide);
  }, []);

  return (
    <div className="relative">
      <input
        {...rest}
        ref={input}
        readOnly={readOnly}
        type={shown && !readOnly ? "text" : "password"}
        className={`${className} pr-10`}
      />
      {!readOnly && (
        <button
          type="button"
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-md text-slate-500 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2"
        >
          {shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      )}
    </div>
  );
}
