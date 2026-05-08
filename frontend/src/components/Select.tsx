import type { SelectHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';
import styles from './Input.module.css';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

export function Select({ label, hint, error, id, children, ...rest }: SelectProps) {
  const auto = useId();
  const sid = id ?? auto;
  const hintId = hint || error ? `${sid}-hint` : undefined;
  return (
    <label htmlFor={sid} className={styles.field} data-error={Boolean(error) || undefined}>
      {label && <span className={styles.label}>{label}</span>}
      <span className={styles.box}>
        <select
          id={sid}
          {...rest}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={hintId}
          className={styles.input}
        >
          {children}
        </select>
        <span className={styles.trailing} aria-hidden>▾</span>
      </span>
      {(error || hint) && (
        <span id={hintId} className={styles.hint} role={error ? 'alert' : undefined}>
          {error ?? hint}
        </span>
      )}
    </label>
  );
}
