import { describe, expect, it } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { brr, buyToLet, DEFAULT_DEAL_INPUTS, type DealInputs } from '../src/services/calculators';
import { buildReport, type ReportInput } from '../src/services/report';
import type { SoldPrice } from '../src/services/land-registry';
import { soldPriceView } from '../src/services/sold-prices';

const listing: PropertyListing = {
  listingId: '1',
  source: 'zoopla',
  url: 'https://www.zoopla.co.uk/for-sale/details/1',
  displayAddress: 'Woolaston Avenue, Cardiff CF23',
  postcode: 'CF23 6EZ',
  postcodePartial: 'CF23',
  fullAddress: '6 Woolaston Avenue, CARDIFF',
  addressConfidence: 'best_guess',
  price: 290_000,
  priceQualifier: 'Guide price',
  currency: 'GBP',
  listingType: 'sale',
  bedrooms: 2,
  propertyType: 'Terraced',
  floorAreaSqm: 76,
  agentName: 'Agent Co',
  agentPhone: '029 0000 0000',
  agentBranch: 'Cardiff',
  latitude: null,
  longitude: null,
  tenure: 'Freehold',
  furnished: null,
  deposit: null,
  epcRating: 'C',
  capturedAt: '2026-10-12T09:00:00Z',
  priceHistory: [
    { price: 300_000, qualifier: 'Guide price', seenAt: '2026-10-01T09:00:00Z' },
    { price: 290_000, qualifier: 'Guide price', seenAt: '2026-10-12T09:00:00Z' },
  ],
};

const sale = (id: string, paon: string, price: number, extra: Partial<SoldPrice> = {}): SoldPrice => ({
  id, price, date: '2025-03-01', saon: null, paon, street: 'WOOLASTON AVENUE', town: 'CARDIFF', postcode: 'CF23 6EZ',
  propertyType: 'terraced', tenure: 'freehold', newBuild: false, standard: true, ...extra,
});

function input(extra: Partial<ReportInput> = {}, deal: Partial<DealInputs> = {}): ReportInput {
  const inputs: DealInputs = { ...DEFAULT_DEAL_INPUTS, price: 290_000, region: 'wales', rentMonthly: 1_300, valueAfterRefurb: 290_000, ...deal };
  const sales = [sale('own', '6', 175_000, { date: '2010-09-01' }), sale('a', '24', 310_000), sale('b', '30', 150_000, { standard: false })];
  return {
    listing,
    sold: {
      view: soldPriceView(sales, listing, { types: ['terraced'], sinceYears: 5, today: new Date('2026-10-23T00:00:00Z') }),
      where: 'Sales in CF23 6EZ and on Woolaston Avenue (CF23).',
      filters: 'Terraced only, last 5 years',
    },
    deal: { inputs, btl: buyToLet(inputs), brr: brr(inputs) },
    pipeline: { status: 'viewing', notes: 'Vendor wants a quick sale.\nViewing Sat 10am.', followUp: '2026-10-28', updatedAt: '' },
    includeNotes: false,
    generatedAt: new Date('2026-10-23T12:00:00Z'),
    ...extra,
  };
}

const section = (r: ReturnType<typeof buildReport>, heading: string) => r.sections.find((s) => s.heading === heading);
const row = (r: ReturnType<typeof buildReport>, heading: string, label: string) => section(r, heading)?.rows?.find(([l]) => l === label)?.[1];

