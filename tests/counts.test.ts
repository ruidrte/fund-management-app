import { describe, expect, it } from 'vitest';
import { analyse } from '../src/engine';
import { buildDemoDataSet } from '../src/data/demo';

/**
 * The README and the methodology document both state how many identity checks
 * run. A claim about the software in its own documentation is worth pinning, so
 * it cannot quietly drift away from the truth.
 */
describe('documented counts', () => {
  it('runs the number of identity checks the documentation claims', () => {
    const view = analyse(buildDemoDataSet('client-aurora'), {
      clientId: 'client-aurora',
      vehicleId: 'veh-aurora-opportunities',
      period: '2025Q4',
    });
    expect(view.checks.results).toHaveLength(19);
  });
});
