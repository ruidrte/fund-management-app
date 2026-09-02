import {
  Activity, CalendarCheck, DatabaseZap, Download, FileText, HardDrive, KeyRound,
  LayoutDashboard, PieChart, ShieldCheck, Users, Wallet,
} from 'lucide-react';

export type PageId =
  | 'dashboard' | 'portfolio' | 'exposure' | 'investors'
  | 'reports' | 'quality' | 'esg' | 'intake' | 'export' | 'close' | 'storage' | 'access';

import { useAuth } from '../../context/AuthContext';
import type { Capability } from '../../auth/permissions';

interface Item {
  id: PageId;
  label: string;
  icon: typeof LayoutDashboard;
  hint: string;
  /** The capability that opens this section. Absent means everyone. */
  needs?: Capability;
}

const ITEMS: Item[] = [
  { id: 'close', label: 'The close', icon: CalendarCheck, hint: 'Every product, this quarter' },
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, hint: 'Performance and what moved' },
  { id: 'portfolio', label: 'Portfolio', icon: Wallet, hint: 'Holdings, gross of fees' },
  { id: 'exposure', label: 'Exposure', icon: PieChart, hint: 'Allocation and currency' },
  { id: 'investors', label: 'Investors', icon: Users, hint: 'Net, at product and LP level' },
  { id: 'reports', label: 'Reports', icon: FileText, hint: 'Predefined report layouts', needs: 'reports.generate' },
  { id: 'quality', label: 'Data quality', icon: ShieldCheck, hint: 'Coverage and identity checks', needs: 'audit.read' },
  { id: 'intake', label: 'Data intake', icon: DatabaseZap, hint: 'Load documents and events', needs: 'documents.upload' },
  { id: 'export', label: 'Export', icon: Download, hint: 'Historical extract', needs: 'export' },
  { id: 'esg', label: 'ESG', icon: Activity, hint: 'Sustainability metrics', needs: 'esg.read' },
  { id: 'storage', label: 'Storage', icon: HardDrive, hint: 'Where the data lives' },
  { id: 'access', label: 'Access', icon: KeyRound, hint: 'Roles and what they permit' },
];

export function Navigation({
  active, onChange, clientId,
}: { active: PageId; onChange: (page: PageId) => void; clientId?: string }) {
  const { can } = useAuth();

  // A section the role cannot open is removed rather than shown disabled. A
  // permanently dead item in a sidebar is noise; the Access page is where the
  // full list and the reason live.
  const items = ITEMS.filter((item) => !item.needs || can(item.needs, { clientId }));

  return (
    <>
      <nav
        className="hidden w-56 shrink-0 border-r p-3 md:block"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
        aria-label="Sections"
      >
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {items.map((item) => {
            const Icon = item.icon;
            const selected = item.id === active;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onChange(item.id)}
                  aria-current={selected ? 'page' : undefined}
                  className="flex w-full items-start gap-2.5 rounded px-2.5 py-2 text-left transition-colors"
                  style={{
                    background: selected ? 'var(--surface-2)' : 'transparent',
                    color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                >
                  <Icon size={15} className="mt-0.5 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{item.label}</span>
                    <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {item.hint}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/*
        On a narrow screen the sidebar is not a sidebar. Two hundred and
        twenty-four pixels of it left a hundred and sixty-six for the figures,
        which wrapped one word to a line. A scrolling row of chips costs a
        gesture and gives the width back.
      */}
      <nav
        className="md:hidden"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-1)' }}
        aria-label="Sections"
      >
        <ul className="scroll-x m-0 flex list-none gap-1 p-2">
          {items.map((item) => {
            const Icon = item.icon;
            const selected = item.id === active;
            return (
              <li key={item.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => onChange(item.id)}
                  aria-current={selected ? 'page' : undefined}
                  title={item.hint}
                  className="flex items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1.5 text-xs"
                  style={{
                    background: selected ? 'var(--surface-2)' : 'transparent',
                    color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: selected ? 600 : 400,
                    boxShadow: selected ? 'inset 0 -2px 0 0 var(--series-1)' : 'none',
                  }}
                >
                  <Icon size={14} aria-hidden />
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
