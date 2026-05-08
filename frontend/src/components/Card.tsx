import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Card.module.css';

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  meta?: ReactNode;
  /** Severity stripe: info (1px), warn (3px), error (6px). Strict B&W. */
  severity?: 'info' | 'warn' | 'error';
  children: ReactNode;
}

export function Card({ title, meta, severity, children, className, ...rest }: CardProps) {
  return (
    <section
      {...rest}
      className={[styles.card, severity ? styles[`sev_${severity}`] : '', className ?? ''].filter(Boolean).join(' ')}
    >
      {(title || meta) && (
        <header className={styles.head}>
          {title && <h3 className={styles.title}>{title}</h3>}
          {meta && <div className={styles.meta}>{meta}</div>}
        </header>
      )}
      <div className={styles.body}>{children}</div>
    </section>
  );
}
