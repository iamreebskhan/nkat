import type { ReactNode } from 'react';
import styles from './Table.module.css';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  width?: string;
  /** Renders the cell with monospace + dim color (for ids, timestamps). */
  mono?: boolean;
  /** Right-align (counts, amounts). */
  align?: 'left' | 'right';
}

export function Table<T>({ rows, columns, empty }: { rows: T[]; columns: Column<T>[]; empty?: ReactNode }) {
  if (rows.length === 0) {
    return <div className={styles.empty}>{empty ?? 'No items.'}</div>;
  }
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} style={{ width: c.width, textAlign: c.align ?? 'left' }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c, j) => (
                <td
                  key={j}
                  className={c.mono ? styles.mono : undefined}
                  style={{ textAlign: c.align ?? 'left' }}
                >
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
