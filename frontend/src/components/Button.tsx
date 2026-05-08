/**
 * Button — three variants, all in B&W.
 *
 *   primary   — solid black bg, white fg. The default.
 *   secondary — white bg, black bg+fg border 1px.
 *   ghost     — no border, underlines on hover.
 *
 * Three sizes (sm/md/lg). One state (disabled). Loading spinner is a
 * spinning ASCII bar rather than an SVG to stay true to the brutalist
 * theme.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  block = false,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={[
        styles.btn,
        styles[`v_${variant}`],
        styles[`s_${size}`],
        block ? styles.block : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      aria-busy={loading || undefined}
    >
      {loading && <Spinner />}
      <span>{children}</span>
    </button>
  );
}

function Spinner() {
  return <span className={styles.spinner} aria-hidden>|/—\</span>;
}
