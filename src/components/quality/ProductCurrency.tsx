/**
 * The currency each product reports in.
 *
 * Not a view setting. A fund's reporting currency is the currency of its
 * financial statements, its capital accounts and every figure its investors
 * read, so it belongs to the product and is kept in the book with it. Setting
 * it here fixes the basis; the currency selector on the scope bar then
 * translates away from that basis, and is labelled as the simulation it is.
 */

import { useState } from 'react';
import { AlertTriangle, Check, Coins } from 'lucide-react';
import { useProductCurrency } from '../../context/filing';
import { useScope } from '../../context/ScopeContext';
import type { CurrencyCode } from '../../domain/types';
import { Card } from '../common/Card';
import { DataTable } from '../common/DataTable';

/** Offered everywhere, so a product can be set to a currency the book has not
 *  seen yet — the first import in it should not have to come first. */
const MAJORS: CurrencyCode[] = ['EUR', 'CHF', 'USD', 'GBP', 'SEK', 'DKK', 'NOK', 'AUD', 'CAD', 'JPY'];

export function ProductCurrency() {
  const { currencies, currency: simulated } = useScope();
  const { vehicles, save, canSave, reason, destination } = useProductCurrency();

  const [busy, setBusy] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [failure, setFailure] = useState<string>();

  const choices = [...new Set([...MAJORS, ...currencies])];

  const change = async (vehicleId: string, next: CurrencyCode) => {
    setBusy(vehicleId);
    setFailure(undefined);
    setSaved(undefined);
    try {
      await save(vehicleId, next);
      const name = vehicles.find((v) => v.id === vehicleId)?.name ?? 'The product';
      setSaved(`${name} now reports in ${next}. Saved to ${destination ?? 'the book'}.`);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card
      title="The currency each product reports in"
      subtitle="Set once, kept with the product"
      note="Every figure a product publishes is stated in this currency: its net asset value, its
            capital accounts, its multiples. Changing it restates the whole history rather than
            converting a total, because each holding is translated at the rate of its own quarter."
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
            key: 'kind', header: 'What it is',
            render: (row) => (row.kind === 'fund-of-funds' ? 'Fund of funds' : 'Direct fund'),
          },
          {
            key: 'currency', header: 'Reports in',
            render: (row) => (
              <span className="flex items-center gap-1.5">
                <select
                  className="field w-24"
                  value={row.currency}
                  disabled={!canSave || busy === row.id}
                  onChange={(event) => void change(row.id, event.target.value as CurrencyCode)}
                >
                  {choices.map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
                {busy === row.id && (
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>saving…</span>
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
