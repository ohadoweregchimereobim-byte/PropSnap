import type { AddressCandidate, EpcResult, PropertyListing } from '../adapters/types';
import { closeCalls, extractNumbers, findBestMatch, latestPerHome, normalisePostcode, scoreCandidates } from './epc-match';
import type { EpcMatch } from './epc-match';
import { readCache, writeCache } from './session-cache';
import { readEnergy, type EpcEnergy } from './epc-energy';

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
// If it answers 400/404/405, or does not answer in time, we stop asking for
// details for a while and rank on address alone; after a 429, for as long as
// the register asks.
const EPC_CERTIFICATE_URL = `${EPC_API_ROOT}/api/certificate`;

/** How long certificate lookups stay off after one of those answers */
const LOOKUP_PAUSE_MS = 10 * 60_000;
/** After "too many requests" (429): the wait the register asks for, else a minute, never over the pause above */
const RATE_LIMIT_PAUSE_MS = 60_000;

/** A request with no answer by then is given up, so the popup never waits forever */
const SEARCH_TIMEOUT_MS = 15_000;
const CERTIFICATE_TIMEOUT_MS = 10_000;

/** A certificate never changes once lodged, so its details are kept a long time */
const CERTIFICATE_CACHE_MS = 30 * 24 * 60 * 60_000;

/** Most certificate lookups per capture, to stay clear of the rate limit */
const MAX_DETAIL_LOOKUPS = 10;

/** Most close homes kept on a best guess for the user to choose from */
const MAX_CANDIDATES = 15;

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

  // The time limit covers reading the answer too, so both are in here
  const timedOut = (error: unknown) => {
    if (isTimeout(error)) throw new Error(`EPC API did not answer in ${SEARCH_TIMEOUT_MS / 1000} seconds. Try again in a moment`);
    throw error;
  };
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  }).catch(timedOut);

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

  const body = await response.json().catch(timedOut);
  return extractRows(body).map(toEpcResult);
}

/** A request given up by AbortSignal.timeout */
function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
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

// RdSAP certificates (2026 API) give type and form as number codes, e.g.
// property_type 0 and built_form 1 for a "Detached house"
const PROPERTY_TYPE_CODES: Record<string, string> = {
  '0': 'House',
  '1': 'Bungalow',
  '2': 'Flat',
  '3': 'Maisonette',
  '4': 'Park home',
};
const BUILT_FORM_CODES: Record<string, string> = {
  '1': 'Detached',
  '2': 'Semi-Detached',
  '3': 'End-Terrace',
  '4': 'Mid-Terrace',
  '5': 'Enclosed End-Terrace',
  '6': 'Enclosed Mid-Terrace',
};

/**
 * Read property type, built form, floor area and habitable rooms from a
 * certificate, wherever they sit. Field names are matched loosely
 * (dwelling_type, dwellingType and DWELLING-TYPE are all the same) so search
 * rows, full certificates and older response shapes all work.
 *
 * Newer certificates wrap some values ({ value: "Detached house", language: "1" })
 * and repeat floor areas per floor deep inside sap_building_parts, so the
 * shallowest match wins and nothing below MAX_DEPTH counts.
 */
