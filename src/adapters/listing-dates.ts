import type { PortalPriceChange } from './types';

/**
 * The listing site's own dates: when the listing was first added, and the
 * price changes it shows. Pure, so the parsing is unit tested on strings
 * taken from saved Rightmove and Zoopla pages.
 */

/** YYYY-MM-DD when it is a real date, else null */
function isoDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (y < 1995 || y > 2100) return null;
  return date.toISOString().slice(0, 10);
}

/** The user's calendar date, as YYYY-MM-DD */
function localDay(d: Date): string {
  return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate())!;
}

/** Rightmove's analytics "added": "20260918" → "2026-09-18" */
export function rightmoveAddedDate(raw: unknown): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(raw ?? '').trim());
  return m ? isoDate(+m[1]!, +m[2]!, +m[3]!) : null;
}

/**
 * Rightmove's "listingUpdateReason": "Reduced on 12/10/2026", "Reduced today",
 * "Reduced yesterday". Only a reduction is a price change ("Added on …" is not).
 */
export function rightmovePriceChanges(reason: unknown, capturedAt: Date): PortalPriceChange[] {
  const text = String(reason ?? '').trim();
  const on = /^reduced on (\d{1,2})\/(\d{1,2})\/(\d{4})$/i.exec(text);
  if (on) {
    const date = isoDate(+on[3]!, +on[2]!, +on[1]!);
    return date ? [{ date, direction: 'down' }] : [];
  }
  const relative = /^reduced (today|yesterday)$/i.exec(text);
  if (relative) {
    const day = new Date(capturedAt);
    if (relative[1]!.toLowerCase() === 'yesterday') day.setDate(day.getDate() - 1);
    return [{ date: localDay(day), direction: 'down' }];
  }
  return [];
}

/** Zoopla's "publishedOn": "2026-03-06T16:13:52" → "2026-03-06" */
export function zooplaListedOn(raw: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? '').trim());
  return m ? isoDate(+m[1]!, +m[2]!, +m[3]!) : null;
}

/**
 * Zoopla's "priceChanges" array (as JSON text):
 * [{"isPriceDrop":true,"priceChangeDate":"2026-04-07T09:56:04"}, …]
 */
export function zooplaPriceChanges(json: string | null | undefined): PortalPriceChange[] {
  if (!json) return [];
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const changes: PortalPriceChange[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const date = zooplaListedOn(c.priceChangeDate);
    if (!date || typeof c.isPriceDrop !== 'boolean') continue;
    changes.push({ date, direction: c.isPriceDrop ? 'down' : 'up' });
  }
  return cleanPortalChanges(changes);
}

/** Checked, one per date and direction, oldest first, at most 50 */
export function cleanPortalChanges(saved: unknown): PortalPriceChange[] {
  if (!Array.isArray(saved)) return [];
  const seen = new Map<string, PortalPriceChange>();
  for (const raw of saved) {
    const c = raw as Partial<PortalPriceChange> | null;
    if (!c || typeof c.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) continue;
    if (c.direction !== 'down' && c.direction !== 'up') continue;
    seen.set(`${c.date}|${c.direction}`, { date: c.date, direction: c.direction });
  }
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-50);
}
