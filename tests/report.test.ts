import { describe, expect, it } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { brr, buyToLet, DEFAULT_DEAL_INPUTS, flip, hmo, type DealInputs } from '../src/services/calculators';
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
    deal: { inputs, btl: buyToLet(inputs), brr: brr(inputs), flip: flip(inputs), hmo: hmo(inputs) },
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

  it('adds labels and the user timeline to the notes, and only when asked', () => {
    const activity = [
      { id: 'a1', at: '2026-10-20T09:00:00Z', kind: 'call' as const, text: 'Vendor flexible', outcome: 'spoke' as const },
      { id: 'a2', at: '2026-10-21T09:00:00Z', kind: 'note' as const, text: 'Roof looks tired' },
    ];
    expect(section(buildReport(input({ labels: ['BRR'], activity })), 'Deal notes')).toBeUndefined();
    const r = buildReport(input({ includeNotes: true, labels: ['BRR', 'Needs work'], activity }));
    expect(row(r, 'Deal notes', 'Labels')).toBe('BRR, Needs work');
    const rows = section(r, 'Deal notes')!.table!.rows;
    expect(rows[0]).toEqual(['21 Oct 2026', 'Note', 'Roof looks tired']);
    expect(rows[1]).toEqual(['20 Oct 2026', 'Call: Spoke to the agent', 'Vendor flexible']);
  });

  it('shows labels without a pipeline, and no timeline from price changes alone', () => {
    const r = buildReport(input({ includeNotes: true, pipeline: null, labels: ['HMO'] }));
    expect(row(r, 'Deal notes', 'Labels')).toBe('HMO');
    expect(row(r, 'Deal notes', 'Stage')).toBeUndefined();
    expect(section(r, 'Deal notes')!.table).toBeUndefined();
    expect(section(buildReport(input({ includeNotes: true, pipeline: null })), 'Deal notes')).toBeUndefined();
  });

  it('adds the sourcing fee and extra costs to the purchase', () => {
    const r = buildReport(input({}, {
      sourcingFee: 2, sourcingFeeType: 'pct',
      customCosts: [{ name: 'Gas safety', amount: 90, when: 'once' }, { name: 'Insurance', amount: 30, when: 'monthly' }],
    }));
    expect(row(r, 'Purchase and buy-to-let', 'Sourcing fee')).toBe('£5,800 (2% of the price)');
    expect(row(r, 'Purchase and buy-to-let', 'Other one-off costs')).toBe('Gas safety £90');
    expect(row(r, 'Purchase and buy-to-let', 'Other monthly costs')).toBe('Insurance £30 (£30 a month)');
    expect(row(buildReport(input()), 'Purchase and buy-to-let', 'Sourcing fee')).toBeUndefined();
  });

  it('adds flip and HMO sections once they have figures, and only the strategies picked', () => {
    const plain = buildReport(input());
    expect(section(plain, 'Flip (buy, do up and sell)')).toBeUndefined();
    expect(section(plain, 'HMO (let by the room)')).toBeUndefined();

    const r = buildReport(input({}, { refurbCost: 20_000, valueAfterRefurb: 340_000, hmoRooms: 5, hmoRoomRent: 550, hmoBillsMonthly: 500 }));
    expect(row(r, 'Flip (buy, do up and sell)', 'Sale price')).toBe('£340,000');
    expect(row(r, 'Flip (buy, do up and sell)', 'Bridging loan')).toBe('None, bought with cash');
    expect(row(r, 'Flip (buy, do up and sell)', 'Profit before tax')).toMatch(/^-?£/);
    expect(row(r, 'HMO (let by the room)', 'Rooms')).toBe('5 at £550 a month');
    expect(row(r, 'HMO (let by the room)', 'Rent')).toBe('£2,750 a month');

    const picked = input({}, { refurbCost: 20_000, valueAfterRefurb: 340_000 });
    picked.deal.show = { btl: false, brr: false, flip: true, hmo: false };
    const only = buildReport(picked);
    expect(only.sections.map((x) => x.heading)).toContain('Purchase');
    expect(section(only, 'Purchase and buy-to-let')).toBeUndefined();
    expect(section(only, 'Buy, refurbish, refinance')).toBeUndefined();
    expect(section(only, 'Flip (buy, do up and sell)')).toBeDefined();
  });

  it('carries the branding, with a readable heading colour', () => {
    expect(buildReport(input()).brand).toBeNull();
    const r = buildReport(input({ branding: { company: 'Acme Sourcing', contact: '029 2000 0000', colour: '#fde047', logo: null } }));
    expect(r.brand).toMatchObject({ company: 'Acme Sourcing', contact: '029 2000 0000', colour: '#fde047', headingColour: '#0f172a' });
    expect(r.footer).toMatch(/^Prepared by Acme Sourcing on 23 Oct 2026\./);
    expect(r.footer).toContain('Not financial or tax advice');
  });

  it("shows the site's listed date and its price drops", () => {
    const l = { ...listing, priceHistory: [listing.priceHistory![1]!], listedOn: '2026-03-06', portalPriceChanges: [{ date: '2026-08-28', direction: 'down' as const }] };
    const r = buildReport(input({ listing: l, generatedAt: new Date('2026-10-24T12:00:00Z') }));
    expect(row(r, 'Property', 'On the market')).toBe("Since 6 Mar 2026 (232 days, Zoopla's date)");
    const prices = section(r, 'Price history')!;
    expect(prices.notes).toEqual(['Zoopla shows 1 price drop: 28 Aug 2026 (the site does not show the amounts).']);
    expect(prices.table).toBeUndefined();
    expect(row(buildReport(input()), 'Property', 'On the market')).toBeUndefined();
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