export function readDetails(body: unknown): Pick<EpcResult, 'propertyType' | 'builtForm' | 'floorAreaSqm' | 'habitableRooms'> {
  const wanted: Record<string, string> = {
    dwellingtype: 'dwellingType', // e.g. "Semi-detached house", "Mid-floor flat"
    propertytype: 'propertyType',
    builtform: 'builtForm',
    totalfloorarea: 'floorAreaSqm',
    habitableroomcount: 'habitableRooms',
    numberhabitablerooms: 'habitableRooms',
    habitablerooms: 'habitableRooms',
  };
  const MAX_DEPTH = 3;
  const found: Record<string, unknown> = {};

  // { value: 390, quantity: "square metres" } → 390
  const unwrap = (v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? (v as { value: unknown }).value : v;

  // Breadth first, so data.total_floor_area beats a single floor's area further down
  let level: unknown[] = [body];
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!node || typeof node !== 'object') continue;
      for (const [key, child] of Object.entries(node)) {
        const target = wanted[key.toLowerCase().replace(/[^a-z]/g, '')];
        const value = unwrap(child);
        if (target && found[target] == null && value != null && typeof value !== 'object') {
          found[target] = value;
        } else if (child && typeof child === 'object') {
          next.push(child);
        }
      }
    }
    level = next;
  }

  const text = (v: unknown) => (typeof v === 'string' && v.trim() && !/^\d+$/.test(v.trim()) ? v.trim() : null);
  const code = (v: unknown, codes: Record<string, string>) => (v == null ? null : codes[String(v).trim()] ?? null);
  const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // Words beat codes: "Detached house" says more than property_type 0 ("House")
  const propertyType = text(found.dwellingType) ?? text(found.propertyType) ?? code(found.propertyType, PROPERTY_TYPE_CODES);
  const builtForm = text(found.builtForm) ?? code(found.builtForm, BUILT_FORM_CODES);

  const details: ReturnType<typeof readDetails> = {};
  if (propertyType) details.propertyType = propertyType;
  if (builtForm) details.builtForm = builtForm;
  if (num(found.floorAreaSqm)) details.floorAreaSqm = num(found.floorAreaSqm);
  if (num(found.habitableRooms)) details.habitableRooms = num(found.habitableRooms);
  return details;
}

// Date.now() before which certificate lookups are skipped. The service worker
// can restart at any time, so this is a pause, not an off switch.
let lookupsPausedUntil = 0;
const lookupsPaused = () => Date.now() < lookupsPausedUntil;

/**
 * One certificate's full answer, or null when the lookup fails or is paused,
 * so a missing certificate never stops the capture.
 */
