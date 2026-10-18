import type { PropertyListing } from '../adapters/types';

/**
 * Filter and sort logic for the dashboard page. Pure, so it is unit tested
 * without a browser.
 */

export type MatchFilter = 'all' | 'exact' | 'user_choice' | 'best_guess' | 'none';
export type SortKey = 'capturedAt' | 'source' | 'address' | 'postcode' | 'price' | 'bedrooms' | 'propertyType' | 'epcRating' | 'agentName';

export interface ViewOptions {
  search: string;
  source: PropertyListing['source'] | 'all';
  match: MatchFilter;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
}

export const DEFAULT_VIEW: ViewOptions = {
  search: '',
  source: 'all',
  match: 'all',
  sortKey: 'capturedAt',
  sortDir: 'desc',
};

/** Which match group a listing falls in: exact, picked by the user, best guess, or no full address */
export function matchGroup(listing: PropertyListing): Exclude<MatchFilter, 'all'> {
  if (!listing.fullAddress) return 'none';
  if (listing.addressConfidence === 'exact' || listing.addressConfidence === 'user_choice') return listing.addressConfidence;
  return 'best_guess';
}

function searchText(l: PropertyListing): string {
  return [l.displayAddress, l.fullAddress, l.postcode, l.postcodePartial, l.agentName, l.agentBranch, l.propertyType, l.source]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function sortValue(l: PropertyListing, key: SortKey): string | number | null {
  switch (key) {
    case 'address': return (l.fullAddress || l.displayAddress || '').toLowerCase() || null;
    case 'postcode': return (l.postcode || l.postcodePartial || '').toUpperCase() || null;
    case 'price': return l.price;
    case 'bedrooms': return l.bedrooms;
    default: {
      const value = l[key];
      return typeof value === 'string' ? value.toLowerCase() || null : null;
    }
  }
}

/** Listings that pass the filters, sorted. Blank values always go last. */
export function applyView(listings: PropertyListing[], view: ViewOptions): PropertyListing[] {
  const words = view.search.toLowerCase().split(/\s+/).filter(Boolean);

  const kept = listings.filter((l) => {
    if (view.source !== 'all' && l.source !== view.source) return false;
    if (view.match !== 'all' && matchGroup(l) !== view.match) return false;
    if (words.length === 0) return true;
    const text = searchText(l);
    return words.every((w) => text.includes(w));
  });

  const dir = view.sortDir === 'asc' ? 1 : -1;
  return kept
    .map((l, i) => ({ l, i, v: sortValue(l, view.sortKey) }))
    .sort((a, b) => {
      if (a.v == null || b.v == null) return a.v == null ? (b.v == null ? a.i - b.i : 1) : -1;
      const diff = typeof a.v === 'number' && typeof b.v === 'number'
        ? a.v - b.v
        : String(a.v).localeCompare(String(b.v), 'en-GB', { numeric: true });
      return diff !== 0 ? diff * dir : a.i - b.i;
    })
    .map(({ l }) => l);
}

/** Counts for the summary bar */
export function summarise(listings: PropertyListing[]): Record<Exclude<MatchFilter, 'all'> | 'total', number> {
  const counts = { total: listings.length, exact: 0, user_choice: 0, best_guess: 0, none: 0 };
  for (const l of listings) counts[matchGroup(l)]++;
  return counts;
}

/** Only http(s) links are shown as links; listing data comes from other websites */
export function safeLink(url: string | null | undefined): string | null {
  try {
    const parsed = new URL(url ?? '');
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}
