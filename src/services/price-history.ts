import type { PricePoint, PropertyListing } from '../adapters/types';

/**
 * Price changes between captures of the same listing. Pure, so it is unit
 * tested without storage. PropSnap only knows the prices it saw: a change
 * between two captures is dated by the capture that saw it.
 */

/** Oldest points are dropped beyond this */
const MAX_POINTS = 50;

function pointOf(l: PropertyListing): PricePoint {
  return { price: l.price ?? null, qualifier: l.priceQualifier ?? null, seenAt: l.capturedAt };
}

/** The new capture with the earlier prices kept, plus its own price when it is new */
export function withPriceHistory(previous: PropertyListing | undefined, next: PropertyListing): PropertyListing {
  const history = previous?.priceHistory?.length
    ? [...previous.priceHistory]
    : previous ? [pointOf(previous)] : [];

  const last = history[history.length - 1];
  const point = pointOf(next);
  if (!last || last.price !== point.price || last.qualifier !== point.qualifier) history.push(point);

  return { ...next, priceHistory: history.slice(-MAX_POINTS) };
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
  const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
  const pct = `${c.changePct > 0 ? '+' : '−'}${Math.abs(c.changePct).toFixed(1)}%`;
  if (c.direction === 'reduced') return `Reduced ${money.format(-c.change)} (${pct})`;
  if (c.direction === 'increased') return `Up ${money.format(c.change)} (${pct})`;
  return 'Back to the first price';
}
