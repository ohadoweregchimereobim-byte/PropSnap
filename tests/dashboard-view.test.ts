import { describe, expect, it } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { applyView, DEFAULT_VIEW, matchGroup, safeLink, summarise } from '../src/services/dashboard-view';

function listing(id: string, extra: Partial<PropertyListing> = {}): PropertyListing {
  return {
    listingId: id,
    source: 'zoopla',
    url: `https://www.zoopla.co.uk/for-sale/details/${id}`,
    displayAddress: 'Maple Road, Cardiff',
    postcode: 'CF14 0SN',
    postcodePartial: 'CF14',
    fullAddress: null,
    price: null,
    priceQualifier: null,
    currency: 'GBP',
    listingType: 'sale',
    bedrooms: null,
    propertyType: null,
    agentName: null,
    agentPhone: null,
    agentBranch: null,
    latitude: null,
    longitude: null,
    tenure: null,
    furnished: null,
    deposit: null,
    epcRating: null,
    capturedAt: '2026-10-01T00:00:00Z',
    ...extra,
  };
}

const ids = (list: PropertyListing[]) => list.map((l) => l.listingId);

const saved = [
  listing('1', { source: 'rightmove', displayAddress: 'Tweedsmuir Road, Cardiff', postcode: 'CF24 2RF', fullAddress: '144 Tweedsmuir Road, CARDIFF', addressConfidence: 'best_guess', price: 250000, capturedAt: '2026-10-03T00:00:00Z' }),
  listing('2', { displayAddress: 'Ferry Court, Cardiff', postcode: 'CF11 0AS', fullAddress: '10 Dovercourt House, Ferry Court, CARDIFF', addressConfidence: 'exact', price: 180000, capturedAt: '2026-10-02T00:00:00Z' }),
  listing('3', { source: 'openrent', price: null, agentName: 'Jane Landlord', capturedAt: '2026-10-01T00:00:00Z' }),
];

describe('applyView', () => {
  it('shows the newest capture first by default', () => {
    expect(ids(applyView(saved, DEFAULT_VIEW))).toEqual(['1', '2', '3']);
  });

  it('searches address, full address, postcode and agent, ignoring case', () => {
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, search: 'dovercourt' }))).toEqual(['2']);
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, search: 'cf24' }))).toEqual(['1']);
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, search: 'jane cardiff' }))).toEqual(['3']);
  });

  it('filters by site and by match', () => {
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, source: 'zoopla' }))).toEqual(['2']);
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, match: 'best_guess' }))).toEqual(['1']);
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, match: 'none' }))).toEqual(['3']);
  });

  it('sorts by price both ways and keeps blank prices last', () => {
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, sortKey: 'price', sortDir: 'asc' }))).toEqual(['2', '1', '3']);
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, sortKey: 'price', sortDir: 'desc' }))).toEqual(['1', '2', '3']);
  });
});

describe('price filter', () => {
  const point = (price: number, day: number) => ({ price, qualifier: null, seenAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z` });
  const moved = [
    listing('cut', { price: 290_000, priceHistory: [point(300_000, 1), point(290_000, 9)] }),
    listing('rise', { price: 310_000, priceHistory: [point(300_000, 1), point(310_000, 9)] }),
    listing('flat', { price: 300_000, priceHistory: [point(300_000, 1)] }),
  ];

  it('shows reduced, increased or any change', () => {
    expect(ids(applyView(moved, { ...DEFAULT_VIEW, price: 'reduced' }))).toEqual(['cut']);
    expect(ids(applyView(moved, { ...DEFAULT_VIEW, price: 'increased' }))).toEqual(['rise']);
    expect(ids(applyView(moved, { ...DEFAULT_VIEW, price: 'changed' }))).toEqual(['cut', 'rise']);
  });

  it('counts reduced listings', () => {
    expect(summarise(moved).reduced).toBe(1);
  });
});

describe('pipeline filters', () => {
  const today = '2026-10-23';
  const userData = {
    'rightmove:1': { pipeline: { status: 'viewing' as const, notes: 'Vendor wants a quick sale', followUp: '2026-10-20', updatedAt: '' } },
    'zoopla:2': { pipeline: { status: 'passed' as const, notes: '', followUp: '2026-10-01', updatedAt: '' } },
    'openrent:3': { pipeline: { status: 'offer' as const, notes: '', followUp: '2026-11-30', updatedAt: '' } },
  };
  const context = { userData, today };

  it('filters by stage, active deals and follow-ups due', () => {
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, status: 'viewing' }, context))).toEqual(['1']);
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, status: 'active' }, context))).toEqual(['1', '3']);
    // An overdue follow-up on a deal the user passed on is not due
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, status: 'due' }, context))).toEqual(['1']);
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, status: 'new' }, { today }))).toEqual(['1', '2', '3']);
  });

  it('searches the notes', () => {
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, search: 'quick sale' }, context))).toEqual(['1']);
  });

  it('sorts by stage', () => {
    expect(ids(applyView(saved, { ...DEFAULT_VIEW, sortKey: 'status', sortDir: 'asc' }, context))).toEqual(['1', '3', '2']);
  });

  it('counts active deals and follow-ups due', () => {
    expect(summarise(saved, context)).toMatchObject({ active: 2, due: 1 });
  });
});

describe('summarise and matchGroup', () => {
  it('counts each match group', () => {
    expect(summarise(saved)).toEqual({ total: 3, exact: 1, user_choice: 0, best_guess: 1, none: 1, reduced: 0, active: 0, due: 0 });
    expect(matchGroup(listing('x', { fullAddress: '1 Maple Road', addressConfidence: 'user_choice' }))).toBe('user_choice');
    expect(matchGroup(listing('x', { fullAddress: '1 Maple Road' }))).toBe('best_guess');
  });
});

describe('safeLink', () => {
  it('only allows web links', () => {
    expect(safeLink('https://www.rightmove.co.uk/properties/1')).toBe('https://www.rightmove.co.uk/properties/1');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('')).toBeNull();
  });
});
