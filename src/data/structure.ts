/**
 * The real structure: which clients exist, and what each one runs.
 *
 * Names, currencies, domiciles and administrators — the facts that identify a
 * product — and nothing that was ever measured. This is what a new book starts
 * from, which is why it is separate from the fixtures the tests use: a screen
 * can only ever show a figure that was filed.
 *
 * A product's attributes are a starting point, not a ruling. The reporting
 * currency is editable and kept in the client's own book from then on, so a
 * correction here is a convenience rather than a release.
 */

import type { Client, CurrencyCode, Vehicle } from '../domain/types';
import type { ReportingProfile } from '../domain/report';

export interface VehicleDefinition {
  key: string;
  name: string;
  shortName: string;
  kind: Vehicle['kind'];
  currency: CurrencyCode;
  inception: string;
  /** The total subscribed to the product, in its own currency and units. */
  investorCommitment: number;
  status: Vehicle['status'];
  domicile: string;
  administrator: string;
}

export interface ClientDefinition {
  key: string;
  name: string;
  shortName: string;
  reportingCurrency: CurrencyCode;
  manager: string;
  vehicles: VehicleDefinition[];
}

export const CLIENT_DEFINITIONS: ClientDefinition[] = [
  {
    key: 'pam',
    name: 'Patrimonium Asset Management',
    shortName: 'PAM',
    reportingCurrency: 'CHF',
    manager: 'Patrimonium Asset Management AG',
    vehicles: [
      {
        key: 'pciof-i',
        name: 'Patrimonium Climate Infrastructure Opportunity Fund I',
        shortName: 'PCIOF I',
        kind: 'fund-of-funds',
        currency: 'EUR',
        inception: '2021-06-30',
        investorCommitment: 180_000,
        status: 'Investing',
        domicile: 'Luxembourg',
        administrator: 'Northgate Fund Services',
      },
      {
        key: 'pciof-ii',
        name: 'Patrimonium Climate Infrastructure Opportunity Fund II',
        shortName: 'PCIOF II',
        kind: 'fund-of-funds',
        currency: 'EUR',
        inception: '2024-09-30',
        investorCommitment: 120_000,
        status: 'Fundraising',
        domicile: 'Luxembourg',
        administrator: 'Northgate Fund Services',
      },
      {
        key: 'pas-infra',
        name: 'PAS Infra',
        shortName: 'PAS Infra',
        kind: 'fund-of-funds',
        currency: 'CHF',
        inception: '2019-12-31',
        investorCommitment: 250_000,
        status: 'Harvesting',
        domicile: 'Switzerland',
        administrator: 'Helvetia Fund Administration',
      },
    ],
  },
  {
    key: 'ebg',
    name: 'EBG Investment Solutions',
    shortName: 'EBG',
    reportingCurrency: 'CHF',
    manager: 'EBG Investment Solutions AG',
    vehicles: [
      {
        key: 'abif',
        name: 'Abendrot Impulse Fund',
        shortName: 'AbIF',
        kind: 'fund-of-funds',
        // The fund reports in euro, whatever the currency of its investor: its
        // financial statements, capital accounts and portfolio are all in EUR.
        currency: 'EUR',
        inception: '2020-03-31',
        investorCommitment: 165_000,
        status: 'Investing',
        domicile: 'Switzerland',
        administrator: 'RSM',
      },
      {
        key: 'phf-i',
        name: 'Planetary Health Fund I',
        shortName: 'PHF I',
        kind: 'fund-of-funds',
        currency: 'EUR',
        inception: '2022-06-30',
        // GLS is the fund's only limited partner, and this is what it
        // subscribed. A total larger than the register makes the engine read
        // the register as incomplete and refuse to allocate the last unit of
        // net asset value to anybody.
        investorCommitment: 10_000,
        status: 'Investing',
        domicile: 'Luxembourg',
        administrator: 'Northgate Fund Services',
      },
      {
        key: 'pk-tg',
        name: 'PK TG',
        shortName: 'PK TG',
        kind: 'fund-of-funds',
        currency: 'CHF',
        inception: '2018-09-30',
        investorCommitment: 320_000,
        status: 'Harvesting',
        domicile: 'Switzerland',
        administrator: 'Helvetia Fund Administration',
      },
    ],
  },
  {
    key: 'ut',
    name: 'Una Terra',
    shortName: 'UT',
    reportingCurrency: 'EUR',
    manager: 'Una Terra',
    vehicles: [
      {
        key: 'ut-early-growth',
        name: 'Una Terra Early Growth Fund',
        shortName: 'UT EGF',
        kind: 'direct-fund',
        currency: 'EUR',
        inception: '2022-03-31',
        investorCommitment: 45_000,
        status: 'Investing',
        domicile: 'Luxembourg',
        administrator: 'Northgate Fund Services',
      },
    ],
  },
];

