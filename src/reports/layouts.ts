/**
 * Report layouts.
 *
 * A layout is a declaration of which sections appear, in what order, with what
 * prose — never a bespoke renderer. A new report is a new layout; a new fund is
 * a new dataset. If a fund needs a section the layouts cannot express, the fix
 * is a new section type here, not a special case in the renderer.
 */

import type { QuarterView } from '../engine';

export type SectionId =
  | 'cover'
  | 'summary'
  | 'kpi-gross'
  | 'kpi-net'
  | 'nav-bridge'
  | 'commitments-bridge'
  | 'product-bridge'
  | 'nav-components'
  | 'portfolio-register'
  | 'drivers'
  | 'allocation'
  | 'currency'
  | 'look-through'
  | 'capital-accounts'
  | 'coverage'
  | 'checks'
  | 'conventions';

export interface Section {
  id: SectionId;
  /** Overrides the section's default heading. */
  title?: string;
  /** Prose placed above the section's content. */
  intro?: string;
}

export interface ReportLayout {
  id: string;
  name: string;
  description: string;
  /** Vehicle kinds the layout is meant for; empty means any. */
  appliesTo: Array<'fund-of-funds' | 'direct-fund'>;
  sections: Section[];
}

export const LAYOUTS: ReportLayout[] = [
  {
    id: 'quarterly-investor',
    name: 'Quarterly investor report',
    description:
      'The standard quarterly pack: performance at both tiers, what moved, where the money is, and the controls behind the figures.',
    appliesTo: [],
    sections: [
      { id: 'cover' },
      { id: 'summary', title: 'The quarter at a glance' },
      { id: 'kpi-net', title: 'Net performance', intro: 'The investor’s position in the vehicle, after management fees, expenses and any carried interest.' },
      { id: 'kpi-gross', title: 'Gross performance', intro: 'The underlying portfolio measured on its own terms. The gross and net tiers do not tie to each other and are not meant to.' },
      { id: 'product-bridge', title: 'Movement in net asset value' },
      { id: 'nav-components', title: 'Composition of net asset value' },
      { id: 'nav-bridge', title: 'Movement in portfolio value' },
      { id: 'commitments-bridge', title: 'Movement in undrawn commitments' },
      { id: 'allocation', title: 'Portfolio allocation' },
      { id: 'currency', title: 'Currency exposure' },
      { id: 'portfolio-register', title: 'Portfolio register' },
      { id: 'coverage', title: 'Data coverage' },
      { id: 'conventions', title: 'Basis of preparation' },
    ],
  },
  {
    id: 'quarterly-monitoring',
    name: 'Internal monitoring pack',
    description:
      'The desk’s working view: drivers, the full register, coverage and every identity check, with nothing softened for an external reader.',
    appliesTo: [],
    sections: [
      { id: 'cover' },
      { id: 'summary' },
      { id: 'coverage', title: 'What has and has not reported', intro: 'Read this before anything below it. Every figure in this pack inherits the weakest input on this page.' },
      { id: 'kpi-gross' },
      { id: 'nav-bridge' },
      { id: 'drivers', title: 'What moved the quarter' },
      { id: 'portfolio-register' },
      { id: 'commitments-bridge' },
      { id: 'allocation' },
      { id: 'look-through', title: 'Look-through exposure' },
      { id: 'currency' },
      { id: 'checks', title: 'Identity checks' },
      { id: 'conventions' },
    ],
  },
  {
    id: 'lp-statement',
    name: 'Investor capital accounts',
    description:
      'One page per vehicle listing every investor’s capital account, with allocated accounts marked as approximations.',
    appliesTo: [],
    sections: [
      { id: 'cover' },
      { id: 'kpi-net' },
      { id: 'nav-components' },
      { id: 'capital-accounts', title: 'Capital accounts' },
      { id: 'product-bridge' },
      { id: 'conventions' },
    ],
  },
  {
    id: 'direct-fund-quarterly',
    name: 'Direct fund quarterly',
    description:
      'For a vehicle holding assets directly: no undrawn-commitment section, and exposure measured on the assets themselves.',
    appliesTo: ['direct-fund'],
    sections: [
      { id: 'cover' },
      { id: 'summary' },
      { id: 'kpi-net' },
      { id: 'kpi-gross', title: 'Portfolio performance' },
      { id: 'product-bridge' },
      { id: 'nav-bridge', title: 'Movement in portfolio value' },
      { id: 'portfolio-register', title: 'Investments' },
      { id: 'look-through' },
      { id: 'currency' },
      { id: 'coverage' },
      { id: 'conventions' },
    ],
  },
];

export function layoutsFor(view: QuarterView | undefined): ReportLayout[] {
  const kind = view?.vehicles[0]?.kind;
  if (!kind) return LAYOUTS;
  return LAYOUTS.filter((layout) => layout.appliesTo.length === 0 || layout.appliesTo.includes(kind));
}

export function findLayout(id: string): ReportLayout | undefined {
  return LAYOUTS.find((layout) => layout.id === id);
}
