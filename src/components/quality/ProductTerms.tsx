/**
 * Each product's own terms.
 *
 * The currency it reports in, and what its investors subscribed. Neither is a
 * view setting: a fund's financial statements, capital accounts and every
 * figure its investors read are stated in that currency, and the total
 * subscribed is what the register of investors has to add up to — a total
 * larger than the register makes the engine read the register as incomplete
 * and refuse to allocate the last unit of net asset value to anybody.
 *
 * Both belong to the product and are kept in the book with it, so correcting
 * one is a change somebody makes here rather than a new version of the
 * application and a rebuilt book.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Coins, Save } from 'lucide-react';
import { useProductTerms } from '../../context/filing';
import { useScope } from '../../context/ScopeContext';
import type { CurrencyCode, Vehicle } from '../../domain/types';
import { Card } from '../common/Card';
import { DataTable } from '../common/DataTable';

/** Offered everywhere, so a product can be set to a currency the book has not
 *  seen yet — the first import in it should not have to come first. */
const MAJORS: CurrencyCode[] = ['EUR', 'CHF', 'USD', 'GBP', 'SEK', 'DKK', 'NOK', 'AUD', 'CAD', 'JPY'];

export function ProductTerms() {
  const { currencies, currency: simulated } = useScope();
  const { vehicles, save, canSave, reason, destination } = useProductTerms();

  const [busy, setBusy] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [failure, setFailure] = useState<string>();
  // Kept per product while it is being typed in, so a half-entered number is
  // not read as the new total on every keystroke.
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    setDraft(Object.fromEntries(vehicles.map((v) => [v.id, String(v.investorCommitment)])));
  }, [vehicles]);

  const choices = [...new Set([...MAJORS, ...currencies])];

  const commit = async (vehicle: Vehicle, terms: Parameters<typeof save>[1], what: string) => {
    setBusy(vehicle.id);
    setFailure(undefined);
    setSaved(undefined);
    try {
      await save(vehicle.id, terms);
      setSaved(`${vehicle.name}: ${what}. Saved to ${destination ?? 'the book'}.`);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const saveCommitment = (vehicle: Vehicle) => {
    const next = Number(draft[vehicle.id]);
    if (!Number.isFinite(next) || next < 0 || next === vehicle.investorCommitment) return;
    void commit(
      vehicle,
      { investorCommitment: next },
      `subscribed total is now ${next.toLocaleString('en-GB')} ${vehicle.currency}`,
    );
  };

  return (
    <Card
      title="Each product's own terms"
      subtitle="Set once, kept with the product"
      note="Every figure a product publishes is stated in its currency: its net asset value, its
            capital accounts, its multiples. Changing it restates the whole history rather than
            converting a total, because each holding is translated at the rate of its own quarter.
            The subscribed total is what the investor register has to reconcile to."
    >
      {!canSave && (
        <p className="m-0 mb-3 flex items-start gap-2 text-xs" style={{ color: 'var(--status-warning)' }}>
          <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
          {reason} A change here would not survive a reload.
        </p>
      )}

      <DataTable
        rows={vehicles}
        rowKey={(row) => row.id}
        dense
        columns={[
          { key: 'name', header: 'Product', render: (row) => row.name },
          {
            key: 'currency', header: 'Reports in',
            render: (row) => (
              <select
                className="field w-24"
                value={row.currency}
                disabled={!canSave || busy === row.id}
                onChange={(event) => void commit(
                  row,
                  { currency: event.target.value as CurrencyCode },
                  `now reports in ${event.target.value}`,
                )}
              >
                {choices.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            ),
          },
          {
            key: 'commitment', header: 'Subscribed in total', align: 'right',
            render: (row) => (
              <span className="flex items-center justify-end gap-1.5">
                <input
                  type="number" className="field w-32 text-right" min={0}
                  value={draft[row.id] ?? ''}
                  disabled={!canSave || busy === row.id}
                  onChange={(event) => setDraft(
                    (current) => ({ ...current, [row.id]: event.target.value }),
                  )}
                  onBlur={() => saveCommitment(row)}
                  onKeyDown={(event) => { if (event.key === 'Enter') saveCommitment(row); }}
                />
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {row.currency}
                </span>
                {Number(draft[row.id]) !== row.investorCommitment && (
                  <Save size={12} aria-hidden style={{ color: 'var(--status-warning)' }} />
                )}
              </span>
            ),
          },
          {
            key: 'shown', header: 'Currently shown in',
            render: (row) => (simulated && simulated !== row.currency
              ? (
                <span className="flex items-center gap-1.5" style={{ color: 'var(--status-warning)' }}>
                  <Coins size={12} aria-hidden /> {simulated} — translated
                </span>
              )
              : <span style={{ color: 'var(--text-muted)' }}>{row.currency}</span>),
          },
        ]}
      />

      <p className="mt-2 mb-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        The subscribed total saves when you leave the field or press Enter.
      </p>

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
