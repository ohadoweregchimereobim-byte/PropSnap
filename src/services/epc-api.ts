import type { EpcResult, PropertyListing } from '../adapters/types';

/**
 * EPC Register API client
 *
 * Endpoint: https://api.get-energy-performance-data.communities.gov.uk/api/domestic/search
 * Auth: Bearer token (free, from get-energy-performance-data.communities.gov.uk)
 * Docs: https://get-energy-performance-data.communities.gov.uk/api-technical-documentation
 *
 * The old epc.opendatacommunities.org API was retired on 30 May 2026.
 *
 * We search by full postcode and pick the certificate whose address best
 * matches the listing. The search results carry no bedrooms or property type,
 * so when several homes score the same we still return one, but mark it as
 * a best guess rather than an exact match.
 */

const EPC_API_BASE = 'https://api.get-energy-performance-data.communities.gov.uk/api/domestic/search';

export interface EpcSearchParams {
  postcode: string;
}

interface EpcRow {
  certificateNumber?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressLine3?: string | null;
  addressLine4?: string | null;
  postcode?: string | null;
  postTown?: string | null;
  currentEnergyEfficiencyBand?: string | null;
  registrationDate?: string | null;
  uprn?: number | string | null;
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
  const searchParams = new URLSearchParams({ postcode: params.postcode });
  const url = `${EPC_API_BASE}?${searchParams.toString()}`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });

  // The API answers 404 when no certificates match the search
  if (response.status === 404) return [];

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('EPC API: Invalid or expired bearer token');
    }
    if (response.status === 429) {
      throw new Error('EPC API: Rate limited — try again in a moment');
    }
    if (response.status === 400) {
      const detail = await response.text().catch(() => '');
      throw new Error(`EPC API: Bad request${detail ? ` (${detail.slice(0, 200)})` : ''}`);
    }
    throw new Error(`EPC API: HTTP ${response.status}`);
  }

  const body = await response.json();
  return extractRows(body).map(toEpcResult);
}

/**
 * Pull the certificate rows out of the response.
 * The docs show `data` as the array, but tolerate it being wrapped in an object.
 */
function extractRows(body: any): EpcRow[] {
  const data = body?.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const nested = Object.values(data).find(Array.isArray);
    if (nested) return nested as EpcRow[];
  }
  return [];
}

function toEpcResult(row: EpcRow): EpcResult {
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  return {
    addressLines: [row.addressLine1, row.addressLine2, row.addressLine3, row.addressLine4]
      .map(clean)
      .filter(Boolean),
    postTown: clean(row.postTown),
    postcode: clean(row.postcode).replace(/\+/g, ' '),
    currentEnergyRating: clean(row.currentEnergyEfficiencyBand),
    registrationDate: clean(row.registrationDate),
    certificateNumber: clean(row.certificateNumber),
    uprn: row.uprn != null && row.uprn !== '' ? String(row.uprn) : null,
  };
}

/** "cf14 0sn", "CF14+0SN" and "CF140SN" all become "CF140SN" */
export function normalisePostcode(postcode: string): string {
  return postcode.toUpperCase().replace(/[\s+]/g, '');
}

/** True for a full UK postcode such as "CF14 0SN", false for an outcode like "CF14" */
export function isFullPostcode(postcode: string | null | undefined): postcode is string {
  return !!postcode && /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(normalisePostcode(postcode));
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

export interface EpcMatch {
  result: EpcResult;
  confidence: 'exact' | 'best_guess';
  /** How many homes shared the top score (1 for an exact match) */
  tiedCount: number;
}

/**
 * Find the best EPC match for a property listing.
 *
 * Scoring: +5 when the postcode matches, +1 for every word of the listing's
 * display address (longer than 2 letters) found in the EPC address.
 * A single clear winner that also shares address words with the listing is
 * "exact"; a tie for first place, or a postcode-only match, is a "best_guess".
 */
export function findBestMatch(
  epcResults: EpcResult[],
  listing: PropertyListing
): EpcMatch | null {
  if (epcResults.length === 0) return null;

  const listingWords = listing.displayAddress.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 2);
  const listingPostcode = listing.postcode ? normalisePostcode(listing.postcode) : null;

  const scored = epcResults.map((result) => {
    const epcAddress = [...result.addressLines, result.postTown].join(' ').toLowerCase();
    const wordMatches = listingWords.filter((word) => epcAddress.includes(word)).length;

    let score = wordMatches;
    if (listingPostcode && normalisePostcode(result.postcode) === listingPostcode) {
      score += 5;
    }

    return { result, score, wordMatches };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  if (best.score < 2) return null;

  const tiedCount = scored.filter((s) => s.score === best.score).length;
  return {
    result: best.result,
    confidence: tiedCount === 1 && best.wordMatches > 0 ? 'exact' : 'best_guess',
    tiedCount,
  };
}

export interface EnrichmentResult {
  listing: PropertyListing;
  enrichmentStatus: 'enriched' | 'no_match' | 'no_postcode' | 'api_error' | 'skipped';
  enrichmentDetail?: string;
}

/**
 * Enrich a property listing with EPC data.
 * Returns the listing with fullAddress, addressConfidence and epcRating filled in,
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

  // A half postcode (e.g. "CF14") covers thousands of homes, so the
  // match would be a guess at best. Only search with a full postcode.
  if (!isFullPostcode(listing.postcode)) {
    const partial = listing.postcodePartial ?? listing.postcode;
    return {
      listing,
      enrichmentStatus: 'no_postcode',
      enrichmentDetail: partial
        ? `Full postcode not available (only ${partial})`
        : 'No postcode available to search EPC register',
    };
  }

  const postcode = listing.postcode;

  try {
    console.log('PropSnap: EPC search for postcode', postcode);

    const results = latestPerHome(await searchEpc(token, { postcode }));

    console.log(`PropSnap: EPC returned ${results.length} homes for postcode ${postcode}`);

    if (results.length === 0) {
      return {
        listing,
        enrichmentStatus: 'no_match',
        enrichmentDetail: `No EPC records found for postcode ${postcode}`,
      };
    }

    const match = findBestMatch(results, listing);

    if (match) {
      const { result } = match;
      const fullAddress = [...result.addressLines, result.postTown].filter(Boolean).join(', ');

      console.log(`PropSnap: EPC match (${match.confidence}): ${fullAddress}`);

      return {
        listing: {
          ...listing,
          fullAddress,
          addressConfidence: match.confidence,
          epcRating: result.currentEnergyRating || listing.epcRating,
        },
        enrichmentStatus: 'enriched',
        enrichmentDetail: match.confidence === 'exact' ? undefined
          : match.tiedCount > 1
            ? `${match.tiedCount} homes in ${postcode} match equally well, so this is a best guess`
            : `Only the postcode matches, not the street, so this is a best guess`,
      };
    }

    // Had results but none matched well enough
    const sampleAddresses = results.slice(0, 3).map((r) => r.addressLines.join(', '));
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
