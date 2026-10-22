import { describe, expect, it } from 'vitest';
import type { EpcResult, PropertyListing } from '../src/adapters/types';
import { closeCalls, findBestMatch, scoreCandidates } from '../src/services/epc-match';
import { readDetails } from '../src/services/epc-api';

// Made-up Milton Grove: a street of detached homes, some bungalows, some houses
function home(line1: string, details: Partial<EpcResult>): EpcResult {
  return {
    addressLines: [line1, 'Milton Grove'],
    postTown: 'NEW MILTON',
    postcode: 'BH25 6HB',
    currentEnergyRating: 'D',
    registrationDate: '2024-01-01',
    certificateNumber: `cert-${line1}`,
    uprn: line1,
    habitableRooms: 5,
    ...details,
  };
}

const listing: PropertyListing = {
  listingId: '93534894',
  source: 'rightmove',
  url: 'https://www.rightmove.co.uk/properties/93534894',
  displayAddress: 'Milton Grove, New Milton, Hampshire',
  postcode: 'BH25 6HB',
  postcodePartial: 'BH25',
  fullAddress: null,
  price: 415000,
  priceQualifier: 'Offers in Excess of',
  currency: 'GBP',
  listingType: 'sale',
  bedrooms: 3,
  propertyType: 'Detached Bungalow',
  agentName: null,
  agentPhone: null,
  agentBranch: null,
  latitude: null,
  longitude: null,
  tenure: 'Freehold',
  furnished: null,
  deposit: null,
  epcRating: null,
  capturedAt: '2026-10-22T09:00:00Z',
};

const street = [
  home('1', { propertyType: 'Detached house' }),
  home('3', { propertyType: 'Detached bungalow' }),
  // 2026 certificates give codes: property_type 1 (Bungalow), built_form 1 (Detached)
  home('5', readDetails({ data: { property_type: 1, built_form: 1 } })),
  home('7', { propertyType: 'Detached house' }),
];

describe('bungalow points', () => {
  it('puts bungalows ahead of houses and says why', () => {
    const match = findBestMatch(street, listing);
    expect(['3', '5']).toContain(match?.result.addressLines[0]);
    expect(match?.reasons).toContain('bungalow');
    expect(match?.others.map((r) => r.addressLines[0]).slice(0, 1)).toEqual([match?.result.addressLines[0] === '3' ? '5' : '3']);
  });

  it('never rules a house out: a chalet bungalow can be recorded as a house', () => {
    const scored = scoreCandidates(street, listing);
    expect(scored.every((s) => !s.excluded)).toBe(true);
    expect(closeCalls(scored)).toHaveLength(4);
  });

  it('stays a best guess when more than one bungalow fits', () => {
    expect(findBestMatch(street, listing)?.confidence).toBe('best_guess');
  });

  it('gives no bungalow points when the listing is a house', () => {
    const match = findBestMatch(street, { ...listing, propertyType: 'Detached house' });
    expect(match?.reasons).not.toContain('bungalow');
  });
});
