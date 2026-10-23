import { describe, expect, it } from 'vitest';
import { bestOrder, calendarFile, cleanPlan, distanceKm, mapsPlace, MAX_WAYPOINTS, routeLinks, timeClashes } from '../src/services/viewing-plan';

const at = (id: string, latitude: number | null, longitude: number | null) => ({ id, latitude, longitude });

describe('distanceKm', () => {
  it('measures straight-line distance', () => {
    // Cardiff Central to Cardiff Castle is about 1 km
    expect(distanceKm(at('a', 51.4759, -3.1791), at('b', 51.4822, -3.1812))).toBeCloseTo(0.71, 1);
  });
});

describe('bestOrder', () => {
  it('visits homes along a line in order, not zig-zagging', () => {
    const a = at('a', 51.50, -3.20);
    const b = at('b', 51.50, -3.10);
    const c = at('c', 51.50, -3.15);
    const d = at('d', 51.50, -3.05);
    const order = bestOrder([b, d, a, c]).map((s) => s.id).join('');
    expect(['acbd', 'dbca']).toContain(order);
  });

  it('puts homes with no map position last, in the order given', () => {
    const order = bestOrder([at('x', null, null), at('a', 51.5, -3.2), at('b', 51.5, -3.1), at('c', 51.5, -3.15), at('y', 0, 0)]);
    expect(order.slice(3).map((s) => s.id)).toEqual(['x', 'y']);
  });

  it('leaves two or fewer homes as they are', () => {
    expect(bestOrder([at('b', 51.5, -3.1), at('a', 51.5, -3.2)]).map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('mapsPlace', () => {
  const base = { fullAddress: null, displayAddress: 'Woolaston Avenue, Cardiff', postcode: 'CF23 6EZ', postcodePartial: 'CF23', latitude: 51.51, longitude: -3.18 };

  it('prefers the full address, then the map position, then the listing address', () => {
    expect(mapsPlace({ ...base, fullAddress: '6 Woolaston Avenue, CARDIFF' })).toBe('6 Woolaston Avenue, CARDIFF, CF23 6EZ');
    expect(mapsPlace(base)).toBe('51.510000,-3.180000');
    expect(mapsPlace({ ...base, latitude: null, longitude: null })).toBe('Woolaston Avenue, Cardiff, CF23 6EZ');
  });
});

describe('routeLinks', () => {
  it('starts from the start point, with the stops in order', () => {
    const [link] = routeLinks('CF14 1AA', ['A', 'B', 'C']);
    const url = new URL(link!);
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/dir/');
    expect(url.searchParams.get('origin')).toBe('CF14 1AA');
    expect(url.searchParams.get('waypoints')).toBe('A|B');
    expect(url.searchParams.get('destination')).toBe('C');
    expect(url.searchParams.get('travelmode')).toBe('driving');
  });

  it('leaves the start out so Maps uses the current location', () => {
    expect(new URL(routeLinks('  ', ['A'])[0]!).searchParams.has('origin')).toBe(false);
  });

  it('splits a long route, each part starting where the last ended', () => {
    const places = Array.from({ length: 14 }, (_, i) => `P${i + 1}`);
    const links = routeLinks('', places).map((l) => new URL(l).searchParams);
    expect(links).toHaveLength(2);
    expect(links[0]!.get('waypoints')!.split('|')).toHaveLength(MAX_WAYPOINTS);
    expect(links[0]!.get('destination')).toBe('P10');
    expect(links[1]!.get('origin')).toBe('P10');
    expect(links[1]!.get('waypoints')).toBe('P11|P12|P13');
    expect(links[1]!.get('destination')).toBe('P14');
    expect(routeLinks('', [])).toEqual([]);
  });
});

describe('timeClashes', () => {
  it('flags a viewing set before the one it follows', () => {
    expect(timeClashes(['a', 'b', 'c', 'd'], { a: '10:00', b: '09:30', d: '11:00' })).toEqual(['b']);
    expect(timeClashes(['a', 'b'], { a: '10:00', b: '10:00' })).toEqual(['b']);
  });
});

describe('calendarFile', () => {
  const stops = [
    { key: 'zoopla:1', time: '10:00', title: 'Viewing: 6 Woolaston Avenue, Cardiff', location: '6 Woolaston Avenue, CARDIFF, CF23 6EZ', details: ['£290,000', 'Agent: Example Estates; 029 2000 0000'] },
    { key: 'rightmove:2', time: undefined, title: 'No time', location: 'x', details: [] },
  ];
  const ics = calendarFile('2026-10-28', 30, stops, new Date('2026-10-23T12:00:00Z'))!;

  it('makes one event per viewing with a time, in UK time', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain('DTSTART;TZID=Europe/London:20261028T100000');
    expect(ics).toContain('DTEND;TZID=Europe/London:20261028T103000');
    expect(ics).toContain('TZID:Europe/London');
    expect(ics).toContain('UID:zoopla:1-2026-10-28-1000@propsnap');
  });

  it('escapes commas, semicolons and line breaks', () => {
    expect(ics).toContain('SUMMARY:Viewing: 6 Woolaston Avenue\\, Cardiff');
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('DESCRIPTION:£290\\,000\\nAgent: Example Estates\\; 029 2000 0000');
  });

  it('keeps every line within 75 bytes', () => {
    const long = calendarFile('2026-10-28', 30, [{ ...stops[0]!, location: 'A very long address '.repeat(10) }], new Date())!;
    for (const line of long.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it('runs past midnight correctly and gives nothing without times', () => {
    expect(calendarFile('2026-10-28', 45, [{ ...stops[0]!, time: '23:30' }], new Date())).toContain('DTEND;TZID=Europe/London:20261029T001500');
    expect(calendarFile('2026-10-28', 30, [stops[1]!], new Date())).toBeNull();
  });
});

describe('cleanPlan', () => {
  const known = new Set(['zoopla:1', 'rightmove:2']);

  it('keeps known homes and good values', () => {
    expect(cleanPlan({ keys: ['zoopla:1', 'gone:9', 'zoopla:1'], times: { 'zoopla:1': '10:00', 'gone:9': '11:00' }, date: '2026-10-28', start: 'CF14 1AA', minutesEach: 45 }, known, '2026-10-23'))
      .toEqual({ keys: ['zoopla:1'], times: { 'zoopla:1': '10:00' }, date: '2026-10-28', start: 'CF14 1AA', minutesEach: 45 });
  });

  it('falls back for bad or past values', () => {
    expect(cleanPlan({ date: '2026-10-01', minutesEach: 9999, times: { 'zoopla:1': 'soon' } }, known, '2026-10-23'))
      .toEqual({ keys: [], times: {}, date: '2026-10-23', start: '', minutesEach: 30 });
    expect(cleanPlan(null, known, '2026-10-23').keys).toEqual([]);
  });
});
