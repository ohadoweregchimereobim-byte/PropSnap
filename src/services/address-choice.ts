import type { PropertyListing } from '../adapters/types';
import { normalisePostcode } from './epc-match';

/**
 * Letting the user pick the right home when the EPC match is a best guess.
 * Pure, so it is unit tested without a browser.
 */

/** Make the chosen candidate the listing's full address */
export function chooseCandidate(listing: PropertyListing, certificateNumber: string): PropertyListing {
  const candidates = listing.addressCandidates ?? [];
  const chosen = candidates.find((c) => c.certificateNumber === certificateNumber);
  if (!chosen) throw new Error('That home is not one of the close homes for this listing');

  return {
    ...listing,
    fullAddress: chosen.fullAddress,
    addressConfidence: 'user_choice',
    enrichmentDetail: `Chosen by you from ${candidates.length} close homes`,
  };
}

/**
 * A new capture of a listing the user already picked a home for keeps that
 * pick, as long as the postcode is the same. Otherwise the new capture wins.
 */
export function keepUserChoice(previous: PropertyListing | undefined, next: PropertyListing): PropertyListing {
  if (previous?.addressConfidence !== 'user_choice' || !previous.fullAddress) return next;
  if (!previous.postcode || !next.postcode) return next;
  if (normalisePostcode(previous.postcode) !== normalisePostcode(next.postcode)) return next;
  if (next.addressConfidence === 'exact') return next;

  return {
    ...next,
    fullAddress: previous.fullAddress,
    addressConfidence: 'user_choice',
    addressCandidates: next.addressCandidates ?? previous.addressCandidates,
    enrichmentDetail: previous.enrichmentDetail,
  };
}

/**
 * A new capture of a listing whose home is already known (an exact match, or
 * picked by the user) for the same postcode and listing address: the EPC
 * register would only say the same again, so the saved address is used and
 * the capture skips the lookup. Null when the lookup should run.
 */
export function reuseKnownAddress(previous: PropertyListing | undefined, next: PropertyListing): PropertyListing | null {
  if (!previous?.fullAddress || next.fullAddress) return null;
  if (previous.addressConfidence !== 'exact' && previous.addressConfidence !== 'user_choice') return null;
  if (!previous.postcode || !next.postcode) return null;
  if (normalisePostcode(previous.postcode) !== normalisePostcode(next.postcode)) return null;
  if (previous.displayAddress.trim().toLowerCase() !== next.displayAddress.trim().toLowerCase()) return null;

  return {
    ...next,
    fullAddress: previous.fullAddress,
    addressConfidence: previous.addressConfidence,
    addressCandidates: previous.addressCandidates ?? null,
    enrichmentDetail: previous.enrichmentDetail ?? null,
    // The listing's own rating wins; an exact match may have lent the certificate's
    epcRating: next.epcRating || (previous.addressConfidence === 'exact' ? previous.epcRating : null),
  };
}

/** A Google Maps search for the address, so the user can check it on Street View */
export function mapsLink(fullAddress: string, postcode: string): string {
  const query = postcode && !fullAddress.includes(postcode) ? `${fullAddress}, ${postcode}` : fullAddress;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
