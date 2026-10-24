import type { PropertyListing } from '../adapters/types';
import { priceChange } from './price-history';
import { cleanPipeline, isActive, isDue, STATUSES, type Pipeline, type PipelineStatus } from './pipeline';
import { listingKey, type UserDataMap } from './user-data';
import { cleanActivity, cleanLabels } from './crm';

/**
 * Filter and sort logic for the dashboard page. Pure, so it is unit tested
 * without a browser.
 */

export type MatchFilter = 'all' | 'exact' | 'user_choice' | 'best_guess' | 'none';
/** Price moves PropSnap has seen between captures */
export type PriceFilter = 'all' | 'reduced' | 'increased' | 'changed';
/** A pipeline stage, or every active deal, or follow-ups due today or before */
export type StatusFilter = 'all' | 'active' | 'due' | PipelineStatus;
/** Hidden homes: left out (default), shown with the rest, or shown alone */
export type HiddenFilter = 'hide' | 'show' | 'only';
export type SortKey = 'capturedAt' | 'source' | 'address' | 'postcode' | 'price' | 'bedrooms' | 'propertyType' | 'epcRating' | 'agentName' | 'status';

export interface ViewOptions {
  search: string;
  source: PropertyListing['source'] | 'all';
  match: MatchFilter;
  price: PriceFilter;
  status: StatusFilter;
  /** A label, or 'all' */
  label: string;
  hidden: HiddenFilter;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
}

export const DEFAULT_VIEW: ViewOptions = {
  search: '',
  source: 'all',
  match: 'all',
  price: 'all',
  status: 'all',
  label: 'all',
  hidden: 'hide',
  sortKey: 'capturedAt',
  sortDir: 'desc',
};

/** Which match group a listing falls in: exact, picked by the user, best guess, or no full address */
export function matchGroup(listing: PropertyListing): Exclude<MatchFilter, 'all'> {
  if (!listing.fullAddress) return 'none';
  if (listing.addressConfidence === 'exact' || listing.addressConfidence === 'user_choice') return listing.addressConfidence;
  return 'best_guess';
}

/** What the user saved for a listing in the pipeline, cleaned; null for none */
export function pipelineOf(l: PropertyListing, userData: UserDataMap | undefined): Pipeline | null {
  return cleanPipeline(userData?.[listingKey(l)]?.pipeline);
}

/** The user's context for filters that read their own data */
export interface ViewContext {
  userData?: UserDataMap;
  /** YYYY-MM-DD in the user's time zone */
  today: string;
}

/** The user's labels on a listing, cleaned */
export function labelsOf(l: PropertyListing, userData: UserDataMap | undefined): string[] {
  return cleanLabels(userData?.[listingKey(l)]?.labels);
}

export const isHidden = (l: PropertyListing, userData: UserDataMap | undefined) => userData?.[listingKey(l)]?.hidden === true;

function searchText(l: PropertyListing, pipeline: Pipeline | null, labels: string[], userData: UserDataMap | undefined): string {
  // The summary and every note and call in the timeline
  const timeline = cleanActivity(userData?.[listingKey(l)]?.activity).map((a) => a.text);
  return [l.displayAddress, l.fullAddress, l.postcode, l.postcodePartial, l.agentName, l.agentBranch, l.propertyType, l.source, pipeline?.notes, ...labels, ...timeline]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function sortValue(l: PropertyListing, key: SortKey, pipeline: Pipeline | null): string | number | null {
  switch (key) {
    case 'status': return STATUSES.findIndex((s) => s.value === (pipeline?.status ?? 'new'));
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
export function applyView(listings: PropertyListing[], view: ViewOptions, context: ViewContext = { today: '' }): PropertyListing[] {
  const words = view.search.toLowerCase().split(/\s+/).filter(Boolean);
  const pipelines = new Map(listings.map((l) => [l, pipelineOf(l, context.userData)]));

  const kept = listings.filter((l) => {
    const pipeline = pipelines.get(l) ?? null;
    const hidden = isHidden(l, context.userData);
    if ((view.hidden === 'hide' && hidden) || (view.hidden === 'only' && !hidden)) return false;
    const labels = labelsOf(l, context.userData);
    if (view.label !== 'all' && !labels.some((x) => x.toLowerCase() === view.label.toLowerCase())) return false;
    if (view.status === 'active' && !(pipeline && isActive(pipeline.status))) return false;
    if (view.status === 'due' && !isDue(pipeline, context.today)) return false;
    if (view.status !== 'all' && view.status !== 'active' && view.status !== 'due' && (pipeline?.status ?? 'new') !== view.status) return false;
    if (view.source !== 'all' && l.source !== view.source) return false;
    if (view.match !== 'all' && matchGroup(l) !== view.match) return false;
    if (view.price !== 'all') {
      const change = priceChange(l);
      if (!change) return false;
      if (view.price !== 'changed' && change.direction !== view.price) return false;
    }
    if (words.length === 0) return true;
    const text = searchText(l, pipeline, labels, context.userData);
    return words.every((w) => text.includes(w));
  });

  const dir = view.sortDir === 'asc' ? 1 : -1;
  return kept
    .map((l, i) => ({ l, i, v: sortValue(l, view.sortKey, pipelines.get(l) ?? null) }))
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
export function summarise(
  listings: PropertyListing[],
  context: ViewContext = { today: '' },
): Record<Exclude<MatchFilter, 'all'> | 'total' | 'reduced' | 'active' | 'due' | 'hidden', number> {
  const counts = { total: listings.length, exact: 0, user_choice: 0, best_guess: 0, none: 0, reduced: 0, active: 0, due: 0, hidden: 0 };
  for (const l of listings) {
    if (isHidden(l, context.userData)) counts.hidden++;
    counts[matchGroup(l)]++;
    if (priceChange(l)?.direction === 'reduced') counts.reduced++;
    const pipeline = pipelineOf(l, context.userData);
    if (pipeline && isActive(pipeline.status)) counts.active++;
    if (isDue(pipeline, context.today)) counts.due++;
  }
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
