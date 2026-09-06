import { describe, expect, it } from 'vitest';
import { analyse } from '../src/engine';
import { buildDemoDataSet } from './fixtures/portfolio';
import { buildClientStructure, KNOWN_CLIENTS } from '../src/data/structure';

/**
 * The README and the methodology document both state how many identity checks
 * run. A claim about the software in its own documentation is worth pinning, so
 * it cannot quietly drift away from the truth.
 */
describe('documented counts', () => {
  it('runs the number of identity checks the documentation claims', () => {
    const view = analyse(buildDemoDataSet('client-ut'), {
      clientId: 'client-ut',
      vehicleId: 'veh-ut-early-growth',
      period: '2025Q4',
    });
    expect(view.checks.results).toHaveLength(21);
  });
});

describe('whose book it is', () => {
  it('gives every house its own colour', () => {
    // Somebody working across three houses in an afternoon should be able to
    // tell whose figures are in front of them without reading the name. The
    // colour is a property of the house and travels in the book, so a screen
    // and an emitted file can agree on it.
    const accents = KNOWN_CLIENTS.map((client) => client.accent);
    expect(accents.every((accent) => /^#[0-9a-f]{6}$/i.test(accent))).toBe(true);
    expect(new Set(accents).size).toBe(KNOWN_CLIENTS.length);
  });

  it('carries it onto the client the application loads', () => {
    for (const known of KNOWN_CLIENTS) {
      expect(buildClientStructure(known.id).client.accent).toBe(known.accent);
    }
  });
});
