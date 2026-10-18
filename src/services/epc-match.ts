import type { EpcResult, PropertyListing } from '../adapters/types';
import { epcBand } from '../adapters/epc-band';

/**
 * Ranking EPC certificates against a listing.
 *
 * Pure functions only (no network), so the ranking can be tested with
 * made-up postcode data. epc-api.ts does the fetching and calls these.
 *
 * Signals, strongest first:
 * - House / flat number: if the listing shows one, a certificate with a
 *   different number is ruled out. If the address hides it but the listing
 *   text names one ("Flat 12"), the certificate with that number gets a bonus.
 * - Floor area: within 10% of the listing is strong evidence, a big gap counts against.
 * - Property type: a flat vs house clash rules a home out; built form
 *   (detached, semi, terrace) adds a little.
 * - Habitable rooms: usually bedrooms + 1 or 2 (living room, dining room).
 * - EPC band: when the listing shows one, homes with the same band (A-G) get a bonus.
 * - Street words and postcode, as before.
 */

/** Score gap the winner needs over the runner-up to be called "exact" */
export const CLEAR_WIN_MARGIN = 2;

export interface ScoredCandidate {
  result: EpcResult;
  score: number;
  excluded: boolean;
  /** Short labels for what counted in this home's favour, e.g. "floor area" */
  reasons: string[];
  wordMatches: number;
}

export interface EpcMatch {
  result: EpcResult;
  confidence: 'exact' | 'best_guess';
  /** How many homes were still in contention (within the win margin), 1 for a clear winner */
  tiedCount: number;
  /** What decided it, e.g. ["house number", "floor area"] */
  reasons: string[];
}

/** "cf14 0sn", "CF14+0SN" and "CF140SN" all become "CF140SN" */
export function normalisePostcode(postcode: string): string {
  return postcode.toUpperCase().replace(/[\s+]/g, '');
}

/**
 * House and flat numbers in an address, e.g. "Flat 3, 12a High Street" → ["3", "12a"].
 * Outcodes like "SW1" are not numbers on their own, so they are skipped.
 */
export function extractNumbers(address: string): string[] {
  return address
    .toLowerCase()
    .split(/[\s,]+/)
    .map((token) => token.replace(/[^a-z0-9-]/g, ''))
    .flatMap((token) => token.split('-')) // "10-12" → both numbers
    .filter((token) => /^\d+[a-z]?$/.test(token));
}

/**
 * The number that tells homes apart in a certificate address:
 * "Flat 12, 3 High Street" → "12", "12 Kings Court" → "12".
 */
export function unitNumber(addressLines: string[]): string | null {
  const address = addressLines.join(' ');
  const unit = address.match(/\b(?:flat|apartment|apt\.?|unit|maisonette)\s*(\d+[a-z]?)\b/i);
  if (unit) return unit[1]!.toLowerCase();
  return extractNumbers(address)[0] ?? null;
}

type TypeCategory = 'flat' | 'house';
type BuiltForm = 'detached' | 'semi' | 'terrace';

/** Listing and EPC types both map onto flat vs house */
export function typeCategory(type: string | null | undefined): TypeCategory | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (/flat|apartment|maisonette|studio|penthouse/.test(t)) return 'flat';
  if (/house|detached|semi|terrace|bungalow|cottage|villa/.test(t)) return 'house';
  return null;
}

export function builtForm(type: string | null | undefined): BuiltForm | null {
  if (!type) return null;
  const t = type.toLowerCase().replace(/[_-]/g, ' ');
  if (/semi/.test(t)) return 'semi';
  if (/terrace/.test(t)) return 'terrace';
  if (/detached/.test(t)) return 'detached';
  return null;
}

