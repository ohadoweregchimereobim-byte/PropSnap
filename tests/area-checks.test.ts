import { describe, expect, it } from 'vitest';
import {
  cleanAreaSummary,
  combineFlood,
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
  it('takes the highest flood zone, and none only when a check ran', () => {
    const none = { zone: 'none' as const, by: null, sourceOfFlooding: null };
    const fz2 = { zone: 'FZ2' as const, by: 'Environment Agency', sourceOfFlooding: 'river' };
    expect(combineFlood(none, fz2)).toBe(fz2);
    expect(combineFlood(null, none)).toBe(none);
    expect(combineFlood(null, null)).toBeNull();
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
});