export const KNOWN_CLIENTS = CLIENT_DEFINITIONS.map((client) => ({
  id: `client-${client.key}`,
  name: client.name,
  shortName: client.shortName,
}));

/**
 * The client and its products, ready to be written into a book.
 *
 * Conventions are deliberately absent from the vehicles: a vehicle's own
 * conventions override its client's, so stamping the defaults here would make
 * the client-level setting unreachable. A vehicle carries them only where
 * somebody sets them for it.
 */
export function buildClientStructure(clientId: string): {
  client: Client;
  vehicles: Vehicle[];
  reporting: ReportingProfile;
} {
  const seed = CLIENT_DEFINITIONS.find((c) => `client-${c.key}` === clientId)
    ?? CLIENT_DEFINITIONS[0];
  const clientKey = `client-${seed.key}`;

  return {
    client: {
      id: clientKey,
      name: seed.name,
      shortName: seed.shortName,
      reportingCurrency: seed.reportingCurrency,
    },
    vehicles: seed.vehicles.map((vehicle) => ({
      id: `veh-${vehicle.key}`,
      clientId: clientKey,
      kind: vehicle.kind,
      name: vehicle.name,
      shortName: vehicle.shortName,
      currency: vehicle.currency,
      inceptionDate: vehicle.inception,
      investorCommitment: vehicle.investorCommitment,
      manager: seed.manager,
      administrator: vehicle.administrator,
      domicile: vehicle.domicile,
      status: vehicle.status,
    })),
    reporting: reportingFor(seed, clientKey),
  };
}

/* ------------------------------------------------------------------ *
 * The default pack
 *
 * The engine is the same for every product; the pack that reaches a limited
 * partner is not. This is a starting layout, editable per client and then kept
 * in the client's own book — a house that already has its own order of
 * sections rearranges them once. The wording is generic on purpose: nothing
 * here is any firm's actual disclaimer.
 * ------------------------------------------------------------------ */

const PROFILE_STYLE: Record<string, { accent: string; coverNote: string }> = {
  pam: {
    accent: '#1f5c3d',
    coverNote: 'Quarterly report to limited partners. Figures are unaudited unless stated.',
  },
  ebg: {
    accent: '#2a4f8f',
    coverNote: 'Prepared for the exclusive use of the fund’s limited partners.',
  },
  ut: {
    accent: '#7a4b1e',
    coverNote: 'Quarterly report. Portfolio figures are stated before fund-level fees.',
  },
};

function reportingFor(seed: ClientDefinition, clientKey: string): ReportingProfile {
  const style = PROFILE_STYLE[seed.key] ?? PROFILE_STYLE.pam;
  const direct = seed.vehicles.every((vehicle) => vehicle.kind === 'direct-fund');
  const id = `${clientKey}-lp`;

  return {
    branding: {
      house: seed.name,
      accent: style.accent,
      coverNote: style.coverNote,
      footerNote:
        'This report is prepared for the recipient named above and may not be redistributed. '
        + 'It is not an offer to sell or a solicitation to buy any interest.',
    },
    defaultLayoutId: id,
    layouts: [{
      id,
      clientId: clientKey,
      name: `${seed.shortName} limited partner report`,
      description: 'The pack that goes to this client’s investors.',
      appliesTo: [],
      sections: direct
        // A direct fund's investors read the assets first; there is no undrawn
        // commitment layer between them and the portfolio.
        ? [
          { id: 'cover' },
          { id: 'summary', title: 'The quarter' },
          { id: 'kpi-net', title: 'Your position' },
          { id: 'product-bridge', title: 'Movement in net asset value' },
          { id: 'portfolio-register', title: 'Investments' },
          { id: 'look-through', title: 'Where the capital is working' },
          { id: 'currency', title: 'Currency' },
          { id: 'conventions', title: 'Basis of preparation' },
        ]
        : [
          { id: 'cover' },
          { id: 'summary', title: 'The quarter' },
          { id: 'kpi-net', title: 'Your position in the fund' },
          { id: 'product-bridge', title: 'Movement in net asset value' },
          { id: 'nav-components', title: 'What the net asset value is made of' },
          { id: 'kpi-gross', title: 'The underlying portfolio' },
          { id: 'allocation', title: 'Allocation' },
          { id: 'portfolio-register', title: 'Portfolio' },
          { id: 'coverage', title: 'What has reported' },
          { id: 'conventions', title: 'Basis of preparation' },
        ],
    }],
  };
}
