import type { EpcResult, PropertyListing } from '../adapters/types';

/**
 * EPC Register API client
 *
 * Endpoint: https://epc.opendatacommunities.org/api/v1/domestic/search
 * Auth: Bearer token (free registration at get-energy-performance-data.communities.gov.uk)
 * Cost: Free
 *
 * Used primarily for Rightmove listings where the full postcode
 * isn't available from the listing page. Zoopla and OpenRent
 * already provide full postcodes.
 */

const EPC_API_BASE = 'https://epc.opendatacommunities.org/api/v1/domestic/search';

export interface EpcSearchParams {
  postcode?: string;
  address?: string;
}

interface EpcApiResponse {
  rows: EpcRow[];
  'column-names': string[];
}

interface EpcRow {
  ADDRESS1: string;
  ADDRESS2: string;
  ADDRESS3: string;
  POSTCODE: string;
  'CURRENT-ENERGY-RATING': string;
  'LODGEMENT-DATE': string;
  'BUILDING-REFERENCE-NUMBER': string;
  'PROPERTY-TYPE': string;
  'TOTAL-FLOOR-AREA': string;
  [key: string]: string;
}

/**
 * Search EPC Register for address data.
 * This is called from the background script (service worker)
 * because content scripts can't make cross-origin requests.
 */
export async function searchEpc(
  token: string,
  params: EpcSearchParams
): Promise<EpcResult[]> {
  const searchParams = new URLSearchParams();

  if (params.postcode) searchParams.set('postcode', params.postcode);
  if (params.address) searchParams.set('address', params.address);

  const url = `${EPC_API_BASE}?${searchParams.toString()}`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('EPC API: Invalid or expired bearer token');
    }
    if (response.status === 429) {
      throw new Error('EPC API: Rate limited — try again in a moment');
    }
    throw new Error(`EPC API: HTTP ${response.status}`);
  }

  const data: EpcApiResponse = await response.json();

  return (data.rows ?? []).map((row) => ({
    address1: row.ADDRESS1 ?? '',
    address2: row.ADDRESS2 ?? '',
    address3: row.ADDRESS3 ?? '',
    postcode: row.POSTCODE ?? '',
    currentEnergyRating: row['CURRENT-ENERGY-RATING'] ?? '',
    lodgementDate: row['LODGEMENT-DATE'] ?? '',
    certificateHash: row['BUILDING-REFERENCE-NUMBER'] ?? '',
  }));
}

/**
 * Find the best EPC match for a property listing.
 *
 * Matching strategy:
 * 1. Search by postcode (full or partial + area)
 * 2. Filter by property type and bedrooms
 * 3. Score by address string similarity
 * 4. If coordinates available, prefer the closest match
 */
export function findBestMatch(
  epcResults: EpcResult[],
  listing: PropertyListing
): EpcResult | null {
  if (epcResults.length === 0) return null;
  if (epcResults.length === 1) return epcResults[0]!;

  // Score each result
  const scored = epcResults.map((result) => {
    let score = 0;

    // Address similarity — check if listing address words appear in EPC address
    const listingWords = listing.displayAddress.toLowerCase().split(/[\s,]+/);
    const epcAddress = `${result.address1} ${result.address2} ${result.address3}`.toLowerCase();

    for (const word of listingWords) {
      if (word.length > 2 && epcAddress.includes(word)) {
        score += 1;
      }
    }

    // Postcode match
    if (listing.postcode && result.postcode === listing.postcode) {
      score += 5;
    }

    return { result, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Return best match, but only if it has a reasonable score
  const best = scored[0]!;
  return best.score >= 2 ? best.result : null;
}

/**
 * Enrich a property listing with EPC data.
 * Returns the listing with fullAddress and epcRating filled in.
 */
export async function enrichWithEpc(
  token: string,
  listing: PropertyListing
): Promise<PropertyListing> {
  // Only enrich if we don't already have the full address
  if (listing.fullAddress) return listing;

  try {
    // Build search params
    const params: EpcSearchParams = {};

    if (listing.postcode) {
      params.postcode = listing.postcode;
    } else if (listing.postcodePartial) {
      params.postcode = listing.postcodePartial;
    }

    if (listing.displayAddress) {
      // Use a simplified version of the address for searching
      const simplified = listing.displayAddress
        .replace(/,/g, '')
        .split(/\s+/)
        .slice(0, 3)
        .join(' ');
      params.address = simplified;
    }

    const results = await searchEpc(token, params);
    const bestMatch = findBestMatch(results, listing);

    if (bestMatch) {
      return {
        ...listing,
        fullAddress: [bestMatch.address1, bestMatch.address2, bestMatch.address3]
          .filter(Boolean)
          .join(', '),
        postcode: bestMatch.postcode || listing.postcode,
        epcRating: bestMatch.currentEnergyRating || listing.epcRating,
      };
    }
  } catch (error) {
    console.warn('PropSnap: EPC enrichment failed:', error);
  }

  return listing;
}
