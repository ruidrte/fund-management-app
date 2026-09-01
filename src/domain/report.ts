/**
 * The report contract.
 *
 * What a report is made of, and how a client's own pack differs from the next
 * one's. Types only, and no dependency on the engine or the renderer: a layout
 * is data that travels with a client's book, and the domain is where data that
 * travels lives.
 */

import type { VehicleKind } from './types';

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
  appliesTo: VehicleKind[];
  sections: Section[];
  /** Set on layouts that belong to a client rather than to the application. */
  clientId?: string;
}

/**
 * How a client's reports look and read.
 *
 * The engine is the same for every product; the pack that reaches a limited
 * partner is not. One client's report opens with a letter and closes with a
 * disclaimer their legal team wrote, another wants the register first and no
 * prose at all. Keeping that as data — carried in the client's own book, beside
 * the figures — means a new client is a new profile rather than a new build.
 */
export interface Branding {
  /** Whose report this is, on the cover and in the footer. */
  house?: string;
  /** A hex colour used for rules, headings and chart bars. */
  accent?: string;
  /** Standing text at the foot of every page — a disclaimer, usually. */
  footerNote?: string;
  /** Prose under the cover title. */
  coverNote?: string;
}

export interface ReportingProfile {
  branding?: Branding;
  /** Layouts belonging to this client, offered alongside the built-in ones. */
  layouts: ReportLayout[];
  /** The one to preselect — a client's own LP pack, usually. */
  defaultLayoutId?: string;
}

/** An empty profile, so a client without one behaves like a client with one. */
export const NO_PROFILE: ReportingProfile = { layouts: [] };

/** Every section, in the order a report would normally use them. */
export const SECTION_ORDER: SectionId[] = [
  'cover', 'summary', 'kpi-net', 'kpi-gross', 'product-bridge', 'nav-components',
  'nav-bridge', 'commitments-bridge', 'drivers', 'allocation', 'currency',
  'look-through', 'portfolio-register', 'capital-accounts', 'coverage', 'checks',
  'conventions',
];

export const SECTION_LABEL: Record<SectionId, string> = {
  cover: 'Cover',
  summary: 'The quarter in a sentence',
  'kpi-gross': 'Gross performance',
  'kpi-net': 'Net performance',
  'nav-bridge': 'Portfolio NAV bridge',
  'commitments-bridge': 'Commitments bridge',
  'product-bridge': 'Product NAV bridge',
  'nav-components': 'Composition of net asset value',
  'portfolio-register': 'Portfolio register',
  drivers: 'What moved the quarter',
  allocation: 'Allocation',
  currency: 'Currency exposure',
  'look-through': 'Look-through exposure',
  'capital-accounts': 'Capital accounts',
  coverage: 'Data coverage',
  checks: 'Identity checks',
  conventions: 'Basis of preparation',
};

