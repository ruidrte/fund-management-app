/**
 * Report layouts and branding.
 *
 * The engine is the same for every product; the pack that reaches a limited
 * partner is not. These pin the part that differs — which layouts are offered,
 * and what a client's branding may and may not do to the document.
 */

import { describe, expect, it } from 'vitest';
import { analyse } from '../src/engine';
import { buildDemoDataSet } from './fixtures/portfolio';
import { LAYOUTS, layoutsFor } from '../src/reports/layouts';
import { renderReport } from '../src/reports/render';
import type { ReportingProfile } from '../src/domain/report';

const ebg = buildDemoDataSet('client-ebg');
const view = analyse(ebg, { clientId: 'client-ebg', vehicleId: 'veh-abif', period: '2026Q1' });

const profile = (over: Partial<ReportingProfile> = {}): ReportingProfile => ({
  layouts: [{
    id: 'ebg-lp', clientId: 'client-ebg', name: 'EBG limited partner report',
    description: 'The pack that goes out', appliesTo: [],
    sections: [{ id: 'cover' }, { id: 'kpi-net', title: 'Your position' }],
  }],
  ...over,
});

describe('which layouts are offered', () => {
  it('puts the client’s own pack ahead of the built-in ones', () => {
    const offered = layoutsFor(view, profile());
    expect(offered[0].id).toBe('ebg-lp');
    // Every built-in that applies to a fund-of-funds, plus the client's own.
    const applicable = LAYOUTS.filter((l) => l.appliesTo.length === 0).length;
    expect(offered.length).toBe(applicable + 1);
  });

  it('still filters by what the vehicle is', () => {
    const direct = analyse(buildDemoDataSet('client-ut'), {
      clientId: 'client-ut', vehicleId: 'veh-ut-early-growth', period: '2026Q1',
    });
    // A fund-of-funds layout has nothing to say about a direct fund, and the
    // built-in direct layout has nothing to say about a fund-of-funds.
    const forDirect = layoutsFor(direct).map((l) => l.id);
    const forFof = layoutsFor(view).map((l) => l.id);
    expect(forDirect).toContain('direct-fund-quarterly');
    expect(forFof).not.toContain('direct-fund-quarterly');
  });

  it('offers only the built-ins to a client with no profile of its own', () => {
    expect(layoutsFor(view).map((l) => l.id)).toEqual(
      LAYOUTS.filter((l) => l.appliesTo.length === 0).map((l) => l.id),
    );
  });

  it('gives each demo client a different pack, from the same engine', () => {
    const packs = ['client-pam', 'client-ebg', 'client-ut'].map((id) => {
      const dataset = buildDemoDataSet(id);
      return dataset.reporting!.layouts[0];
    });
    expect(new Set(packs.map((p) => p.id)).size).toBe(3);
    // The direct fund's investors read the assets; the others read the fund.
    expect(packs[2].sections.map((s) => s.id)).toContain('look-through');
    expect(packs[0].sections.map((s) => s.id)).toContain('nav-components');
  });
});

describe('branding', () => {
  const layout = LAYOUTS[0];

  it('puts the house on the cover and the standing text in the foot', () => {
    const html = renderReport({
      layout, view, sourceLabel: 'Test',
      branding: {
        house: 'EBG Investment Solutions',
        accent: '#2a4f8f',
        coverNote: 'Prepared for limited partners.',
        footerNote: 'Not for redistribution.',
      },
    });
    expect(html).toContain('EBG Investment Solutions');
    expect(html).toContain('Prepared for limited partners.');
    expect(html).toContain('Not for redistribution.');
    expect(html).toContain(':root{--accent:#2a4f8f}');
  });

  it('renders house-neutral with no branding at all', () => {
    const html = renderReport({ layout, view, sourceLabel: 'Test' });
    // The stylesheet's own default stands; nothing is appended to override it.
    expect(html).not.toContain(':root{--accent:');
    expect(html).toContain('<!doctype html>');
  });

  it('ignores an accent that is not a plain colour', () => {
    // This string is interpolated into a stylesheet. A report carries names
    // that came out of documents nobody here wrote.
    for (const accent of ['red;}body{display:none}', 'url(http://x)', 'expression(1)', '#12345']) {
      const html = renderReport({ layout, view, sourceLabel: 'Test', branding: { accent } });
      expect(html).not.toContain(accent);
      expect(html).not.toContain('--accent:red');
    }
  });

  it('escapes branding text rather than letting it become markup', () => {
    const html = renderReport({
      layout, view, sourceLabel: 'Test',
      branding: {
        house: '<script>alert(1)</script>',
        footerNote: 'Ends with </footer><script>alert(2)</script>',
      },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