/** Score every candidate. Excluded ones are kept (with excluded=true) so callers can explain why. */
export function scoreCandidates(results: EpcResult[], listing: PropertyListing): ScoredCandidate[] {
  const listingWords = listing.displayAddress
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((w) => w.length > 2);
  const listingPostcode = listing.postcode ? normalisePostcode(listing.postcode) : null;
  const listingNumbers = extractNumbers(listing.displayAddress);
  const listingTextNumber = listing.numberFromText?.toLowerCase() ?? null;
  const listingCategory = typeCategory(listing.propertyType);
  const listingForm = builtForm(listing.propertyType);
  const listingBand = epcBand(listing.epcRating);

  return results.map((result) => {
    const reasons: string[] = [];
    let score = 0;
    let excluded = false;

    const epcAddress = [...result.addressLines, result.postTown].join(' ').toLowerCase();
    const wordMatches = listingWords.filter((word) => epcAddress.includes(word)).length;
    score += wordMatches;
    if (wordMatches > 0) reasons.push('street name');

    if (listingPostcode && normalisePostcode(result.postcode) === listingPostcode) {
      score += 5;
    }

    // House / flat number: every number the listing shows must be on the certificate
    if (listingNumbers.length > 0) {
      const epcNumbers = new Set(extractNumbers(result.addressLines.join(' ')));
      if (listingNumbers.every((n) => epcNumbers.has(n))) {
        score += 6;
        reasons.push('house number');
      } else {
        excluded = true;
      }
    } else if (listingTextNumber && unitNumber(result.addressLines) === listingTextNumber) {
      // Softer than the address: the text could mention another flat, so no one is ruled out
      score += 4;
      reasons.push('number in listing text');
    }

    // Property type: flat vs house is a hard clash, built form a soft bonus
    const epcCategory = typeCategory(result.propertyType) ?? typeCategory(result.builtForm);
    if (listingCategory && epcCategory) {
      if (listingCategory !== epcCategory) {
        excluded = true;
      } else {
        score += 2;
        reasons.push('property type');
      }
    }
    const epcForm = builtForm(result.builtForm ?? result.propertyType);
    if (listingForm && epcForm) {
      score += listingForm === epcForm ? 1 : -1;
    }

    // EPC band: the listing's rating comes from this home's own certificate
    if (listingBand && epcBand(result.currentEnergyRating) === listingBand) {
      score += 2;
      reasons.push('EPC rating');
    }

    // Floor area
    if (listing.floorAreaSqm && result.floorAreaSqm) {
      const diff = Math.abs(result.floorAreaSqm - listing.floorAreaSqm) / listing.floorAreaSqm;
      if (diff <= 0.1) {
        score += 4;
        reasons.push('floor area');
      } else if (diff <= 0.2) {
        score += 2;
        reasons.push('floor area');
      } else if (diff > 0.35) {
        score -= 2;
      }
    }

    // Habitable rooms are bedrooms plus living/dining rooms
    if (listing.bedrooms != null && result.habitableRooms != null) {
      const extra = result.habitableRooms - listing.bedrooms;
      if (extra >= 1 && extra <= 2) {
        score += 1;
        reasons.push('room count');
      } else if (extra < 0) {
        score -= 2;
      }
    }

    return { result, score, excluded, reasons, wordMatches };
  });
}

/**
 * Candidates still in the running: not excluded and within the win margin of the top score.
 * These are the homes worth looking up in more detail.
 */
export function closeCalls(scored: ScoredCandidate[]): ScoredCandidate[] {
  const live = scored.filter((s) => !s.excluded).sort((a, b) => b.score - a.score);
  const top = live[0];
  if (!top) return [];
  return live.filter((s) => top.score - s.score < CLEAR_WIN_MARGIN);
}

/**
 * Pick the best certificate for the listing.
 *
 * "exact" needs a single home that beats every other by CLEAR_WIN_MARGIN and
 * has some real evidence beyond the postcode (street words, house number,
 * floor area...). Anything else is a "best_guess".
 */
export function findBestMatch(epcResults: EpcResult[], listing: PropertyListing): EpcMatch | null {
  if (epcResults.length === 0) return null;

  const scored = scoreCandidates(epcResults, listing);
  const live = scored.filter((s) => !s.excluded).sort((a, b) => b.score - a.score);
  const best = live[0];
  if (!best || best.score < 2) return null;

  const contenders = closeCalls(scored);
  const hasEvidence = best.reasons.length > 0;

  return {
    result: best.result,
    confidence: contenders.length === 1 && hasEvidence ? 'exact' : 'best_guess',
    tiedCount: contenders.length,
    reasons: best.reasons,
  };
}

/**
 * A home can have several certificates over the years. Keep only the newest
 * per home, so one house is never counted as two equally good candidates.
 */
export function latestPerHome(results: EpcResult[]): EpcResult[] {
  const byHome = new Map<string, EpcResult>();

  for (const result of results) {
    const key = result.uprn
      ?? `${result.addressLines.join(' ').toLowerCase()}|${normalisePostcode(result.postcode)}`;
    const existing = byHome.get(key);
    if (!existing || result.registrationDate > existing.registrationDate) {
      byHome.set(key, result);
    }
  }

  return [...byHome.values()];
}
