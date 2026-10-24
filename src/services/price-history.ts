import type { PortalPriceChange, PricePoint, PropertyListing } from '../adapters/types';
import { cleanPortalChanges } from '../adapters/listing-dates';
import { formatMoney, SITE_NAMES } from './format';

/**
 * Price changes between captures of the same listing. Pure, so it is unit
 * tested without storage. PropSnap only knows the prices it saw: a change
 * between two captures is dated by the capture that saw it. Rightmove and
 * Zoopla also say when a listing was added and when its price changed (dates
 * only, no amounts); those are kept too and count as changes here.
 */

/** Oldest points are dropped beyond this */
const MAX_POINTS = 50;

function pointOf(l: PropertyListing): PricePoint {
  return { price: l.price ?? null, qualifier: l.priceQualifier ?? null, seenAt: l.capturedAt };
}

/**
 * The new capture with the earlier prices kept, plus its own price when it is
 * new. The site's own price changes add up across captures (Rightmove shows
 * only the latest), and its first-listed date stays when a capture lacks it.
 */
export function withPriceHistory(previous: PropertyListing | undefined, next: PropertyListing): PropertyListing {
  const history = previous?.priceHistory?.length
    ? [...previous.priceHistory]
    : previous ? [pointOf(previous)] : [];

  const last = history[history.length - 1];
  const point = pointOf(next);
  // "offers_over" (saved before 0.6.1) and "Offers over" are the same wording
  const wording = (q: string | null) => (q ?? '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  if (!last || last.price !== point.price || wording(last.qualifier) !== wording(point.qualifier)) history.push(point);

  return {
    ...next,
    priceHistory: history.slice(-MAX_POINTS),
    listedOn: next.listedOn ?? previous?.listedOn ?? null,
    portalPriceChanges: cleanPortalChanges([...(previous?.portalPriceChanges ?? []), ...(next.portalPriceChanges ?? [])]),
  };
}

export interface PriceChange {
  /** First price PropSnap saw, and when */
  first: PricePoint;
  /** Price now */
  latest: PricePoint;
  /** latest − first, in £ */
  change: number;
  /** Against the first price, in % */
  changePct: number;
  direction: 'reduced' | 'increased' | 'same';
  /** How many times the price moved */
  moves: number;
  /** When the last move was seen */
  lastMoveAt: string | null;
}

/** Change from the first price to the latest; null until two prices are known */
export function priceChange(listing: Pick<PropertyListing, 'priceHistory'>): PriceChange | null {
  const priced = (listing.priceHistory ?? []).filter((p): p is PricePoint & { price: number } => typeof p.price === 'number' && p.price > 0);
  if (priced.length < 2) return null;

  const first = priced[0]!;
  const latest = priced[priced.length - 1]!;
  let moves = 0;
  let lastMoveAt: string | null = null;
  for (let i = 1; i < priced.length; i++) {
    if (priced[i]!.price !== priced[i - 1]!.price) {
      moves++;
      lastMoveAt = priced[i]!.seenAt;
    }
  }
  if (moves === 0) return null;

  const change = latest.price - first.price;
  return {
    first,
    latest,
    change,
    changePct: (change / first.price) * 100,
    direction: change < 0 ? 'reduced' : change > 0 ? 'increased' : 'same',
    moves,
    lastMoveAt,
  };
}

/** The last move: the price before and after, and the capture that saw it */
export function latestMove(listing: Pick<PropertyListing, 'priceHistory'>): { from: number; to: number; seenAt: string } | null {
  const priced = (listing.priceHistory ?? []).filter((p) => typeof p.price === 'number' && p.price > 0);
  for (let i = priced.length - 1; i > 0; i--) {
    if (priced[i]!.price !== priced[i - 1]!.price) {
      return { from: priced[i - 1]!.price!, to: priced[i]!.price!, seenAt: priced[i]!.seenAt };
    }
  }
  return null;
}

/** "Reduced £10,000 (−3.3%)", "Up £5,000 (+1.7%)", "Back to the first price" */
export function describeChange(c: PriceChange): string {
  const pct = `${c.changePct > 0 ? '+' : '−'}${Math.abs(c.changePct).toFixed(1)}%`;
  if (c.direction === 'reduced') return `Reduced ${formatMoney(-c.change)} (${pct})`;
  if (c.direction === 'increased') return `Up ${formatMoney(c.change)} (${pct})`;
  return 'Back to the first price';
}

// ── The site's own dates ─────────────────────────────────────────────────

/** Whole days from the date the site listed the home to `today` (YYYY-MM-DD); null when the site does not say */
export function daysOnMarket(l: Pick<PropertyListing, 'listedOn'>, today: string): number | null {
  if (!l.listedOn || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${l.listedOn}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(days) && days >= 0 ? days : null;
}

/** "232 days", "1 day", "today" */
export function describeDays(days: number): string {
  return days === 0 ? 'listed today' : `${days} day${days === 1 ? '' : 's'} on the market`;
}

export const portalChanges = (l: Pick<PropertyListing, 'portalPriceChanges'>): PortalPriceChange[] => cleanPortalChanges(l.portalPriceChanges);

/** Reduced: PropSnap saw the price fall, or the site shows a drop */
export function wasReduced(l: Pick<PropertyListing, 'priceHistory' | 'portalPriceChanges'>): boolean {
  return priceChange(l)?.direction === 'reduced' || portalChanges(l).some((c) => c.direction === 'down');
}

export function wasIncreased(l: Pick<PropertyListing, 'priceHistory' | 'portalPriceChanges'>): boolean {
  return priceChange(l)?.direction === 'increased' || portalChanges(l).some((c) => c.direction === 'up');
}

export function priceMoved(l: Pick<PropertyListing, 'priceHistory' | 'portalPriceChanges'>): boolean {
  return priceChange(l) !== null || portalChanges(l).length > 0;
}

const shortDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "Zoopla shows 2 price drops: 7 Apr 2026, 28 Aug 2026"; null when the site shows none */
export function describePortalChanges(l: Pick<PropertyListing, 'portalPriceChanges' | 'source'>): string | null {
  const changes = portalChanges(l);
  if (changes.length === 0) return null;
  const drops = changes.filter((c) => c.direction === 'down').length;
  const rises = changes.length - drops;
  const what = [drops ? `${drops} price drop${drops === 1 ? '' : 's'}` : '', rises ? `${rises} rise${rises === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  return `${SITE_NAMES[l.source]} shows ${what}: ${changes.map((c) => shortDate(c.date)).join(', ')}`;
}

/** The newest change the site shows, for a short tag: "Reduced 28 Aug 2026" */
export function latestPortalChange(l: Pick<PropertyListing, 'portalPriceChanges'>): string | null {
  const last = portalChanges(l).at(-1);
  return last ? `${last.direction === 'down' ? 'Reduced' : 'Raised'} ${shortDate(last.date)}` : null;
}
