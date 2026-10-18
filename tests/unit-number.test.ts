import { describe, expect, it } from 'vitest';
import type { EpcResult, PropertyListing } from '../src/adapters/types';
import { findUnitNumberInText, streetName } from '../src/adapters/unit-number';
import { findBestMatch, unitNumber } from '../src/services/epc-match';

describe('findUnitNumberInText', () => {
  const address = 'Kings Court, Bristol BS37';

  it('reads a flat or apartment number', () => {
    expect(findUnitNumberInText(['Flat 12 is a bright second floor apartment'], address)).toBe('12');
    expect(findUnitNumberInText(['Welcome to Apartment 4b, a stylish home'], address)).toBe('4b');
    expect(findUnitNumberInText(['<p>Unit No. 7<br>Offered with no chain</p>'], address)).toBe('7');
  });

  it('reads a number written in front of the street name', () => {
    expect(findUnitNumberInText(['22 Kings Court is a well presented home'], address)).toBe('22');
    expect(findUnitNumberInText(['A 3 bed house. 14 Maple  Road has a garden'], 'Maple Road, Cardiff CF14')).toBe('14');
  });

  it('ignores counts, sizes and prices', () => {
    expect(findUnitNumberInText([
      'Apartment 2 bedrooms, flat 1 mile from the station, unit 3 x 4m',
      'Asking £250,000 Kings Court',
      'Ground floor flat, 1st floor bathroom',
    ], address)).toBeNull();
  });

  it('gives up when the text names two different numbers', () => {
    expect(findUnitNumberInText(['Flat 3 and Flat 5 are both available'], address)).toBeNull();
    expect(findUnitNumberInText(['Flat 3', 'FLAT 3 has a balcony'], address)).toBe('3');
  });

  it('only uses a street name without a number', () => {
    expect(streetName('Maple Road, Cardiff')).toBe('Maple Road');
    expect(streetName('12 Maple Road, Cardiff')).toBeNull();
    expect(streetName('Cardiff')).toBeNull();
  });
});

describe('unitNumber', () => {
  it('prefers the flat number over the building number', () => {
    expect(unitNumber(['Flat 12', '3 High Street'])).toBe('12');
    expect(unitNumber(['12 Kings Court'])).toBe('12');
    expect(unitNumber(['Kings Court'])).toBeNull();
  });
});

describe('findBestMatch with a number from the listing text', () => {
  // A block of identical flats with no number in the listing address
  const flats: EpcResult[] = Array.from({ length: 41 }, (_, i) => ({
    addressLines: [`Flat ${i + 1}`, 'Kings Court'],
    postTown: 'Bristol',
    postcode: 'BS37 4LQ',
    currentEnergyRating: 'C',
    registrationDate: '2024-01-01',
    certificateNumber: `cert-${i + 1}`,
    uprn: String(i + 1),
    propertyType: 'Flat',
  }));

  const listing = (extra: Partial<PropertyListing> = {}): PropertyListing => ({
    listingId: '1', source: 'rightmove', url: 'https://example.test',
    displayAddress: 'Kings Court, Bristol BS37', postcode: 'BS37 4LQ', postcodePartial: 'BS37',
    fullAddress: null, price: null, priceQualifier: null, currency: 'GBP', listingType: 'sale',
    bedrooms: 2, propertyType: 'Flat', agentName: null, agentPhone: null, agentBranch: null,
    latitude: null, longitude: null, tenure: null, furnished: null, deposit: null, epcRating: null,
    capturedAt: '2026-10-18T00:00:00Z', ...extra,
  });

  it('stays a best guess without it', () => {
    const match = findBestMatch(flats, listing());
    expect(match?.confidence).toBe('best_guess');
    expect(match?.tiedCount).toBe(41);
  });

  it('picks the flat the text names', () => {
    const match = findBestMatch(flats, listing({ numberFromText: '12' }));
    expect(match?.result.addressLines[0]).toBe('Flat 12');
    expect(match?.confidence).toBe('exact');
    expect(match?.reasons).toContain('number in listing text');
  });

  it('changes nothing when no certificate has that number', () => {
    expect(findBestMatch(flats, listing({ numberFromText: '99' }))?.confidence).toBe('best_guess');
  });

  it('never overrides a number shown in the address', () => {
    const match = findBestMatch(flats, listing({ displayAddress: 'Flat 5, Kings Court, Bristol', numberFromText: '12' }));
    expect(match?.result.addressLines[0]).toBe('Flat 5');
  });
});
