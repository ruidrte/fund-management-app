import {
  Activity, FileText, LayoutDashboard, PieChart, ShieldCheck, Users, Wallet,
} from 'lucide-react';

export type PageId =
  | 'dashboard' | 'portfolio' | 'exposure' | 'investors'
  | 'reports' | 'quality' | 'esg';

interface Item {
  id: PageId;
  label: string;
  icon: typeof LayoutDashboard;
  hint: string;
}

const ITEMS: Item[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, hint: 'Performance and what moved' },
  { id: 'portfolio', label: 'Portfolio', icon: Wallet, hint: 'Holdings, gross of fees' },
  { id: 'exposure', label: 'Exposure', icon: PieChart, hint: 'Allocation and currency' },
  { id: 'investors', label: 'Investors', icon: Users, hint: 'Net, at product and LP level' },
  { id: 'reports', label: 'Reports', icon: FileText, hint: 'Predefined report layouts' },
  { id: 'quality', label: 'Data quality', icon: ShieldCheck, hint: 'Coverage and identity checks' },
  { id: 'esg', label: 'ESG', icon: Activity, hint: 'Sustainability metrics' },
];

export function Navigation({
  active, onChange,
}: { active: PageId; onChange: (page: PageId) => void }) {
  return (
    <nav
      className="w-56 shrink-0 border-r p-3"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
      aria-label="Sections"
    >
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {ITEMS.map((item) => {
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
  );
}
