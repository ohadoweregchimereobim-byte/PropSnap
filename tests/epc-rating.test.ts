import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EpcResult, PropertyListing } from '../src/adapters/types';
import { epcBand, findEpcBandInText } from '../src/adapters/epc-band';
import { findBestMatch } from '../src/services/epc-match';
import { enrichWithEpc } from '../src/services/epc-api';

// Made-up homes on one made-up street, all sharing a postcode
function home(line1: string, rating: string, extra: Partial<EpcResult> = {}): EpcResult {
  return {
    addressLines: [line1],
    postTown: 'Cardiff',
    postcode: 'CF14 0SN',
    currentEnergyRating: rating,
    registrationDate: '2024-01-01',
    certificateNumber: `cert-${line1}`,
    uprn: line1,
    ...extra,
  };
}

function listing(extra: Partial<PropertyListing> = {}): PropertyListing {
  return {
    listingId: '1',
    source: 'zoopla',
    url: 'https://example.test',
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
    capturedAt: '2026-10-17T00:00:00Z',
    ...extra,
  };
}

describe('epcBand', () => {
  it('reads a band letter', () => {
    expect(epcBand('C')).toBe('C');
    expect(epcBand('c (72)')).toBe('C');
    expect(epcBand('Band B')).toBe('B');
  });

  it('ignores values without a band', () => {
    expect(epcBand('Not required')).toBeNull();
    expect(epcBand('')).toBeNull();
    expect(epcBand(null)).toBeNull();
  });
});

describe('findEpcBandInText', () => {
  it('finds a band written by the agent', () => {
    expect(findEpcBandInText(['Garage', 'EPC Rating: D'])).toBe('D');
    expect(findEpcBandInText(['EPC - C'])).toBe('C');
    expect(findEpcBandInText(['EPC band B'])).toBe('B');
  });

  it('does not read words that start with a band letter', () => {
    expect(findEpcBandInText(['EPC certificate available'])).toBeNull();
    expect(findEpcBandInText(['EPC Rating: Ask agent'])).toBeNull();
    expect(findEpcBandInText([undefined, null])).toBeNull();
  });
});

describe('EPC band in ranking', () => {
  const street = [home('1 Maple Road', 'D'), home('3 Maple Road', 'C'), home('5 Maple Road', 'E')];

  it('picks the only home with the listing band as an exact match', () => {
    const match = findBestMatch(street, listing({ epcRating: 'C' }));
    expect(match?.result.addressLines[0]).toBe('3 Maple Road');
    expect(match?.confidence).toBe('exact');
    expect(match?.reasons).toContain('EPC rating');
  });

  it('stays a best guess when several homes share the band', () => {
    const match = findBestMatch(
      [home('1 Maple Road', 'C'), home('3 Maple Road', 'C')],
      listing({ epcRating: 'C' })
    );
    expect(match?.confidence).toBe('best_guess');
  });

  it('does not score the band when the listing has none', () => {
    const match = findBestMatch(street, listing({ epcRating: 'Not required' }));
    expect(match?.confidence).toBe('best_guess');
    expect(match?.reasons).not.toContain('EPC rating');
  });
});

describe("enrichWithEpc keeps the listing's own rating", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubSearch(rows: Array<Record<string, unknown>>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const isSearch = url.includes('/api/domestic/search');
      return new Response(JSON.stringify(isSearch ? { data: rows } : {}), { status: isSearch ? 200 : 404 });
    }));
  }

  const row = (line1: string, band: string) => ({
    certificateNumber: `cert-${line1}`,
    addressLine1: line1,
    postcode: 'CF14 0SN',
    postTown: 'CARDIFF',
    currentEnergyEfficiencyBand: band,
    registrationDate: '2024-01-01',
    uprn: line1,
  });

  it('keeps the listing rating over the matched certificate', async () => {
    stubSearch([row('3 Maple Road', 'D')]);
    const result = await enrichWithEpc('token', listing({ epcRating: 'C' }));
    expect(result.listing.fullAddress).toContain('3 Maple Road');
    expect(result.listing.epcRating).toBe('C');
  });

  it('does not borrow a rating from a best guess', async () => {
    stubSearch([row('1 Maple Road', 'D'), row('3 Maple Road', 'E')]);
    const result = await enrichWithEpc('token', listing());
    expect(result.listing.addressConfidence).toBe('best_guess');
    expect(result.listing.epcRating).toBeNull();
    expect(result.listing.addressCandidates?.map((c) => c.fullAddress)).toEqual(['1 Maple Road, CARDIFF', '3 Maple Road, CARDIFF']);
  });

  it('uses the certificate rating on an exact match when the listing has none', async () => {
    stubSearch([row('3 Maple Road', 'B'), row('9 Oak Close', 'D')]);
    const result = await enrichWithEpc('token', listing());
    expect(result.listing.addressConfidence).toBe('exact');
    expect(result.listing.epcRating).toBe('B');
  });
});
