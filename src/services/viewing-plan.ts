import type { PropertyListing } from '../adapters/types';

/**
 * Viewing planner: the order to visit homes in, Google Maps route links and
 * a calendar file. Pure, so it is unit tested without a browser.
 */

/** The plan the planner page keeps in storage */
export interface ViewingPlan {
  /** source:listingId, in visiting order */
  keys: string[];
  /** HH:MM per key; missing = no time yet */
  times: Record<string, string>;
  /** YYYY-MM-DD */
  date: string;
  /** Where the day starts, as typed (postcode or address); empty = the user's location */
  start: string;
  minutesEach: number;
}

export const PLAN_KEY = 'propsnap_plan';

/** Google Maps takes at most 9 stops between the start and the end of one route */
export const MAX_WAYPOINTS = 9;

type Located = Pick<PropertyListing, 'latitude' | 'longitude'>;

const hasPosition = (l: Located) =>
  typeof l.latitude === 'number' && typeof l.longitude === 'number' && Number.isFinite(l.latitude) && Number.isFinite(l.longitude)
  && !(l.latitude === 0 && l.longitude === 0);

/** Straight-line distance in km */
export function distanceKm(a: Located, b: Located): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude! - a.latitude!);
  const dLng = rad(b.longitude! - a.longitude!);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude!)) * Math.cos(rad(b.latitude!)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function pathKm(stops: Located[]): number {
  let total = 0;
  for (let i = 1; i < stops.length; i++) total += distanceKm(stops[i - 1]!, stops[i]!);
  return total;
}

/** Straight-line km along the route, between the homes that have a map position */
export function routeKm(stops: Located[]): number {
  return pathKm(stops.filter(hasPosition));
}

/** True when the listing gave a map position */
export const isPlaced = hasPosition;

/**
 * A short visiting order by straight-line distance: from each home in turn,
 * always go to the nearest home not yet visited, and keep the shortest of
 * those paths. Homes with no map position go last, in the order given.
 * Not real driving times, but it stops the day zig-zagging across town.
 */
export function bestOrder<T extends Located>(stops: T[]): T[] {
  const placed = stops.filter(hasPosition);
  const unplaced = stops.filter((s) => !hasPosition(s));
  if (placed.length < 3) return [...placed, ...unplaced];

  let best: T[] = placed;
  let bestKm = pathKm(placed);
  for (const first of placed) {
    const path = [first];
    const left = placed.filter((s) => s !== first);
    while (left.length) {
      const last = path[path.length - 1]!;
      let nearest = 0;
      for (let i = 1; i < left.length; i++) {
        if (distanceKm(last, left[i]!) < distanceKm(last, left[nearest]!)) nearest = i;
      }
      path.push(left.splice(nearest, 1)[0]!);
    }
    const km = pathKm(path);
    if (km < bestKm - 1e-9) {
      best = path;
      bestKm = km;
    }
  }
  return [...best, ...unplaced];
}

/** Where Google Maps should go for a home: the full address, else the map position, else the listing's address */
export function mapsPlace(l: Pick<PropertyListing, 'fullAddress' | 'displayAddress' | 'postcode' | 'postcodePartial' | 'latitude' | 'longitude'>): string {
  const postcode = l.postcode || '';
  if (l.fullAddress) {
    return postcode && !l.fullAddress.toUpperCase().includes(postcode.toUpperCase()) ? `${l.fullAddress}, ${postcode}` : l.fullAddress;
  }
  if (hasPosition(l)) return `${l.latitude!.toFixed(6)},${l.longitude!.toFixed(6)}`;
  const area = postcode || l.postcodePartial || '';
  return area && !l.displayAddress.toUpperCase().includes(area.toUpperCase()) ? `${l.displayAddress}, ${area}` : l.displayAddress;
}

/**
 * Google Maps directions links for the route. With no start, Maps starts at
 * the user's location. A route longer than one link allows is split, each
 * part starting where the last one ended.
 */
export function routeLinks(start: string, places: string[]): string[] {
  if (places.length === 0) return [];
  const links: string[] = [];
  let origin = start.trim();
  let i = 0;
  while (i < places.length) {
    const part = places.slice(i, i + MAX_WAYPOINTS + 1);
    const params = new URLSearchParams({ api: '1', travelmode: 'driving' });
    if (origin) params.set('origin', origin);
    params.set('destination', part[part.length - 1]!);
    if (part.length > 1) params.set('waypoints', part.slice(0, -1).join('|'));
    links.push(`https://www.google.com/maps/dir/?${params.toString()}`);
    origin = part[part.length - 1]!;
    i += part.length;
  }
  return links;
}

/** Stops whose time is earlier than (or the same as) the stop before; by key */
export function timeClashes(keys: string[], times: Record<string, string>): string[] {
  const clashes: string[] = [];
  let last = '';
  for (const key of keys) {
    const time = times[key];
    if (!time) continue;
    if (last && time <= last) clashes.push(key);
    last = time;
  }
  return clashes;
}

/** Text for a calendar field: backslash, semicolon, comma and line breaks escaped (RFC 5545) */
function icsText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 bytes are folded onto continuation lines that start with a space */
function fold(line: string): string {
  const bytes = new TextEncoder();
  const out: string[] = [];
  let current = '';
  for (const char of line) {
    if (bytes.encode(current + char).length > (out.length ? 74 : 75)) {
      out.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.join('\r\n ');
}

function icsDateTime(date: string, time: string, addMinutes = 0): string {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi! + addMinutes));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00`;
}

export interface CalendarStop {
  key: string;
  time: string | undefined;
  title: string;
  location: string;
  details: string[];
}

/**
 * A calendar file with one event per viewing that has a time. Times are UK
 * local time (Europe/London), so they stay right in summer and winter.
 * Null when no viewing has a time.
 */
export function calendarFile(date: string, minutesEach: number, stops: CalendarStop[], now: Date): string | null {
  const timed = stops.filter((s) => s.time && /^\d{2}:\d{2}$/.test(s.time));
  if (timed.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PropSnap//Viewing planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    // UK clocks: GMT in winter, BST (UTC+1) from the last Sunday in March to the last Sunday in October
    'BEGIN:VTIMEZONE',
    'TZID:Europe/London',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0000',
    'TZOFFSETTO:+0100',
    'TZNAME:BST',
    'DTSTART:19700329T010000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0000',
    'TZNAME:GMT',
    'DTSTART:19701025T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
  for (const stop of timed) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${stop.key.replace(/[^A-Za-z0-9:-]/g, '')}-${date}-${stop.time!.replace(':', '')}@propsnap`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/London:${icsDateTime(date, stop.time!)}`,
      `DTEND;TZID=Europe/London:${icsDateTime(date, stop.time!, minutesEach)}`,
      `SUMMARY:${icsText(stop.title)}`,
      `LOCATION:${icsText(stop.location)}`,
      `DESCRIPTION:${icsText(stop.details.filter(Boolean).join('\n'))}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** A saved plan, checked: only known keys, good times and dates */
export function cleanPlan(saved: unknown, knownKeys: Set<string>, today: string): ViewingPlan {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const keys = Array.isArray(s.keys) ? [...new Set(s.keys.filter((k): k is string => typeof k === 'string' && knownKeys.has(k)))] : [];
  const times: Record<string, string> = {};
  if (s.times && typeof s.times === 'object') {
    for (const [k, v] of Object.entries(s.times as Record<string, unknown>)) {
      if (keys.includes(k) && typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) times[k] = v;
    }
  }
  const date = typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.date >= today ? s.date : today;
  const minutes = Number(s.minutesEach);
  return {
    keys,
    times,
    date,
    start: typeof s.start === 'string' ? s.start.slice(0, 200) : '',
    minutesEach: Number.isFinite(minutes) && minutes >= 5 && minutes <= 240 ? Math.round(minutes) : 30,
  };
}
