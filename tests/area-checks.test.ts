import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  areaCountries,
  cleanAreaSummary,
  combineConservation,
  combineFlood,
  fetchAreaChecks,
  eaFloodZoneAt,
  parseArticle4,
  parseConservation,
  parseRightsNames,
  pointFromListing,
  pointFromPostcodeLookup,
  pointInGeometry,
  summariseArea,
  summariseCrimes,
  walesConservation,
  walesFloodZone,
  type AreaChecks,
} from '../src/services/area-checks';
// Trimmed answers saved from each service (October 2026)
import police from './fixtures/area/police-crimes.json';
import article4Southampton from './fixtures/area/planning-article4-southampton.json';
import conservationWestminster from './fixtures/area/planning-conservation-westminster.json';
import conservationBirmingham from './fixtures/area/planning-conservation-birmingham.json';
import conservationNone from './fixtures/area/planning-conservation-none.json';
import article4Birmingham from './fixtures/area/planning-article4-birmingham.json';
import rights from './fixtures/area/planning-pd-rights.json';
import eaDatchet from './fixtures/area/ea-flood-datchet.json';
import eaTewkesburyHam from './fixtures/area/ea-flood-tewkesbury-ham.json';
import walesFloodPontcanna from './fixtures/area/wales-flood-pontcanna.json';
import walesFloodNone from './fixtures/area/wales-flood-none.json';
import walesConservationPontcanna from './fixtures/area/wales-conservation-pontcanna.json';
import postcode from './fixtures/area/postcodes-cf236ez.json';

const today = '2026-10-24';

describe('where the home is', () => {
  it('uses the listing map position when it is in Great Britain', () => {
    expect(pointFromListing({ latitude: 51.5049, longitude: -3.1534 })).toEqual({ lat: 51.5049, lng: -3.1534, source: 'listing' });
    expect(pointFromListing({ latitude: null, longitude: null })).toBeNull();
    expect(pointFromListing({ latitude: 0, longitude: 0 })).toBeNull();
    expect(pointFromListing({ latitude: 42.36, longitude: -71.06 })).toBeNull();
  });

  it('reads the postcode centre from postcodes.io', () => {
    expect(pointFromPostcodeLookup(postcode)).toEqual({ lat: 51.513113, lng: -3.169763, source: 'postcode' });
    expect(pointFromPostcodeLookup({ status: 404, error: 'Postcode not found' })).toBeNull();
  });
});

describe('street crime', () => {
  it('counts the crimes by category, most first', () => {
    const s = summariseCrimes(police, '2026-08')!;
    expect(s.month).toBe('2026-08');
    expect(s.total).toBe(police.length);
    expect(s.byCategory.reduce((n, c) => n + c.count, 0)).toBe(police.length);
    expect(s.byCategory.find((c) => c.category === 'violent-crime')?.label).toBe('Violence and sexual offences');
    expect(s.byCategory[0]!.count).toBeGreaterThanOrEqual(s.byCategory.at(-1)!.count);
    expect(summariseCrimes({ error: 'x' }, '2026-08')).toBeNull();
    expect(summariseCrimes([], '2026-08')).toEqual({ month: '2026-08', total: 0, byCategory: [] });
  });
});

describe('England planning data', () => {
  it('finds an HMO Article 4 direction (class 3L)', () => {
    const [a4] = parseArticle4(article4Southampton, today);
    expect(a4).toMatchObject({ name: 'HMO', rights: ['3L'], hmo: true });
    expect(parseArticle4(article4Birmingham, today).some((d) => d.hmo && d.name === 'City Wide HMO')).toBe(true);
  });

  it('splits several rights and spots HMO wording when no code is given', () => {
    const list = parseArticle4({ entities: [
      { name: 'Roath Park', 'permitted-development-rights': '1A;1C;2A', 'end-date': '' },
      { name: 'Houses in multiple occupation', 'permitted-development-rights': '', 'end-date': '' },
      { name: 'Old one', 'permitted-development-rights': '3L', 'end-date': '2020-01-01' },
    ] }, today);
    expect(list).toEqual([
      { name: 'Roath Park', rights: ['1A', '1C', '2A'], hmo: false, description: null },
      { name: 'Houses in multiple occupation', rights: [], hmo: true, description: null },
    ]);
  });

  it('finds a conservation area, and none where there is none', () => {
    expect(parseConservation(conservationWestminster, today)).toEqual([{ name: 'Royal Parks', council: null, designated: '1990-01-30' }]);
    expect(parseConservation(conservationBirmingham, today)).toEqual([{ name: 'Colmore Row and Environs Conservation Area', council: null, designated: null }]);
    expect(parseConservation(conservationNone, today)).toEqual([]);
  });

  it('reads what each permitted development right code means', () => {
    expect(parseRightsNames(rights)['3L']).toBe('Small HMOs to dwellinghouses and vice versa');
  });
});

