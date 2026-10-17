import type { EpcResult, PropertyListing } from '../adapters/types';
import { closeCalls, extractNumbers, findBestMatch, latestPerHome, normalisePostcode, scoreCandidates } from './epc-match';
import type { EpcMatch } from './epc-match';

/**
 * EPC Register API client
 *
 * Endpoint: https://api.get-energy-performance-data.communities.gov.uk/api/domestic/search
 * Auth: Bearer token (free, from get-energy-performance-data.communities.gov.uk)
 * Docs: https://get-energy-performance-data.communities.gov.uk/api-technical-documentation
 *
 * The old epc.opendatacommunities.org API was retired on 30 May 2026.
 *
 * We search by full postcode and rank the certificates against the listing
 * (see epc-match.ts). The search results carry little more than the address,
 * so when several homes are close we look up each one's certificate for its
 * property type, floor area and room count, then rank again.
 */

const EPC_API_ROOT = 'https://api.get-energy-performance-data.communities.gov.uk';
const EPC_API_BASE = `${EPC_API_ROOT}/api/domestic/search`;

// Full certificate: dwelling_type, habitable_room_count, total_floor_area.
// If it answers 400/404/405 we stop asking for details for the rest of the
// session and rank on address alone.
const EPC_CERTIFICATE_URL = `${EPC_API_ROOT}/api/certificate`;

/** Most certificate lookups per capture, to stay clear of the rate limit */
const MAX_DETAIL_LOOKUPS = 10;

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
    ...readDetails(row),
  };
}

/**
 * Read property type, built form, floor area and habitable rooms from a
 * certificate, wherever they sit. Field names are matched loosely
 * (dwelling_type, dwellingType and DWELLING-TYPE are all the same) so search
 * rows, full certificates and older response shapes all work.
 */
export function readDetails(body: unknown): Pick<EpcResult, 'propertyType' | 'builtForm' | 'floorAreaSqm' | 'habitableRooms'> {
  const wanted: Record<string, string> = {
    dwellingtype: 'propertyType', // e.g. "Semi-detached house", "Mid-floor flat"
    propertytype: 'propertyType',
    builtform: 'builtForm',
    totalfloorarea: 'floorAreaSqm',
    habitableroomcount: 'habitableRooms',
    numberhabitablerooms: 'habitableRooms',
    habitablerooms: 'habitableRooms',
  };
  const found: Record<string, unknown> = {};

  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    for (const [key, child] of Object.entries(value)) {
      const target = wanted[key.toLowerCase().replace(/[^a-z]/g, '')];
      if (target && found[target] == null && child != null && typeof child !== 'object') {
        found[target] = child;
      } else {
        walk(child, depth + 1);
      }
    }
  };
  walk(body, 0);

  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const details: ReturnType<typeof readDetails> = {};
  if (text(found.propertyType)) details.propertyType = text(found.propertyType);
  if (text(found.builtForm)) details.builtForm = text(found.builtForm);
  if (num(found.floorAreaSqm)) details.floorAreaSqm = num(found.floorAreaSqm);
  if (num(found.habitableRooms)) details.habitableRooms = num(found.habitableRooms);
  return details;
}

let certificateLookupUnavailable = false;

/**
 * Fetch one certificate's details. Returns null when the lookup fails, so a
 * missing detail never stops the capture.
 */
export async function fetchCertificateDetails(
  token: string,
  certificateNumber: string
): Promise<ReturnType<typeof readDetails> | null> {
  if (certificateLookupUnavailable || !certificateNumber) return null;

  try {
    const url = `${EPC_CERTIFICATE_URL}?${new URLSearchParams({ certificate_number: certificateNumber })}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    if ([400, 404, 405].includes(response.status)) {
      console.warn(`PropSnap: certificate lookup answered ${response.status}, ranking on address only`);
      certificateLookupUnavailable = true;
      return null;
    }
    if (!response.ok) return null;

    return readDetails(await response.json());
  } catch (error) {
    console.warn('PropSnap: certificate lookup failed:', error);
    return null;
  }
}

/**
 * Fill in certificate details for the homes that are still close calls,
 * so the second ranking pass can tell them apart.
 */
async function addDetailsToCloseCalls(
  token: string,
  results: EpcResult[],
  listing: PropertyListing
): Promise<EpcResult[]> {
  const listingHasDetails = listing.bedrooms != null || !!listing.propertyType || !!listing.floorAreaSqm;
  if (!listingHasDetails) return results;

  const contenders = closeCalls(scoreCandidates(results, listing))
    .map((c) => c.result)
    .filter((r) => r.floorAreaSqm == null && r.propertyType == null)
    .slice(0, MAX_DETAIL_LOOKUPS);
  if (contenders.length < 2) return results;

  const details = new Map<EpcResult, ReturnType<typeof readDetails>>();
  // Two at a time keeps us well inside the rate limit
  for (let i = 0; i < contenders.length; i += 2) {
    const batch = contenders.slice(i, i + 2);
    const fetched = await Promise.all(batch.map((r) => fetchCertificateDetails(token, r.certificateNumber)));
    batch.forEach((r, j) => {
      const d = fetched[j];
      if (d) details.set(r, d);
    });
    if (certificateLookupUnavailable) break;
  }

  return results.map((r) => (details.has(r) ? { ...r, ...details.get(r) } : r));
}

/** True for a full UK postcode such as "CF14 0SN", false for an outcode like "CF14" */
export function isFullPostcode(postcode: string | null | undefined): postcode is string {
  return !!postcode && /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(normalisePostcode(postcode));
}

function describeMatch(match: EpcMatch, postcode: string): string {
  const basis = match.reasons.length > 0 ? `matched on ${match.reasons.join(', ')}` : null;
  if (match.confidence === 'exact') return basis ? `Exact: ${basis}` : 'Exact match';
  if (match.tiedCount > 1) {
    return `${match.tiedCount} homes in ${postcode} are close, so this is a best guess${basis ? ` (${basis})` : ''}`;
  }
  return 'Only the postcode matches, not the street, so this is a best guess';
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

    let results = latestPerHome(await searchEpc(token, { postcode }));

    console.log(`PropSnap: EPC returned ${results.length} homes for postcode ${postcode}`);

    if (results.length === 0) {
      return {
        listing,
        enrichmentStatus: 'no_match',
        enrichmentDetail: `No EPC records found for postcode ${postcode}`,
      };
    }

    results = await addDetailsToCloseCalls(token, results, listing);
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
          // The listing's own rating is about this exact home. A best guess may be
          // a neighbour, so only borrow the certificate's rating on an exact match.
          epcRating: listing.epcRating
            || (match.confidence === 'exact' ? result.currentEnergyRating || null : null),
        },
        enrichmentStatus: 'enriched',
        enrichmentDetail: describeMatch(match, postcode),
      };
    }

    // Had results but none matched well enough
    const numbers = extractNumbers(listing.displayAddress);
    if (numbers.length > 0) {
      return {
        listing,
        enrichmentStatus: 'no_match',
        enrichmentDetail: `No EPC record in ${postcode} has the number ${numbers.join(' / ')} from "${listing.displayAddress}"`,
      };
    }
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
