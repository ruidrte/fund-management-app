/**
 * Each holding's own terms.
 *
 * The basis its multiple is agreed to sit on. A product reports on paid-in —
 * every unit the holding was paid, every unit that came back — and a holding
 * whose equalisations have made that figure say something nobody agrees it
 * means is carried on capital drawn instead: the calls net of what may be
 * called back, only the permanent distributions returned. The product's
 * multiple is then over the denominators applied, which is what the desk
 * publishes.
 *
 * Set here, kept with the holding in the book, written into the exported
 * workbook's snapshot and read back from it. Not a view: for a look at every
 * holding on one basis, the register has a selector that changes nothing.
 */

import { useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { useHoldingTerms } from '../../context/filing';
import type { Position } from '../../domain/types';
import { Card } from '../common/Card';
import { DataTable } from '../common/DataTable';

export function HoldingTerms() {
  const { holdings, vehicles, save, canSave, reason, destination } = useHoldingTerms();

  const [busy, setBusy] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [failure, setFailure] = useState<string>();

  const productOf = (position: Position) =>
    vehicles.find((v) => v.id === position.vehicleId)?.shortName ?? position.vehicleId;

  const commit = async (position: Position, basis: Position['reportingBasis']) => {
    setBusy(position.id);
    setFailure(undefined);
    setSaved(undefined);
    try {
      await save(position.id, basis);
      setSaved(
        `${position.name}: multiple now sits on ${basis === 'capital-drawn' ? 'drawdown, as the agreed exception' : 'paid-in, with the product'}. `
        + `Saved to ${destination ?? 'the book'}.`,
      );
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  if (holdings.length === 0) return null;

  return (
    <Card
      title="Each holding's own terms"
      subtitle="The basis its multiple is agreed to sit on"
      note="A product reports its multiples on paid-in: every unit a holding was paid, every unit
            that came back. A holding carried on drawdown is the agreed exception — the calls net
            of what may be called back, only the permanent distributions returned — and the
            product's multiple is then over the denominators applied. This is kept with the holding
            and written into the exported workbook, so the dashboard, the file and the desk's own
            history say the same thing."
    >
      {!canSave && (
        <p className="m-0 mb-3 flex items-start gap-2 text-xs" style={{ color: 'var(--status-warning)' }}>
          <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
          {reason} A change here would not survive a reload.
        </p>
      )}

      <DataTable
        rows={holdings}
        rowKey={(row) => row.id}
        dense
        columns={[
          { key: 'name', header: 'Holding', render: (row) => row.name },
          { key: 'product', header: 'Product', render: (row) => productOf(row) },
          { key: 'ccy', header: 'CCY', render: (row) => row.currency },
          {
            key: 'basis', header: 'Multiple sits on',
            render: (row) => (
              <select
                className="field w-56"
                value={row.reportingBasis === 'capital-drawn' ? 'capital-drawn' : 'paid-in'}
                disabled={!canSave || busy === row.id}
                onChange={(event) => void commit(
                  row, event.target.value === 'capital-drawn' ? 'capital-drawn' : 'paid-in',
                )}
              >
                <option value="paid-in">Paid-in — with the product</option>
                <option value="capital-drawn">Drawdown — agreed exception</option>
              </select>
            ),
          },
          {
            key: 'note', header: '',
            render: (row) => (row.reportingBasis === 'capital-drawn'
              ? (
                <span className="text-[11px]" style={{ color: 'var(--status-warning)' }}>
                  Calls net of recallable; permanent distributions only
                </span>
              )
              : <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Every unit paid, every unit back</span>),
          },
        ]}
      />

      {(saved || failure) && (
        <p className="mt-3 mb-0 flex items-start gap-1.5 text-xs"
          style={{ color: failure ? 'var(--status-critical)' : 'var(--status-good)' }}>
          {failure
            ? <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
            : <Check size={13} className="mt-px shrink-0" aria-hidden />}
          {failure ?? saved}
        </p>
      )}
    </Card>
  );
}
