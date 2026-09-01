import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
  /** Rendered in the footer row when present. */
  total?: ReactNode;
}

export function DataTable<T>({
  columns, rows, rowKey, emptyMessage = 'Nothing to show for this scope.', dense = false,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  emptyMessage?: string;
  dense?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>{emptyMessage}</p>;
  }

  const hasTotals = columns.some((c) => c.total !== undefined);
  const pad = dense ? 'px-2 py-1' : 'px-3 py-2';

  return (
    <div className="scroll-x">
      <table className="w-full text-xs tabular">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`${pad} font-medium ${column.align === 'right' ? 'text-right' : 'text-left'}`}
                style={{ color: 'var(--text-secondary)' }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row, index)} style={{ borderBottom: '1px solid var(--border)' }}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`${pad} ${column.align === 'right' ? 'text-right' : 'text-left'}`}
                  style={{ color: 'var(--text-primary)' }}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {hasTotals && (
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border-strong)' }}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`${pad} font-semibold ${column.align === 'right' ? 'text-right' : 'text-left'}`}
                  style={{ color: 'var(--text-primary)' }}
                >
                  {column.total ?? ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