async function getCertificate(token: string, certificateNumber: string): Promise<unknown | null> {
  if (!certificateNumber || lookupsPaused()) return null;
  try {
    const url = `${EPC_CERTIFICATE_URL}?${new URLSearchParams({ certificate_number: certificateNumber })}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(CERTIFICATE_TIMEOUT_MS),
    });

    if ([400, 404, 405].includes(response.status)) {
      console.warn(`PropSnap: certificate lookup answered ${response.status}, ranking on address only for ${LOOKUP_PAUSE_MS / 60_000} minutes`);
      lookupsPausedUntil = Date.now() + LOOKUP_PAUSE_MS;
      return null;
    }
    // Asking again straight away only makes the limit last longer
    if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get('Retry-After'), Date.now());
      console.warn(`PropSnap: certificate lookups rate limited, ranking on address only for ${Math.ceil(wait / 1000)} seconds`);
      // Never shorter than a pause already set by a refusal in the same batch
      lookupsPausedUntil = Math.max(lookupsPausedUntil, Date.now() + wait);
      return null;
    }
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    // A lookup that hangs would make every capture wait 10 s per pair, so pause them too
    if (isTimeout(error)) lookupsPausedUntil = Date.now() + LOOKUP_PAUSE_MS;
    console.warn('PropSnap: certificate lookup failed:', error);
    return null;
  }
}

/**
 * How long to wait after a 429: Retry-After in seconds or as a date, else a
 * minute; at least a second and at most the full pause
 */
export function retryAfterMs(header: string | null, now: number): number {
  const text = (header ?? '').trim();
  const asked = /^\d+$/.test(text) ? Number(text) * 1000 : text ? Date.parse(text) - now : NaN;
  const wait = Number.isFinite(asked) ? asked : RATE_LIMIT_PAUSE_MS;
  return Math.min(Math.max(wait, 1000), LOOKUP_PAUSE_MS);
}

/** Keep both readings of a certificate, so the other one never needs a second lookup */
async function keepCertificate(certificateNumber: string, body: unknown) {
  const details = readDetails(body);
  const energy = readEnergy(body, certificateNumber);
  // An answer with none of the fields may be a passing fault; ask again next time
  if (Object.keys(details).length > 0) await writeCache(`cert:${certificateNumber}`, details, CERTIFICATE_CACHE_MS);
  if (energy) await writeCache(`energy:${certificateNumber}`, energy, CERTIFICATE_CACHE_MS);
  return { details, energy };
}

/** One certificate's property type, form, floor area and rooms; null when the lookup fails */
export async function fetchCertificateDetails(
  token: string,
  certificateNumber: string
): Promise<ReturnType<typeof readDetails> | null> {
  if (!certificateNumber) return null;
  const kept = await readCache<ReturnType<typeof readDetails>>(`cert:${certificateNumber}`);
  if (kept) return kept.value;
  const body = await getCertificate(token, certificateNumber);
  return body == null ? null : (await keepCertificate(certificateNumber, body)).details;
}

/** One certificate's rating now and potential, with its improvements; null when the lookup fails */
export async function fetchCertificateEnergy(token: string, certificateNumber: string): Promise<EpcEnergy | null> {
  if (!certificateNumber) return null;
  const kept = await readCache<EpcEnergy>(`energy:${certificateNumber}`);
  if (kept) return kept.value;
  const body = await getCertificate(token, certificateNumber);
  return body == null ? null : (await keepCertificate(certificateNumber, body)).energy;
}

/**
 * The certificate of the home a listing's full address is. Listings saved
 * before the number was kept get it from their close homes, or by searching
 * the postcode for the same address. Null when it cannot be found.
 */
export async function findCertificateNumber(token: string, listing: PropertyListing): Promise<string | null> {
  if (listing.epcCertificateNumber) return listing.epcCertificateNumber;
  if (!listing.fullAddress) return null;
  const same = (address: string) => address.trim().toLowerCase() === listing.fullAddress!.trim().toLowerCase();

  const candidate = (listing.addressCandidates ?? []).find((c) => same(c.fullAddress));
  if (candidate) return candidate.certificateNumber;
  if (!isFullPostcode(listing.postcode)) return null;

  const found = latestPerHome(await searchEpc(token, { postcode: listing.postcode })).find((r) => same(fullAddressOf(r)));
  return found?.certificateNumber ?? null;
}

interface DetailPass {
  results: EpcResult[];
  /** Close calls that wanted a certificate lookup but did not get one */
  unchecked: number;
  /** The close calls from the first pass, with any details filled in */
  closeCalls: EpcResult[];
}

/**
 * Fill in certificate details for the homes that are still close calls,
 * so the second ranking pass can tell them apart.
 */
async function addDetailsToCloseCalls(
  token: string,
  results: EpcResult[],
  listing: PropertyListing
): Promise<DetailPass> {
  const listingHasDetails = listing.bedrooms != null || !!listing.propertyType || !!listing.floorAreaSqm;
  if (!listingHasDetails) return { results, unchecked: 0, closeCalls: [] };

  const needDetails = closeCalls(scoreCandidates(results, listing))
    .map((c) => c.result)
    .filter((r) => r.floorAreaSqm == null && r.propertyType == null);
  if (needDetails.length < 2) return { results, unchecked: 0, closeCalls: [] };

  const contenders = needDetails.slice(0, MAX_DETAIL_LOOKUPS);
  const details = new Map<EpcResult, ReturnType<typeof readDetails>>();
  // Two at a time keeps us well inside the rate limit
  for (let i = 0; i < contenders.length; i += 2) {
    const batch = contenders.slice(i, i + 2);
    const fetched = await Promise.all(batch.map((r) => fetchCertificateDetails(token, r.certificateNumber)));
    batch.forEach((r, j) => {
      const d = fetched[j];
      if (d) details.set(r, d);
    });
    if (lookupsPaused()) break;
  }

  const withDetails = (r: EpcResult) => (details.has(r) ? { ...r, ...details.get(r) } : r);
  return {
    results: results.map(withDetails),
    closeCalls: needDetails.map(withDetails),
    // When no home got details they are all still level, so nothing is unfair
    unchecked: details.size > 0 ? needDetails.length - details.size : 0,
  };
}

/** True for a full UK postcode such as "CF14 0SN", false for an outcode like "CF14" */
export function isFullPostcode(postcode: string | null | undefined): postcode is string {
  return !!postcode && /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(normalisePostcode(postcode));
}

/**
 * "7 MILTON GROVE, NEW MILTON" + post town "NEW MILTON" → "7 MILTON GROVE, NEW MILTON".
 * Some certificates repeat the town as the last address line, so a part
 * equal to the one before it is dropped.
 */
export function fullAddressOf(result: Pick<EpcResult, 'addressLines' | 'postTown'>): string {
  const parts: string[] = [];
  for (const part of [...result.addressLines, result.postTown]) {
    if (part && part.toLowerCase() !== parts[parts.length - 1]?.toLowerCase()) parts.push(part);
  }
  return parts.join(', ');
}

function toCandidate(result: EpcResult): AddressCandidate {
  return {
    fullAddress: fullAddressOf(result),
    postcode: result.postcode,
    certificateNumber: result.certificateNumber,
    epcRating: result.currentEnergyRating || null,
    floorAreaSqm: result.floorAreaSqm ?? null,
    propertyType: result.propertyType ?? null,
  };
}

function describeMatch(match: EpcMatch, postcode: string, unchecked: number, listing: PropertyListing): string {
  // Say so when the floor area came from the description, so the user can judge it
  const reasons = listing.floorAreaSource === 'text'
    ? match.reasons.map((r) => (r === 'floor area' ? 'floor area from the description' : r))
    : match.reasons;
  const basis = reasons.length > 0 ? `matched on ${reasons.join(', ')}` : null;
  if (match.confidence === 'exact') return basis ? `Exact: ${basis}` : 'Exact match';
  if (unchecked > 0) {
    return `${unchecked} close homes in ${postcode} could not be checked in full, so this is a best guess${basis ? ` (${basis})` : ''}`;
  }
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

    const detailPass = await addDetailsToCloseCalls(token, results, listing);
    results = detailPass.results;
    let match = findBestMatch(results, listing);

    // A checked home can pull ahead of homes we never checked. That is not a
    // fair win, so it stays a best guess.
    if (match?.confidence === 'exact' && detailPass.unchecked > 0) {
      // The homes we could not tell apart are the ones to choose from
      const best = match.result;
      match = {
        ...match,
        confidence: 'best_guess',
        others: detailPass.closeCalls.filter((r) => r.certificateNumber !== best.certificateNumber),
      };
    }

    if (match) {
      const { result } = match;
      const fullAddress = fullAddressOf(result);

      console.log(`PropSnap: EPC match (${match.confidence}): ${fullAddress}`);

      return {
        listing: {
          ...listing,
          fullAddress,
          addressConfidence: match.confidence,
          epcCertificateNumber: result.certificateNumber || null,
          // On a best guess, keep the close homes so the user can pick the right one
          addressCandidates: match.confidence === 'best_guess' && match.others.length > 0
            ? [result, ...match.others].slice(0, MAX_CANDIDATES).map(toCandidate)
            : null,
          // The listing's own rating is about this exact home. A best guess may be
          // a neighbour, so only borrow the certificate's rating on an exact match.
          epcRating: listing.epcRating
            || (match.confidence === 'exact' ? result.currentEnergyRating || null : null),
        },
        enrichmentStatus: 'enriched',
        enrichmentDetail: describeMatch(match, postcode, detailPass.unchecked, listing),
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
