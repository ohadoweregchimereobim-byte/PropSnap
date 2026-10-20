import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { enrichWithEpc } from '../src/services/epc-api';

// A made-up block of flats where every flat looks the same in the search
// results. Only the full certificate tells them apart.
function listing(extra: Partial<PropertyListing> = {}): PropertyListing {
  return {
    listingId: '1',
    source: 'zoopla',
    url: 'https://example.test',
    displayAddress: 'Ferry Court, Cardiff',
    postcode: 'CF11 0AS',
    postcodePartial: 'CF11',
    fullAddress: null,
    price: null,
    priceQualifier: null,
    currency: 'GBP',
    listingType: 'sale',
    bedrooms: 2,
    propertyType: 'Flat',
    floorAreaSqm: 60,
    agentName: null,
    agentPhone: null,
    agentBranch: null,
    latitude: null,
    longitude: null,
    tenure: null,
    furnished: null,
    deposit: null,
    epcRating: null,
    capturedAt: '2026-10-18T00:00:00Z',
    ...extra,
  };
}

const flat = (n: number) => ({
  certificateNumber: `cert-${n}`,
  addressLine1: `Flat ${n}`,
  addressLine2: 'Ferry Court',
  postcode: 'CF11 0AS',
  postTown: 'CARDIFF',
  currentEnergyEfficiencyBand: 'C',
  registrationDate: '2024-01-01',
  uprn: String(n),
});

/** Flat 1 is the only one with the listing's floor area */
function stubBlock(flats: number) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/api/domestic/search')) {
      return new Response(JSON.stringify({ data: Array.from({ length: flats }, (_, i) => flat(i + 1)) }));
    }
    const area = url.endsWith('certificate_number=cert-1') ? 60 : 90;
    return new Response(JSON.stringify({ data: { dwelling_type: 'Mid-floor flat', total_floor_area: area } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('certificate lookups for close calls', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls a home exact when every close call was checked', async () => {
    stubBlock(4);
    const result = await enrichWithEpc('token', listing());
    expect(result.listing.fullAddress).toContain('Flat 1,');
    expect(result.listing.addressConfidence).toBe('exact');
    expect(result.listing.addressCandidates).toBeNull();
  });

  it('says when the floor area came from the description', async () => {
    stubBlock(4);
    const result = await enrichWithEpc('token', listing({ floorAreaSource: 'text' }));
    expect(result.listing.addressConfidence).toBe('exact');
    expect(result.enrichmentDetail).toContain('floor area from the description');
  });

  it('stays a best guess when some close calls were never checked', async () => {
    const fetchMock = stubBlock(12);
    const result = await enrichWithEpc('token', listing());

    const lookups = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/certificate'));
    expect(lookups).toHaveLength(10);
    expect(result.listing.fullAddress).toContain('Flat 1,');
    expect(result.listing.addressConfidence).toBe('best_guess');
    expect(result.enrichmentDetail).toContain('2 close homes in CF11 0AS could not be checked');
    // A best guess never lends its rating to the listing
    expect(result.listing.epcRating).toBeNull();
    // All 12 flats we could not tell apart are offered to choose from, best guess first
    expect(result.listing.addressCandidates).toHaveLength(12);
    expect(result.listing.addressCandidates?.[0]?.fullAddress).toContain('Flat 1,');
  });
});
