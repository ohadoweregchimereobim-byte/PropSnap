import { describe, expect, it } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { daysOnMarket, describeChange, describeDays, describePortalChanges, latestMove, latestPortalChange, priceChange, priceMoved, wasIncreased, wasReduced, withPriceHistory } from '../src/services/price-history';

function capture(price: number | null, capturedAt: string, extra: Partial<PropertyListing> = {}): PropertyListing {
  return {
    listingId: '1',
    source: 'rightmove',
    url: 'https://www.rightmove.co.uk/properties/1',
    displayAddress: 'Maple Road, Cardiff',
    postcode: 'CF14 0SN',
    postcodePartial: 'CF14',
    fullAddress: null,
    price,
    priceQualifier: 'Guide price',
    currency: 'GBP',
    listingType: 'sale',
    bedrooms: 3,
    propertyType: 'Terraced',
    agentName: null,
    agentPhone: null,
    agentBranch: null,
    latitude: null,
    longitude: null,
    tenure: null,
    furnished: null,
    deposit: null,
    epcRating: null,
    capturedAt,
    ...extra,
  };
}

/** Capture the listing at each price in turn, the way saveListing does */
function captures(...steps: Array<[number | null, string, Partial<PropertyListing>?]>): PropertyListing {
  let saved: PropertyListing | undefined;
  for (const [price, at, extra] of steps) saved = withPriceHistory(saved, capture(price, at, extra));
  return saved!;
}

describe('withPriceHistory', () => {
  it('starts the history at the first capture', () => {
    const saved = captures([300_000, '2026-10-01T09:00:00Z']);
    expect(saved.priceHistory).toEqual([{ price: 300_000, qualifier: 'Guide price', seenAt: '2026-10-01T09:00:00Z' }]);
  });

  it('adds a point only when the price or qualifier changes', () => {
    const saved = captures(
      [300_000, '2026-10-01T09:00:00Z'],
      [300_000, '2026-10-05T09:00:00Z'],
      [290_000, '2026-10-12T09:00:00Z'],
      [290_000, '2026-10-20T09:00:00Z', { priceQualifier: 'Offers over' }],
    );
    expect(saved.priceHistory!.map((p) => [p.price, p.seenAt.slice(0, 10)])).toEqual([
      [300_000, '2026-10-01'],
      [290_000, '2026-10-12'],
      [290_000, '2026-10-20'],
    ]);
  });

  it('starts from the old capture when it was saved before price history existed', () => {
    const old = capture(250_000, '2026-09-01T09:00:00Z'); // no priceHistory field
    const saved = withPriceHistory(old, capture(240_000, '2026-10-01T09:00:00Z'));
    expect(saved.priceHistory!.map((p) => p.price)).toEqual([250_000, 240_000]);
  });
});

describe('priceChange', () => {
  it('is null until the price has moved', () => {
    expect(priceChange(captures([300_000, '2026-10-01T09:00:00Z']))).toBeNull();
    expect(priceChange(captures([300_000, '2026-10-01T09:00:00Z'], [300_000, '2026-10-02T09:00:00Z', { priceQualifier: 'Offers over' }]))).toBeNull();
    expect(priceChange({ priceHistory: undefined })).toBeNull();
  });

  it('measures from the first price to the latest', () => {
    const c = priceChange(captures(
      [300_000, '2026-10-01T09:00:00Z'],
      [290_000, '2026-10-12T09:00:00Z'],
      [285_000, '2026-10-20T09:00:00Z'],
    ))!;
    expect(c.change).toBe(-15_000);
    expect(c.changePct).toBeCloseTo(-5, 5);
    expect(c.direction).toBe('reduced');
    expect(c.moves).toBe(2);
    expect(c.lastMoveAt).toBe('2026-10-20T09:00:00Z');
    expect(describeChange(c)).toBe('Reduced £15,000 (−5.0%)');
  });

  it('knows a rise and a return to the first price', () => {
    const up = priceChange(captures([300_000, '2026-10-01T09:00:00Z'], [305_000, '2026-10-12T09:00:00Z']))!;
    expect(describeChange(up)).toBe('Up £5,000 (+1.7%)');
    const back = priceChange(captures([300_000, '2026-10-01T09:00:00Z'], [290_000, '2026-10-12T09:00:00Z'], [300_000, '2026-10-20T09:00:00Z']))!;
    expect(back.direction).toBe('same');
    expect(describeChange(back)).toBe('Back to the first price');
  });

  it('skips captures with no price', () => {
    const c = priceChange(captures([300_000, '2026-10-01T09:00:00Z'], [null, '2026-10-05T09:00:00Z'], [280_000, '2026-10-12T09:00:00Z']))!;
    expect(c.change).toBe(-20_000);
  });
});