describe('buildReport', () => {
  it('has the property, price history, sold prices and deal figures', () => {
    const r = buildReport(input());
    expect(r.title).toBe('6 Woolaston Avenue, CARDIFF');
    expect(r.subtitle).toBe('2 bed · Terraced · £290,000');
    expect(r.sections.map((s) => s.heading)).toEqual(['Property', 'Price history', 'Sold prices nearby', 'Purchase and buy-to-let']);
    expect(row(r, 'Property', 'Address')).toBe('6 Woolaston Avenue, CARDIFF (best guess from the EPC register)');
    expect(row(r, 'Property', 'Asking price')).toBe('Guide price £290,000');
    expect(row(r, 'Property', 'Floor area')).toBe('76 m²');
    // Empty facts are left out
    expect(row(r, 'Property', 'Furnished')).toBeUndefined();
    expect(section(r, 'Price history')!.notes![0]).toBe('Reduced £10,000 (−3.3%) since 1 Oct 2026, from £300,000.');
  });

  it('shows the sold figures with the filters and this home\'s own sale', () => {
    const r = buildReport(input());
    expect(row(r, 'Sold prices nearby', 'Median sold price')).toBe('£310,000');
    expect(row(r, 'Sold prices nearby', 'Sales')).toBe('2 (1 used in the figures)');
    const notes = section(r, 'Sold prices nearby')!.notes!.join(' ');
    expect(notes).toContain('Filters: Terraced only, last 5 years.');
    expect(notes).toContain('weak evidence');
    expect(notes).toContain('This home sold before: £175,000 in Sept 2010 (based on the best-guess address).');
    expect(notes).toContain('Open Government Licence');
    expect(section(r, 'Sold prices nearby')!.table!.rows.map((x) => x[3])).toEqual(['£310,000', '£150,000 *']);
  });

  it('works out the deal figures from the calculator', () => {
    const r = buildReport(input());
    expect(row(r, 'Purchase and buy-to-let', 'Land Transaction Tax')).toBe('£18,950 (Higher rates for an additional property)');
    expect(row(r, 'Purchase and buy-to-let', 'Gross yield')).toBe('5.38%');
  });

  it('adds BRR only when works or a new value are planned', () => {
    expect(section(buildReport(input()), 'Buy, refurbish, refinance')).toBeUndefined();
    const r = buildReport(input({}, { refurbCost: 20_000, valueAfterRefurb: 340_000 }));
    expect(row(r, 'Buy, refurbish, refinance', 'New mortgage')).toBe('£255,000 (75% of the new value)');
  });

  it('leaves out deal figures without a price, and sold prices that were not loaded', () => {
    const r = buildReport(input({ sold: null }, { price: 0 }));
    expect(r.sections.map((s) => s.heading)).toEqual(['Property', 'Price history']);
  });

  it('includes the stage and notes only when asked', () => {
    expect(section(buildReport(input()), 'Deal notes')).toBeUndefined();
    const r = buildReport(input({ includeNotes: true }));
    expect(row(r, 'Deal notes', 'Stage')).toBe('Viewing booked');
    expect(row(r, 'Deal notes', 'Follow up')).toBe('28 Oct 2026');
    expect(section(r, 'Deal notes')!.text).toBe('Vendor wants a quick sale.\nViewing Sat 10am.');
  });

  it('says it is not advice', () => {
    expect(buildReport(input()).footer).toContain('Not financial or tax advice');
  });

  it('shows the EPC potential and the recommended improvements', () => {
    const energy = {
      certificateNumber: 'c1', currentBand: 'E' as const, potentialBand: 'C' as const, currentScore: 50, potentialScore: 72, registrationDate: '2021-08-11',
      improvements: [{ name: 'Loft insulation', cost: '£100 - £350', saving: 25, ratingAfter: 54 }],
    };
    const r = buildReport(input({ listing: { ...listing, epcEnergy: energy } }));
    expect(row(r, 'Property', 'EPC certificate')).toBe('E (50) → C (72), now to potential (certificate 11 Aug 2021), for the best-guess home');
    expect(section(r, 'Energy improvements')!.table!.rows).toEqual([['Loft insulation', '£100 - £350', '£25', '54 (E)']]);
    expect(section(r, 'Energy improvements')!.notes![0]).toContain('Low rating with high potential');
    expect(section(buildReport(input()), 'Energy improvements')).toBeUndefined();
  });

  it('lists homes flipped nearby with the filters used', () => {
    const sales = [
      sale('f1', '40', 150_000, { date: '2024-01-10' }), sale('f2', '40', 195_000, { date: '2025-02-10' }),
      sale('own', '6', 175_000, { date: '2010-09-01' }),
    ];
    const view = soldPriceView(sales, listing, { types: ['terraced'], sinceYears: 5, today: new Date('2026-10-23T00:00:00Z') });
    const r = buildReport(input({ sold: { view, where: 'Sales in CF23 6EZ.', filters: 'Terraced only, last 5 years' } }));
    expect(section(r, 'Flipped nearby')!.table!.rows).toEqual([['40 Woolaston Avenue, Cardiff CF23 6EZ', '£150,000, Jan 2024', '£195,000, Feb 2025', '+£45,000 (30%)']]);
    expect(section(r, 'Flipped nearby')!.notes![0]).toContain('Median rise 30%');
    expect(section(buildReport(input()), 'Flipped nearby')).toBeUndefined();
  });
});
