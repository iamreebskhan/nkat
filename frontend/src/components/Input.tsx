import type { InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';
import styles from './Input.module.css';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  hint?: string;
  error?: string;
  trailing?: ReactNode;
}

export function Input({ label, hint, error, trailing, id, ...rest }: InputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = hint || error ? `${inputId}-hint` : undefined;
  return (
    <label htmlFor={inputId} className={styles.field} data-error={Boolean(error) || undefined}>
      {label && <span className={styles.label}>{label}</span>}
      <span className={styles.box}>
        <input
          id={inputId}
          {...rest}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={hintId}
          className={styles.input}
        />
        {trailing && <span className={styles.trailing}>{trailing}</span>}
      </span>
      {(error || hint) && (
        <span id={hintId} className={styles.hint} role={error ? 'alert' : undefined}>
          {error ?? hint}
        </span>
      )}
    </label>
  );
}