describe('latestMove', () => {
  it('gives the last price move and the capture that saw it', () => {
    const saved = captures(
      [300_000, '2026-10-01T09:00:00Z'],
      [290_000, '2026-10-12T09:00:00Z'],
      [290_000, '2026-10-20T09:00:00Z', { priceQualifier: 'Offers over' }],
    );
    expect(latestMove(saved)).toEqual({ from: 300_000, to: 290_000, seenAt: '2026-10-12T09:00:00Z' });
    expect(latestMove(captures([300_000, '2026-10-01T09:00:00Z']))).toBeNull();
  });
});

describe("the site's own dates", () => {
  it('adds up the site changes across captures and keeps the listed date', () => {
    const first = capture(300_000, '2026-10-01T09:00:00Z', { listedOn: '2026-09-18', portalPriceChanges: [{ date: '2026-09-25', direction: 'down' }] });
    // Rightmove shows only its latest reduction, and this capture lost the added date
    const next = capture(290_000, '2026-10-14T09:00:00Z', { listedOn: null, portalPriceChanges: [{ date: '2026-10-12', direction: 'down' }] });
    const saved = withPriceHistory(withPriceHistory(undefined, first), next);
    expect(saved.listedOn).toBe('2026-09-18');
    expect(saved.portalPriceChanges).toEqual([{ date: '2026-09-25', direction: 'down' }, { date: '2026-10-12', direction: 'down' }]);
    // A newer listed date (relisted) wins
    expect(withPriceHistory(saved, capture(290_000, '2026-10-20T09:00:00Z', { listedOn: '2026-10-19' })).listedOn).toBe('2026-10-19');
  });

  it('counts days on the market from the site date', () => {
    expect(daysOnMarket({ listedOn: '2026-03-06' }, '2026-10-24')).toBe(232);
    expect(daysOnMarket({ listedOn: '2026-10-24' }, '2026-10-24')).toBe(0);
    expect(daysOnMarket({ listedOn: null }, '2026-10-24')).toBeNull();
    expect(daysOnMarket({ listedOn: '2026-11-01' }, '2026-10-24')).toBeNull();
    expect(describeDays(232)).toBe('232 days on the market');
    expect(describeDays(1)).toBe('1 day on the market');
    expect(describeDays(0)).toBe('listed today');
  });

  it('counts a drop the site shows as reduced, even on the first capture', () => {
    const once = capture(325_000, '2026-10-24T09:00:00Z', { source: 'zoopla', portalPriceChanges: [{ date: '2026-04-07', direction: 'down' }, { date: '2026-08-28', direction: 'down' }] });
    const saved = withPriceHistory(undefined, once);
    expect(priceChange(saved)).toBeNull();
    expect(wasReduced(saved)).toBe(true);
    expect(wasIncreased(saved)).toBe(false);
    expect(priceMoved(saved)).toBe(true);
    expect(describePortalChanges(saved)).toBe('Zoopla shows 2 price drops: 7 Apr 2026, 28 Aug 2026');
    expect(latestPortalChange(saved)).toBe('Reduced 28 Aug 2026');

    const plain = withPriceHistory(undefined, capture(325_000, '2026-10-24T09:00:00Z'));
    expect(wasReduced(plain)).toBe(false);
    expect(priceMoved(plain)).toBe(false);
    expect(describePortalChanges(plain)).toBeNull();
  });
});

describe('Zoopla wording saved as a code', () => {
  it('does not add a history point when only the code becomes words', () => {
    const before = withPriceHistory(undefined, capture(325_000, '2026-10-01T09:00:00Z', { priceQualifier: 'offers_over' }));
    const after = withPriceHistory(before, capture(325_000, '2026-10-24T09:00:00Z', { priceQualifier: 'Offers over' }));
    expect(after.priceHistory).toHaveLength(1);
    // A real change of wording still counts
    expect(withPriceHistory(after, capture(325_000, '2026-10-25T09:00:00Z', { priceQualifier: 'Guide price' })).priceHistory).toHaveLength(2);
  });
});