describe('England flood zones (exact point check)', () => {
  it('finds Flood Zone 3 only where the shape really holds the point', () => {
    expect(eaFloodZoneAt(eaTewkesburyHam, -2.1640, 51.9935)).toEqual({ zone: 'FZ3', by: 'Environment Agency', sourceOfFlooding: expect.any(String) });
  });

  it('does not count a zone whose box touches the point but whose shape does not (Datchet, about 20 m away)', () => {
    expect(eaDatchet.features.length).toBeGreaterThan(0);
    expect(eaFloodZoneAt(eaDatchet, -0.5786, 51.4846)).toEqual({ zone: 'none', by: null, sourceOfFlooding: null });
  });

  it('checks holes and multipolygons', () => {
    const square = (x: number, y: number, s: number) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
    const withHole = { type: 'Polygon', coordinates: [square(0, 0, 10), square(4, 4, 2)] };
    expect(pointInGeometry(1, 1, withHole)).toBe(true);
    expect(pointInGeometry(5, 5, withHole)).toBe(false);
    expect(pointInGeometry(21, 21, { type: 'MultiPolygon', coordinates: [[square(0, 0, 1)], [square(20, 20, 2)]] })).toBe(true);
    expect(pointInGeometry(1, 1, null)).toBe(false);
  });
});

describe('Wales', () => {
  it('reads the NRW flood zone and the conservation area at Pontcanna', () => {
    expect(walesFloodZone(walesFloodPontcanna)).toEqual({ zone: 'FZ3', by: 'Natural Resources Wales', sourceOfFlooding: null });
    expect(walesFloodZone(walesFloodNone)).toEqual({ zone: 'none', by: null, sourceOfFlooding: null });
    expect(walesConservation(walesConservationPontcanna)).toEqual([{ name: 'Cathedral Road', council: 'Cardiff', designated: '1972-04-01' }]);
  });
});

describe('putting it together', () => {
  it('takes the highest flood zone, and none only when every check ran', () => {
    const none = { zone: 'none' as const, by: null, sourceOfFlooding: null };
    const fz2 = { zone: 'FZ2' as const, by: 'Environment Agency', sourceOfFlooding: 'river' };
    expect(combineFlood(none, fz2)).toBe(fz2);
    expect(combineFlood(none, none)).toBe(none);
    expect(combineFlood(none)).toBe(none);
    // The map that failed may be the one that covers the home
    expect(combineFlood(null, none)).toBeNull();
    expect(combineFlood(null, fz2)).toBe(fz2);
    expect(combineFlood(null, null)).toBeNull();
  });

  it('says none found for conservation areas only when every check ran', () => {
    const area = { name: 'Cathedral Road', council: 'Cardiff', designated: null };
    expect(combineConservation([], [])).toEqual([]);
    expect(combineConservation([], [area])).toEqual([area]);
    expect(combineConservation(null, [])).toBeNull();
    expect(combineConservation(null, [area])).toEqual([area]);
    expect(combineConservation(null)).toBeNull();
  });

  it('checks a home against its own country, and both on the border', () => {
    expect(areaCountries({ postcode: 'CF24 2QH', postcodePartial: 'CF24' })).toEqual(['wales']);
    expect(areaCountries({ postcode: 'SW1P 1LQ', postcodePartial: 'SW1P' })).toEqual(['england']);
    expect(areaCountries({ postcode: null, postcodePartial: 'LL11' })).toEqual(['wales']);
    expect(areaCountries({ postcode: 'SY10 7AB', postcodePartial: 'SY10' })).toEqual(['england', 'wales']);
    // Sedbury (NP16 7) is in England though most of NP16 is Welsh
    expect(areaCountries({ postcode: 'NP16 7AA', postcodePartial: 'NP16' })).toEqual(['england', 'wales']);
    expect(areaCountries({ postcode: null, postcodePartial: null })).toEqual(['england', 'wales']);
  });

  it('keeps a short summary for the dashboard and checks it when read back', () => {
    const checks: AreaChecks = {
      checkedAt: '2026-10-24T12:00:00Z',
      point: { lat: 51.48, lng: -3.19, source: 'listing' },
      flood: { zone: 'FZ3', by: 'Natural Resources Wales', sourceOfFlooding: null },
      conservation: [{ name: 'Cathedral Road', council: 'Cardiff', designated: '1972-04-01' }],
      article4: [],
      crime: { month: '2026-08', total: 286, byCategory: [] },
      failed: [],
    };
    const s = summariseArea(checks, { wales: false });
    expect(s).toEqual({ checkedAt: '2026-10-24T12:00:00Z', floodZone: 'FZ3', conservation: 'Cathedral Road', article4Count: 0, hmoArticle4: false, crimeTotal: 286, crimeMonth: '2026-08' });
    expect(cleanAreaSummary(s)).toEqual(s);
    // Wales has no Article 4 map: none found there is unknown, not clear
    expect(summariseArea(checks, { wales: true })).toMatchObject({ article4Count: null, hmoArticle4: null });
    expect(summariseArea({ ...checks, article4: [{ name: 'HMO', rights: ['3L'], hmo: true, description: null }] }, { wales: true })).toMatchObject({ hmoArticle4: true });
    expect(summariseArea({ ...checks, article4: null, flood: null, conservation: null, crime: null }, { wales: false })).toMatchObject({ floodZone: null, conservation: null, article4Count: null, hmoArticle4: null, crimeTotal: null });
    expect(cleanAreaSummary({ checkedAt: 'x', floodZone: 'FZ9', crimeMonth: 'soon' })).toMatchObject({ floodZone: null, crimeMonth: null });
    expect(cleanAreaSummary(null)).toBeNull();
  });

  it('keeps the last result of a check that failed this time', () => {
    const previous = { checkedAt: '2026-10-17T12:00:00Z', floodZone: 'FZ2' as const, conservation: '', article4Count: 1, hmoArticle4: true, crimeTotal: 40, crimeMonth: '2026-07' };
    const failedAll: AreaChecks = {
      checkedAt: '2026-10-24T12:00:00Z', point: { lat: 51.5, lng: -0.1, source: 'listing' },
      flood: null, conservation: null, article4: null, crime: null, failed: ['everything'],
    };
    // Nothing answered: the last summary stands as it was, date and all
    expect(summariseArea(failedAll, { wales: false, previous })).toEqual(previous);
    // What did answer replaces the old result; the date stays the older one, as not everything was checked again
    const crimeOnly = { ...failedAll, crime: { month: '2026-08', total: 12, byCategory: [] } };
    expect(summariseArea(crimeOnly, { wales: false, previous })).toEqual({ ...previous, crimeTotal: 12, crimeMonth: '2026-08' });
    // Everything answered: today's date
    const all = { ...failedAll, flood: { zone: 'none' as const, by: null, sourceOfFlooding: null }, conservation: [], article4: [], failed: [] };
    expect(summariseArea({ ...all, crime: crimeOnly.crime }, { wales: false, previous })).toMatchObject({ checkedAt: '2026-10-24T12:00:00Z', floodZone: 'none', article4Count: 0 });
    // Wales has no Article 4 map: that is no answer, and nothing old is kept for it
    const welsh = { ...previous, article4Count: 1, hmoArticle4: true };
    expect(summariseArea({ ...crimeOnly, article4: [] }, { wales: true, previous: welsh })).toMatchObject({ article4Count: null, hmoArticle4: null, crimeTotal: 12 });
    // ...so with nothing else answered there, the last summary stands too
    expect(summariseArea({ ...failedAll, article4: [] }, { wales: true, previous: { ...previous, article4Count: null, hmoArticle4: null } }))
      .toEqual({ ...previous, article4Count: null, hmoArticle4: null });
  });
});

