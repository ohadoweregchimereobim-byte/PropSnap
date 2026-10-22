import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { enrichWithEpc, readDetails } from '../src/services/epc-api';

// Trimmed from a real RdSAP-Schema-17.0 certificate (2026 API): the type is
// wrapped, type and form also come as codes, and every floor repeats its own area
const rdsapCertificate = {
  data: {
    built_form: 1,
    schema_type: 'RdSAP-Schema-17.0',
    dwelling_type: { value: 'Detached house', language: '1' },
    property_type: 0,
    total_floor_area: 390,
    heated_room_count: 11,
    habitable_room_count: 11,
    sap_building_parts: [
      {
        sap_floor_dimensions: [
          { floor: 0, total_floor_area: { value: 137.1, quantity: 'square metres' } },
          { floor: 1, total_floor_area: { value: 131.91, quantity: 'square metres' } },
        ],
      },
    ],
  },
};

describe('readDetails on the 2026 certificate shape', () => {
  it('reads the wrapped type, the form code and the whole-home floor area', () => {
    expect(readDetails(rdsapCertificate)).toEqual({
      propertyType: 'Detached house',
      builtForm: 'Detached',
      floorAreaSqm: 390,
      habitableRooms: 11,
    });
  });

  it('falls back to the type and form codes when there are no words', () => {
    expect(readDetails({ data: { property_type: 2, built_form: 4 } })).toEqual({ propertyType: 'Flat', builtForm: 'Mid-Terrace' });
    expect(readDetails({ data: { property_type: '1' } })).toEqual({ propertyType: 'Bungalow' });
  });

  it('ignores unknown codes', () => {
    expect(readDetails({ data: { property_type: 9, built_form: 0 } })).toEqual({});
  });

  it('never takes one floor\'s area as the whole home', () => {
    const { total_floor_area, ...noTotal } = rdsapCertificate.data;
    expect(readDetails({ data: noTotal }).floorAreaSqm).toBeUndefined();
  });
});

describe('Mockbeggar, BH24 3NQ (live capture)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const row = (cert: string, line1: string, band: string) => ({
    certificateNumber: cert,
    addressLine1: line1,
    addressLine2: 'Mockbeggar',
    postTown: 'RINGWOOD',
    postcode: 'BH24 3NQ',
    currentEnergyEfficiencyBand: band,
    registrationDate: '2024-01-01',
    uprn: cert,
  });

  const listing: PropertyListing = {
    listingId: '94276089',
    source: 'rightmove',
    url: 'https://www.rightmove.co.uk/properties/94276089',
    displayAddress: 'Mockbeggar, Ringwood, Hampshire, BH24',
    postcode: 'BH24 3NQ',
    postcodePartial: 'BH24',
    fullAddress: null,
    price: 2700000,
    priceQualifier: 'Guide Price',
    currency: 'GBP',
    listingType: 'sale',
    bedrooms: 6,
    propertyType: 'Detached',
    floorAreaSqm: 466,
    agentName: null,
    agentPhone: null,
    agentBranch: null,
    latitude: null,
    longitude: null,
    tenure: 'Freehold',
    furnished: null,
    deposit: null,
    epcRating: null,
    capturedAt: '2026-10-20T10:05:00Z',
  };

  it('picks Crossley Towers, the home on the floor plans, as an exact match', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/domestic/search')) {
        return new Response(JSON.stringify({ data: [row('cross-lanes', '3 Cross Lanes', 'E'), row('crossley', 'Crossley Towers', 'D')] }));
      }
      // 3 Cross Lanes has the older plain shape; Crossley Towers the 2026 one
      const body = url.endsWith('certificate_number=crossley')
        ? rdsapCertificate
        : { data: { dwelling_type: 'Detached house', total_floor_area: 130, habitable_room_count: 8 } };
      return new Response(JSON.stringify(body));
    }));

    const result = await enrichWithEpc('token', listing);
    expect(result.listing.fullAddress).toBe('Crossley Towers, Mockbeggar, RINGWOOD');
    expect(result.listing.addressConfidence).toBe('exact');
    expect(result.enrichmentDetail).toContain('property type');
    expect(result.enrichmentDetail).toContain('floor area');
  });
});
