import { describe, expect, it } from 'vitest';
import type { AddressCandidate, PropertyListing } from '../src/adapters/types';
import { chooseCandidate, keepUserChoice, mapsLink, reuseKnownAddress } from '../src/services/address-choice';

const candidate = (n: number): AddressCandidate => ({
  fullAddress: `${n} Lyric Way, Thornhill, CARDIFF`,
  postcode: 'CF14 9BP',
  certificateNumber: `cert-${n}`,
  epcRating: 'C',
});

function listing(extra: Partial<PropertyListing> = {}): PropertyListing {
  return {
    listingId: '1',
    source: 'zoopla',
    url: 'https://example.test',
    displayAddress: 'Lyric Way, Thornhill, Cardiff CF14',
    postcode: 'CF14 9BP',
    postcodePartial: 'CF14',
    fullAddress: '50 Lyric Way, Thornhill, CARDIFF',
    addressConfidence: 'best_guess',
    addressCandidates: [candidate(50), candidate(52), candidate(54)],
    enrichmentDetail: '3 homes in CF14 9BP are close, so this is a best guess',
    price: null,
    priceQualifier: null,
    currency: 'GBP',
    listingType: 'sale',
    bedrooms: 2,
    propertyType: 'terraced',
    agentName: null,
    agentPhone: null,
    agentBranch: null,
    latitude: null,
    longitude: null,
    tenure: null,
    furnished: null,
    deposit: null,
    epcRating: 'C',
    capturedAt: '2026-10-18T00:00:00Z',
    ...extra,
  };
}

describe('chooseCandidate', () => {
  it('makes the picked home the full address', () => {
    const chosen = chooseCandidate(listing(), 'cert-52');
    expect(chosen.fullAddress).toBe('52 Lyric Way, Thornhill, CARDIFF');
    expect(chosen.addressConfidence).toBe('user_choice');
    expect(chosen.enrichmentDetail).toBe('Chosen by you from 3 close homes');
    // The list stays, so the user can change their mind
    expect(chosen.addressCandidates).toHaveLength(3);
  });

  it('refuses a home that is not a close home', () => {
    expect(() => chooseCandidate(listing(), 'cert-99')).toThrow();
  });
});

describe('keepUserChoice', () => {
  const picked = chooseCandidate(listing(), 'cert-52');

  it('keeps the pick when the listing is captured again', () => {
    const kept = keepUserChoice(picked, listing());
    expect(kept.fullAddress).toBe('52 Lyric Way, Thornhill, CARDIFF');
    expect(kept.addressConfidence).toBe('user_choice');
  });

  it('lets an exact match or a new postcode win', () => {
    expect(keepUserChoice(picked, listing({ fullAddress: '54 Lyric Way', addressConfidence: 'exact' })).fullAddress).toBe('54 Lyric Way');
    expect(keepUserChoice(picked, listing({ postcode: 'CF14 9BQ' })).addressConfidence).toBe('best_guess');
  });

  it('does nothing when there was no pick', () => {
    const next = listing();
    expect(keepUserChoice(listing(), next)).toBe(next);
    expect(keepUserChoice(undefined, next)).toBe(next);
  });
});

describe('reuseKnownAddress', () => {
  // What the site gives on a new capture: no full address yet
  const fresh = (extra: Partial<PropertyListing> = {}) =>
    listing({ fullAddress: null, addressConfidence: null, addressCandidates: null, enrichmentDetail: null, epcRating: null, ...extra });
  const exact = listing({ fullAddress: '50 Lyric Way, Thornhill, CARDIFF', addressConfidence: 'exact', addressCandidates: null, enrichmentDetail: 'Exact: matched on house number', epcRating: 'B' });

  it('uses an exact match again, with the rating it lent', () => {
    const known = reuseKnownAddress(exact, fresh({ price: 250_000 }));
    expect(known?.fullAddress).toBe('50 Lyric Way, Thornhill, CARDIFF');
    expect(known?.addressConfidence).toBe('exact');
    expect(known?.enrichmentDetail).toBe('Exact: matched on house number');
    expect(known?.epcRating).toBe('B');
    // The new capture's own figures come through
    expect(known?.price).toBe(250_000);
  });

  it("keeps the listing's own rating over the certificate's", () => {
    expect(reuseKnownAddress(exact, fresh({ epcRating: 'C' }))?.epcRating).toBe('C');
  });

  it("uses the user's pick again, with the homes to choose from", () => {
    const picked = chooseCandidate(listing(), 'cert-52');
    const known = reuseKnownAddress(picked, fresh());
    expect(known?.fullAddress).toBe('52 Lyric Way, Thornhill, CARDIFF');
    expect(known?.addressConfidence).toBe('user_choice');
    expect(known?.addressCandidates).toHaveLength(3);
    // A pick never lends a certificate's rating
    expect(known?.epcRating).toBeNull();
  });

  it('asks the register again for a best guess, a new postcode or a new address', () => {
    expect(reuseKnownAddress(listing(), fresh())).toBeNull();
    expect(reuseKnownAddress(exact, fresh({ postcode: 'CF14 9BQ' }))).toBeNull();
    expect(reuseKnownAddress(exact, fresh({ displayAddress: 'Lyric Way, Cardiff CF14' }))).toBeNull();
    expect(reuseKnownAddress(undefined, fresh())).toBeNull();
  });

  it('matches the postcode and address however they are spaced', () => {
    expect(reuseKnownAddress(exact, fresh({ postcode: 'cf149bp', displayAddress: 'Lyric Way,  Thornhill, Cardiff CF14' }))).not.toBeNull();
  });

  it('matches again when the details the match used have changed', () => {
    expect(reuseKnownAddress(exact, fresh({ floorAreaSqm: 72 }))).toBeNull();
    expect(reuseKnownAddress(exact, fresh({ bedrooms: 3 }))).toBeNull();
    expect(reuseKnownAddress(exact, fresh({ propertyType: 'semi-detached' }))).toBeNull();
    expect(reuseKnownAddress(exact, fresh({ numberFromText: '12' }))).toBeNull();
  });
});

describe('mapsLink', () => {
  it('searches the address with its postcode', () => {
    expect(mapsLink('52 Lyric Way, Thornhill, CARDIFF', 'CF14 9BP'))
      .toBe('https://www.google.com/maps/search/?api=1&query=52%20Lyric%20Way%2C%20Thornhill%2C%20CARDIFF%2C%20CF14%209BP');
  });
});
