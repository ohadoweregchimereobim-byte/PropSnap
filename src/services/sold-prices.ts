import type { PropertyListing } from '../adapters/types';
import { builtForm, extractNumbers, typeCategory } from './epc-match';
import { formatPostcode, type LrPropertyType, type SoldPrice } from './land-registry';

/**
 * Sold-price comparables for a listing. Pure, so it is unit tested without
 * the network: where to search, which sales are this home, and the figures.
 */

const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/;

// Last word of an English street name, or first word of a Welsh one
const STREET_END = /\b(ROAD|RD|STREET|ST|AVENUE|AVE|LANE|CLOSE|DRIVE|WAY|COURT|CRESCENT|PLACE|GARDENS|GROVE|TERRACE|HILL|RISE|VIEW|WALK|MEWS|ROW|PARK|SQUARE|GREEN|PARADE|VALE|FIELDS?|MEADOWS?|CHASE|GATE|WHARF|QUAY|BOULEVARD|EMBANKMENT|HEIGHTS|COTTAGES|VILLAS|BANK|CROFT|ORCHARD|GLADE|DALE|WOOD|BROADWAY|CIRCUS|YARD|PASSAGE|PATH|CAUSEWAY|PROMENADE|ESPLANADE|APPROACH|RIDGE|LEA|LEAZE|ACRE|ACRES)$/;
const ABBREVIATIONS: Record<string, string> = { ST: 'STREET', RD: 'ROAD', AVE: 'AVENUE' };
const WELSH_START = /^(HEOL|FFORDD|LON|LÔN|STRYD|RHODFA|CILGANT|TRAFFORDD|CLOS|PLAS|MAES|BRYN|PANT|CWRT)\b/;

