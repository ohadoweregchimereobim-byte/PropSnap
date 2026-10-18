import { describe, expect, it } from 'vitest';
import type { EpcResult, PropertyListing } from '../src/adapters/types';
import { extractNumbers, findBestMatch, latestPerHome, typeCategory } from '../src/services/epc-match';
import { readDetails } from '../src/services/epc-api';
import { floorAreaFromSizings } from '../src/adapters/rightmove';
import { floorAreaFromJsonLd, floorAreaFromPageData } from '../src/adapters/zoopla';

// Made-up homes on one made-up street, all sharing a postcode
function home(line1: string, extra: Partial<EpcResult> = {}): EpcResult {
  return {
    addressLines: [line1],
    postTown: 'Cardiff',
    postcode: 'CF14 0SN',
    currentEnergyRating: 'C',
    registrationDate: '2024-01-01',
    certificateNumber: `cert-${line1}`,
    uprn: line1,
    ...extra,
  };
}

function listing(extra: Partial<PropertyListing> = {}): PropertyListing {
  return {
    listingId: '1',
    source: 'rightmove',
    url: 'https://example.test',
    displayAddress: 'Maple Road, Cardiff',
    postcode: 'CF14 0SN',
    postcodePartial: 'CF14',
    fullAddress: null,
    price: null,
    priceQualifier: null,
    currency: 'GBP',
    listingType: 'sale',
    bedrooms: 3,
    propertyType: 'Semi-Detached',
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

const street = [
  home('10 Maple Road', { propertyType: 'House', builtForm: 'Semi-Detached', floorAreaSqm: 85, habitableRooms: 5 }),
  home('12 Maple Road', { propertyType: 'House', builtForm: 'Semi-Detached', floorAreaSqm: 112, habitableRooms: 5 }),
  home('14 Maple Road', { propertyType: 'House', builtForm: 'Mid-Terrace', floorAreaSqm: 70, habitableRooms: 4 }),
  home('Flat 1, 16 Maple Road', { propertyType: 'Flat', builtForm: 'Detached', floorAreaSqm: 110, habitableRooms: 3 }),
];

describe('findBestMatch', () => {
  it('is only a best guess when the street name is all we have', () => {
    const bare = street.map((r) => ({ ...r, propertyType: null, builtForm: null, floorAreaSqm: null, habitableRooms: null }));
    const match = findBestMatch(bare, listing({ propertyType: null, bedrooms: null }));
    expect(match?.confidence).toBe('best_guess');
    expect(match?.tiedCount).toBe(4);
  });

  it('picks the home with the matching floor area', () => {
    const match = findBestMatch(street, listing({ floorAreaSqm: 110 }));
    expect(match?.result.addressLines[0]).toBe('12 Maple Road');
    expect(match?.confidence).toBe('exact');
    expect(match?.reasons).toContain('floor area');
  });

  it('rules out a flat when the listing is a house, even with the same floor area', () => {
    const match = findBestMatch(street, listing({ floorAreaSqm: 110 }));
    expect(match?.result.addressLines[0]).not.toContain('Flat');
  });

  it('uses the house number when the listing shows one', () => {
    const match = findBestMatch(street, listing({ displayAddress: '14 Maple Road, Cardiff', propertyType: null }));
    expect(match?.result.addressLines[0]).toBe('14 Maple Road');
    expect(match?.confidence).toBe('exact');
    expect(match?.reasons).toContain('house number');
  });

  it('finds no match when no certificate has the listing\'s house number', () => {
    expect(findBestMatch(street, listing({ displayAddress: '99 Maple Road, Cardiff' }))).toBeNull();
  });

  it('understands full-certificate dwelling types like "Mid-floor flat"', () => {
    const homes = [
      home('Flat 1, 20 Maple Road', { propertyType: 'Mid-floor flat', floorAreaSqm: 60 }),
      home('22 Maple Road', { propertyType: 'Semi-detached house', floorAreaSqm: 60 }),
    ];
    const match = findBestMatch(homes, listing({ floorAreaSqm: 60 }));
    expect(match?.result.addressLines[0]).toBe('22 Maple Road');
  });

  it('stays a best guess when two homes are equally close', () => {
    const twins = [
      home('10 Maple Road', { propertyType: 'House', builtForm: 'Semi-Detached', floorAreaSqm: 90 }),
      home('12 Maple Road', { propertyType: 'House', builtForm: 'Semi-Detached', floorAreaSqm: 91 }),
    ];
    const match = findBestMatch(twins, listing({ floorAreaSqm: 90 }));
    expect(match?.confidence).toBe('best_guess');
    expect(match?.tiedCount).toBe(2);
  });
});

describe('helpers', () => {
  it('pulls house and flat numbers out of an address, ignoring outcodes', () => {
    expect(extractNumbers('Flat 3, 12a High Street, SW1')).toEqual(['3', '12a']);
    expect(extractNumbers('High Street, London SW1A')).toEqual([]);
  });

  it('sorts listing and EPC types into flat or house', () => {
    expect(typeCategory('Apartment')).toBe('flat');
    expect(typeCategory('semi_detached')).toBe('house');
    expect(typeCategory('End of Terrace')).toBe('house');
    expect(typeCategory('Bungalow')).toBe('house');
    expect(typeCategory('Land')).toBeNull();
  });

  it('keeps only the newest certificate per home', () => {
    const old = home('10 Maple Road', { registrationDate: '2015-01-01', currentEnergyRating: 'E' });
    const recent = home('10 Maple Road', { registrationDate: '2023-01-01', currentEnergyRating: 'C' });
    expect(latestPerHome([old, recent])).toEqual([recent]);
  });

  it('reads certificate details whatever the field naming', () => {
    expect(readDetails({ data: { propertyType: 'House', builtForm: 'Detached', totalFloorArea: '95.5', numberHabitableRooms: 5 } }))
      .toEqual({ propertyType: 'House', builtForm: 'Detached', floorAreaSqm: 95.5, habitableRooms: 5 });
    expect(readDetails({ rows: [{ 'property-type': 'Flat', 'total-floor-area': 48 }] }))
      .toEqual({ propertyType: 'Flat', floorAreaSqm: 48 });
    expect(readDetails({ data: { dwelling_type: 'Mid-terrace house', habitable_room_count: 4, total_floor_area: 72 } }))
      .toEqual({ propertyType: 'Mid-terrace house', floorAreaSqm: 72, habitableRooms: 4 });
    expect(readDetails({ unrelated: true })).toEqual({});
  });

  it('reads floor area from Rightmove sizings', () => {
    expect(floorAreaFromSizings([{ unit: 'sqft', maximumSize: 1076 }, { unit: 'sqm', maximumSize: 100 }])).toBe(100);
    expect(floorAreaFromSizings([{ unit: 'sqft', minimumSize: 1076 }])).toBe(100);
    expect(floorAreaFromSizings([])).toBeNull();
  });

  it('reads floor area from Zoopla JSON-LD', () => {
    expect(floorAreaFromJsonLd({ offers: { itemOffered: { floorSize: { value: 1076, unitCode: 'FTK' } } } })).toBe(100);
    expect(floorAreaFromJsonLd({ floorSize: { value: 80, unitCode: 'MTK' } })).toBe(80);
    expect(floorAreaFromJsonLd({ name: 'x' })).toBeNull();
  });

  it('reads floor area from Zoopla page data when JSON-LD has none', () => {
    expect(floorAreaFromPageData('{"value":624,"unitsLabel":"sq. ft"}', null)).toBe(58);
    expect(floorAreaFromPageData('{"value":58,"unitsLabel":"sq. m"}', null)).toBe(58);
    expect(floorAreaFromPageData(null, '624')).toBe(58);
    expect(floorAreaFromPageData(null, '1,076')).toBe(100);
    expect(floorAreaFromPageData(null, '')).toBeNull();
  });
});
