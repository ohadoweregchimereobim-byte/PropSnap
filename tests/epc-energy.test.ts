import { describe, expect, it } from 'vitest';
import { bandForScore, describeEnergy, energyGap, lowWithPotential, readEnergy } from '../src/services/epc-energy';
import rdsap21 from './fixtures/epc/rdsap-21.0.1.json';
import sap16 from './fixtures/epc/sap-16.3-rdsap.json';

// Official sample certificates (see tests/fixtures/epc/README.md), wrapped the way the API answers
const SAMPLES: Record<string, unknown> = { 'rdsap-21.0.1.json': rdsap21, 'sap-16.3-rdsap.json': sap16 };
const sample = (name: string) => ({ data: SAMPLES[name] });

describe('readEnergy: official sample certificates', () => {
  it('reads the newest format (RdSAP 21.0.1)', () => {
    const e = readEnergy(sample('rdsap-21.0.1.json'), 'cert-1')!;
    expect(e).toMatchObject({
      certificateNumber: 'cert-1',
      currentBand: 'E',
      potentialBand: 'C',
      currentScore: 50,
      potentialScore: 72,
      registrationDate: '2025-04-04',
    });
    expect(e.improvements).toEqual([
      { name: 'Internal and cavity wall insulation', cost: '£220 - £250', saving: 139, ratingAfter: 70 },
      { name: 'Solar water heating', cost: '£4,000 - £7,000', saving: 49, ratingAfter: 72 },
      { name: 'Solar photovoltaic panels', cost: '£8,000 - £10,000', saving: 286, ratingAfter: 83 },
    ]);
  });

  it('reads the 2016 format, where savings are wrapped in { value, currency }', () => {
    const e = readEnergy(sample('sap-16.3-rdsap.json'), 'cert-2')!;
    expect(e).toMatchObject({ currentBand: 'D', potentialBand: 'B', currentScore: 59, potentialScore: 84, registrationDate: '2014-12-06' });
    expect(e.improvements).toHaveLength(7);
    expect(e.improvements[0]).toEqual({ name: 'Floor insulation', cost: '£800 - £1,200', saving: 88, ratingAfter: 63 });
  });
});

describe('readEnergy: other shapes', () => {
  it('reads the older letter and score names', () => {
    expect(readEnergy({ 'current-energy-rating': 'F', 'potential-energy-rating': 'B', 'current-energy-efficiency': '30', 'potential-energy-efficiency': '85', 'lodgement-date': '2019-03-01' }, 'x'))
      .toMatchObject({ currentBand: 'F', potentialBand: 'B', currentScore: 30, potentialScore: 85, registrationDate: '2019-03-01', improvements: [] });
  });

  it('works out a band from a score, and gives null with no rating at all', () => {
    expect(readEnergy({ data: { energy_rating_current: { value: 45 }, energy_rating_potential: 70 } }, 'x'))
      .toMatchObject({ currentBand: 'E', potentialBand: 'C' });
    expect(readEnergy({ data: { dwelling_type: 'Flat' } }, 'x')).toBeNull();
    expect(readEnergy(null, 'x')).toBeNull();
  });

  it('skips improvements it cannot name, and keeps the certificate order', () => {
    const e = readEnergy({ data: {
      current_energy_efficiency_band: 'D',
      potential_energy_efficiency_band: 'C',
      suggested_improvements: [
        { sequence: 2, improvement_details: { improvement_number: 5 }, energy_performance_rating: 70 },
        { sequence: 1, improvement_details: { improvement_number: 99999 } },
        { sequence: 0, improvement_details: { improvement_texts: { improvement_heading: 'Replace boiler' } } },
      ],
    } }, 'x')!;
    expect(e.improvements.map((i) => i.name)).toEqual(['Replace boiler', 'Loft insulation']);
  });
});

describe('bands and gaps', () => {
  it('uses the SAP score bands', () => {
    expect([92, 91, 81, 80, 69, 68, 55, 54, 39, 38, 21, 20, 1].map(bandForScore).join('')).toBe('ABBCCDDEEFFGG');
    expect(bandForScore(0)).toBeNull();
  });

  it('measures the gap and spots low ratings with high potential', () => {
    expect(energyGap({ currentBand: 'E', potentialBand: 'C', currentScore: 50, potentialScore: 72 })).toEqual({ bands: 2, points: 22 });
    expect(energyGap({ currentBand: null, potentialBand: 'C', currentScore: null, potentialScore: null })).toBeNull();
    expect(lowWithPotential({ currentBand: 'E', potentialBand: 'C' })).toBe(true);
    expect(lowWithPotential({ currentBand: 'D', potentialBand: 'B' })).toBe(false);
    expect(lowWithPotential({ currentBand: 'F', potentialBand: 'D' })).toBe(false);
    expect(describeEnergy({ currentBand: 'E', potentialBand: 'C', currentScore: 50, potentialScore: 72 })).toBe('E (50) → C (72)');
  });
});