/** "144 Tweedsmuir Road" → "TWEEDSMUIR ROAD"; "Flat 3" → "" */
function withoutNumber(part: string): string {
  return part
    .toUpperCase()
    .replace(/^(FLAT|APARTMENT|APT\.?|UNIT|MAISONETTE)\s*\d+[A-Z]?\s*/, '')
    .replace(/^\d+[A-Z]?(\s*-\s*\d+[A-Z]?)?\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function streetIn(address: string | null | undefined): string | null {
  const parts = (address ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  // The last part is the town ("…, CARDIFF"), unless it is the only part
  const candidates = parts.length > 1 ? parts.slice(0, -1) : parts;
  for (const part of candidates) {
    const street = withoutNumber(part.replace(/\b[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/i, '').trim());
    if (street.split(' ').length >= 2 && !/\d/.test(street) && (STREET_END.test(street) || WELSH_START.test(street))) {
      // Land Registry spells the words out: "HIGH ST" is "HIGH STREET"
      return street.replace(/ (ST|RD|AVE)$/, (_, w: string) => ` ${ABBREVIATIONS[w]}`);
    }
  }
  return null;
}

/** Where to look: the full postcode (if known), and the street within its postcode district */
export function soldPriceArea(listing: Pick<PropertyListing, 'postcode' | 'postcodePartial' | 'fullAddress' | 'displayAddress'>): {
  postcode: string | null;
  street: string | null;
  outcode: string | null;
} {
  const postcode = formatPostcode(listing.postcode);
  const outcode = postcode?.split(' ')[0] ?? (listing.postcodePartial ?? '').toUpperCase().trim();
  return {
    postcode,
    street: streetIn(listing.fullAddress) ?? streetIn(listing.displayAddress),
    outcode: OUTCODE.test(outcode) ? outcode : null,
  };
}

/** The Land Registry type for a listing type; null when it cannot say (e.g. "Bungalow", "House") */
export function lrTypeFor(type: string | null | undefined): LrPropertyType | null {
  if (typeCategory(type) === 'flat') return 'flat-maisonette';
  switch (builtForm(type)) {
    case 'semi': return 'semi-detached';
    case 'terrace': return 'terraced';
    case 'detached': return 'detached';
    default: return null;
  }
}

export type TypeChoice = 'same' | 'houses' | 'all';

const HOUSES: LrPropertyType[] = ['detached', 'semi-detached', 'terraced'];

/**
 * The type filters that make sense for a listing, the closest match first:
 * a terraced house gets "Terraced only", "All houses", "All types"; a flat
 * gets "Flats only", "All types"; a bungalow (form not known) gets "All houses", "All types".
 */
export function typeChoices(listingType: string | null | undefined): Array<{ value: TypeChoice; label: string; types: LrPropertyType[] | null }> {
  const same = lrTypeFor(listingType);
  const choices: Array<{ value: TypeChoice; label: string; types: LrPropertyType[] | null }> = [];
  if (same) choices.push({ value: 'same', label: same === 'flat-maisonette' ? 'Flats only' : `${TYPE_NAMES[same]} only`, types: [same] });
  if (same !== 'flat-maisonette' && (same || typeCategory(listingType) === 'house')) {
    choices.push({ value: 'houses', label: 'All houses', types: HOUSES });
  }
  choices.push({ value: 'all', label: 'All types', types: null });
  return choices;
}

/** Fewer standard sales than this make a weak median */
export const FEW_SALES = 5;

const words = (text: string) => ` ${text.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;

/** True when a sale is the home at this full address (same number, flat and street) */
export function isSameHome(sale: SoldPrice, fullAddress: string | null | undefined): boolean {
  if (!fullAddress || !sale.paon) return false;
  const address = words(fullAddress);
  if (!address.includes(words(sale.paon))) return false;
  if (sale.street && !address.includes(words(sale.street))) return false;

  const addressHasFlat = /\b(FLAT|APARTMENT|APT|UNIT|MAISONETTE)\s*\d/i.test(fullAddress);
  if (!sale.saon) return !addressHasFlat;
  const flatNumbers = extractNumbers(sale.saon).map((n) => n.toUpperCase());
  if (flatNumbers.length === 0) return address.includes(words(sale.saon));
  return flatNumbers.every((n) => address.includes(` ${n} `));
}

export interface SoldPriceView {
  /** This home's own past sales (all years), newest first */
  thisHome: SoldPrice[];
  /** Other sales that pass the filters, newest first */
  comparables: SoldPrice[];
  /** Of the standard sales among the comparables */
  median: number | null;
  low: number | null;
  high: number | null;
  /** Asking price against the median, in %; null for rent listings or no median */
  askingVsMedianPct: number | null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function soldPriceView(
  sales: SoldPrice[],
  listing: Pick<PropertyListing, 'fullAddress' | 'price' | 'listingType'>,
  options: { types: LrPropertyType[] | null; sinceYears: number | null; today: Date },
): SoldPriceView {
  const thisHome = sales.filter((s) => isSameHome(s, listing.fullAddress));
  const since = options.sinceYears == null
    ? ''
    : new Date(Date.UTC(options.today.getUTCFullYear() - options.sinceYears, options.today.getUTCMonth(), options.today.getUTCDate()))
      .toISOString().slice(0, 10);

  const comparables = sales.filter((s) =>
    !thisHome.includes(s)
    && (options.types == null || options.types.includes(s.propertyType))
    && s.date >= since);

  const prices = comparables.filter((s) => s.standard).map((s) => s.price);
  const mid = median(prices);
  const asking = listing.listingType === 'sale' && listing.price ? listing.price : null;

  return {
    thisHome,
    comparables,
    median: mid,
    low: prices.length ? Math.min(...prices) : null,
    high: prices.length ? Math.max(...prices) : null,
    askingVsMedianPct: asking && mid ? ((asking - mid) / mid) * 100 : null,
  };
}

const KEEP_UPPER = /^(\d+[A-Z]*|[A-Z]{1,2}\d[A-Z\d]?|\d[A-Z]{2})$/;

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(' ')
    .map((w) => (KEEP_UPPER.test(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** A sale's address in normal case, with the building name apart from the street */
export function saleAddress(sale: SoldPrice): string {
  let parts: Array<string | null>;
  if (!sale.paon || /^\d/.test(sale.paon)) {
    // "FLAT 3", "12", "HIGH STREET" → "Flat 3, 12 High Street"
    parts = [sale.saon, [sale.paon, sale.street].filter(Boolean).join(' ')];
  } else if (sale.saon && /^\d+[A-Z]?$/.test(sale.saon)) {
    // "15", "SYCAMORE COURT", "WOOLASTON AVENUE" → "15 Sycamore Court, Woolaston Avenue"
    parts = [`${sale.saon} ${sale.paon}`, sale.street];
  } else {
    // "FLAT 3", "DOVERCOURT HOUSE", "FERRY COURT" → "Flat 3, Dovercourt House, Ferry Court"
    parts = [sale.saon, sale.paon, sale.street];
  }
  return [...parts, sale.town].filter(Boolean).map((p) => titleCase(p!)).join(', ');
}

export const TYPE_NAMES: Record<LrPropertyType, string> = {
  detached: 'Detached',
  'semi-detached': 'Semi-detached',
  terraced: 'Terraced',
  'flat-maisonette': 'Flat',
  other: 'Other',
};