describe('asking the services', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Every service answers with nothing found, except the ones in `failing`
  function services(failing: string[] = []) {
    const fetchMock = vi.fn(async (url: string) => {
      if (failing.some((host) => url.includes(host))) return new Response('', { status: 503 });
      if (url.includes('crime-last-updated')) return new Response(JSON.stringify({ date: '2026-08-01' }));
      if (url.includes('crimes-street')) return new Response(JSON.stringify([]));
      if (url.includes('planning.data.gov.uk')) return new Response(JSON.stringify({ entities: [] }));
      return new Response(JSON.stringify({ features: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const point = { lat: 51.4983, lng: -0.1356, source: 'listing' as const };
  const hosts = (mock: ReturnType<typeof services>) => mock.mock.calls.map(([url]) => new URL(String(url)).hostname);

  it('asks only the home\'s own country', async () => {
    const english = services();
    await fetchAreaChecks(point, ['england']);
    expect(hosts(english)).not.toContain('datamap.gov.wales');

    const welsh = services();
    const checks = await fetchAreaChecks(point, ['wales']);
    expect(hosts(welsh)).not.toContain('environment.data.gov.uk');
    expect(hosts(welsh)).not.toContain('www.planning.data.gov.uk');
    // No Article 4 map in Wales: shown as such, not as a failed check
    expect(checks.article4).toEqual([]);
    expect(checks.failed).toEqual([]);
  });

  it('never reads a failed flood map as "not in a flood zone"', async () => {
    services(['environment.data.gov.uk', 'planning.data.gov.uk']);
    const checks = await fetchAreaChecks(point, ['england', 'wales']);
    // Wales answered "nothing here", but the home may be in England
    expect(checks.flood).toBeNull();
    expect(checks.conservation).toBeNull();
    expect(checks.article4).toBeNull();
    expect(checks.failed).toEqual(['flood zones (England)', 'conservation areas (England)', 'Article 4 directions']);
    expect(summariseArea(checks, { wales: false })).toMatchObject({ floodZone: null, conservation: null });
  });
});
