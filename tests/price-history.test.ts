import { describe, expect, it } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { describeChange, latestMove, priceChange, withPriceHistory } from '../src/services/price-history';

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
