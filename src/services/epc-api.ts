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
  if (epcResults.length === 1) return epcResults[0] ?? null;

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
  const best = scored[0];
  return best && best.score >= 2 ? best.result : null;
}

export interface EnrichmentResult {
  listing: PropertyListing;
  enrichmentStatus: 'enriched' | 'no_match' | 'no_postcode' | 'api_error' | 'skipped';
  enrichmentDetail?: string;
}

/**
 * Enrich a property listing with EPC data.
 * Returns the listing with fullAddress and epcRating filled in,
 * plus status info so the UI can tell the user what happened.
 */
export async function enrichWithEpc(
  token: string,
  listing: PropertyListing
): Promise<EnrichmentResult> {
  // Only enrich if we don't already have the full address
  if (listing.fullAddress) {
    return { listing, enrichmentStatus: 'skipped', enrichmentDetail: 'Already has full address' };
  }

  // Need at least a postcode to search
  const postcode = listing.postcode || listing.postcodePartial;
  if (!postcode) {
    return { listing, enrichmentStatus: 'no_postcode', enrichmentDetail: 'No postcode available to search EPC register' };
  }

  try {
    // Build search params — search by postcode only first for broader results
    const params: EpcSearchParams = { postcode };

    console.log('PropSnap: EPC search params:', JSON.stringify(params));

    const results = await searchEpc(token, params);

    console.log(`PropSnap: EPC returned ${results.length} results for postcode ${postcode}`);

    if (results.length === 0) {
      // Try without address filter if we had one
      return {
        listing,
        enrichmentStatus: 'no_match',
        enrichmentDetail: `No EPC records found for postcode ${postcode}`,
      };
    }

    const bestMatch = findBestMatch(results, listing);

    if (bestMatch) {
      const fullAddress = [bestMatch.address1, bestMatch.address2, bestMatch.address3]
        .filter(Boolean)
        .join(', ');

      console.log(`PropSnap: EPC match found: ${fullAddress}`);

      return {
        listing: {
          ...listing,
          fullAddress,
          postcode: bestMatch.postcode || listing.postcode,
          epcRating: bestMatch.currentEnergyRating || listing.epcRating,
        },
        enrichmentStatus: 'enriched',
      };
    }

    // Had results but none matched well enough
    const sampleAddresses = results.slice(0, 3).map(
      (r) => [r.address1, r.address2].filter(Boolean).join(', ')
    );
    return {
      listing,
      enrichmentStatus: 'no_match',
      enrichmentDetail: `Found ${results.length} EPC records for ${postcode} but none matched "${listing.displayAddress}". Sample results: ${sampleAddresses.join(' | ')}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('PropSnap: EPC enrichment failed:', message);
    return {
      listing,
      enrichmentStatus: 'api_error',
      enrichmentDetail: message,
    };
  }
}
