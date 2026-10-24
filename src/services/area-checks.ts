import type { PropertyListing } from '../adapters/types';
import { taxRegionFromPostcode } from './calculators';
import { readCache, writeCache } from './session-cache';

/**
 * Area checks for a home: flood zone, conservation area, Article 4
 * directions and street crime nearby, from public government data. The
 * parsing is pure and tested on saved answers from each service; the fetch
 * functions call them from the listing page.
 *
 * England: Environment Agency Flood Map for Planning (exact point check
 * here, as the service matches by bounding box), and planning.data.gov.uk
 * for conservation areas and Article 4 directions (the server checks the
 * point). Wales: Natural Resources Wales Flood Map for Planning and the
 * Welsh conservation area boundaries on DataMapWales (the server checks the
 * point). Crime: data.police.uk, street crime within about a mile, latest month.
 *
 * Each country's maps cover only that country, so a home is checked against
 * its own country's (both on a border postcode). A map that failed is never
 * read as "nothing here".
 */

export interface AreaPoint {
  lat: number;
  lng: number;
  /** Where the position came from */
  source: 'listing' | 'postcode';
}

export type FloodZone = 'FZ3' | 'FZ2' | 'none';

export interface FloodCheck {
  zone: FloodZone;
  /** "Environment Agency" or "Natural Resources Wales" when a zone was found */
  by: string | null;
  /** "river", "sea", "river and sea" (England only) */
  sourceOfFlooding: string | null;
}

export interface ConservationArea {
  name: string;
  council: string | null;
  /** YYYY-MM-DD */
  designated: string | null;
}

export interface Article4Area {
  name: string;
  /** Permitted development rights it removes, as codes ("1A", "3L") */
  rights: string[];
  /** Removes the right to turn a home into a small HMO (class 3L), or says it is about HMOs */
  hmo: boolean;
  description: string | null;
}

export interface CrimeSummary {
  /** YYYY-MM */
  month: string;
  total: number;
  byCategory: Array<{ category: string; label: string; count: number }>;
}

export interface AreaChecks {
  checkedAt: string;
  point: AreaPoint;
  /** null when the check could not run */
  flood: FloodCheck | null;
  conservation: ConservationArea[] | null;
  article4: Article4Area[] | null;
  crime: CrimeSummary | null;
  /** The checks that failed, in words */
  failed: string[];
}

// ── Where the home is ────────────────────────────────────────────────────

/** Great Britain, roughly; anything outside is a wrong or missing position */
const inGreatBritain = (lat: number, lng: number) => lat > 49.8 && lat < 61 && lng > -8.7 && lng < 2;

export function pointFromListing(l: Pick<PropertyListing, 'latitude' | 'longitude'>): AreaPoint | null {
  const lat = Number(l.latitude);
  const lng = Number(l.longitude);
  if (l.latitude == null || l.longitude == null || !Number.isFinite(lat) || !Number.isFinite(lng) || !inGreatBritain(lat, lng)) return null;
  return { lat, lng, source: 'listing' };
}

/** postcodes.io answer → the postcode's centre */
export function pointFromPostcodeLookup(json: unknown): AreaPoint | null {
  const r = (json as { result?: { latitude?: unknown; longitude?: unknown } } | null)?.result;
  const lat = Number(r?.latitude);
  const lng = Number(r?.longitude);
  return r && Number.isFinite(lat) && Number.isFinite(lng) && inGreatBritain(lat, lng) ? { lat, lng, source: 'postcode' } : null;
}

// ── Crime ────────────────────────────────────────────────────────────────

/** data.police.uk category codes, in the words police.uk uses */
export const CRIME_LABELS: Record<string, string> = {
  'anti-social-behaviour': 'Anti-social behaviour',
  'bicycle-theft': 'Bicycle theft',
  burglary: 'Burglary',
  'criminal-damage-arson': 'Criminal damage and arson',
  drugs: 'Drugs',
  'other-theft': 'Other theft',
  'possession-of-weapons': 'Possession of weapons',
  'public-order': 'Public order',
  robbery: 'Robbery',
  shoplifting: 'Shoplifting',
  'theft-from-the-person': 'Theft from the person',
  'vehicle-crime': 'Vehicle crime',
  'violent-crime': 'Violence and sexual offences',
  'other-crime': 'Other crime',
};

/** Street crimes from data.police.uk, counted by category, most first */
export function summariseCrimes(json: unknown, month: string): CrimeSummary | null {
  if (!Array.isArray(json)) return null;
  const counts = new Map<string, number>();
  for (const c of json) {
    const category = typeof (c as { category?: unknown })?.category === 'string' ? (c as { category: string }).category : 'other-crime';
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const byCategory = [...counts]
    .map(([category, count]) => ({ category, label: CRIME_LABELS[category] ?? category.replace(/-/g, ' '), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { month, total: json.length, byCategory };
}

// ── England: planning.data.gov.uk ────────────────────────────────────────

const entities = (json: unknown): Array<Record<string, unknown>> => {
  const list = (json as { entities?: unknown } | null)?.entities;
  return Array.isArray(list) ? list.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object') : [];
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** "COLMORE ROW AND ENVIRONS CONSERVATION AREA" → "Colmore Row and Environs Conservation Area"; mixed case stays */
export function tidyName(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(And|Of|The|In|On|At)\b/g, (w) => w.toLowerCase())
    .replace(/^\w/, (c) => c.toUpperCase()).replace(/\bHmo\b/g, 'HMO');
}

/** Only directions still in force (no end date in the past) */
const inForce = (e: Record<string, unknown>, today: string) => {
  const end = str(e['end-date']);
  return !end || end > today;
};

export function parseArticle4(json: unknown, today: string): Article4Area[] {
  return entities(json).filter((e) => inForce(e, today)).map((e) => {
    const rights = (str(e['permitted-development-rights']) ?? '').split(';').map((r) => r.trim().toUpperCase()).filter(Boolean);
    const name = tidyName(str(e.name) ?? str(e.reference) ?? 'Article 4 direction');
    const description = str(e.description);
    const words = `${name} ${description ?? ''}`;
    return { name, rights, description, hmo: rights.includes('3L') || /\bHMOs?\b|multiple occupation/i.test(words) };
  });
}

export function parseConservation(json: unknown, today: string): ConservationArea[] {
  return entities(json).filter((e) => inForce(e, today)).map((e) => ({
    name: tidyName(str(e.name) ?? str(e.reference) ?? 'Conservation area'),
    council: null,
    designated: str(e['designation-date']),
  }));
}

/** The permitted development rights list: code → what it allows */
export function parseRightsNames(json: unknown): Record<string, string> {
  const names: Record<string, string> = {};
  for (const e of entities(json)) {
    const ref = str(e.reference);
    const name = str(e.name);
    if (ref && name) names[ref.toUpperCase()] = name;
  }
  return names;
}

// ── England: Environment Agency flood zones ──────────────────────────────

type Ring = number[][];

function inRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if ((yi! > y) !== (yj! > y) && x < ((xj! - xi!) * (y - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}

/** True when the point (lng, lat) is inside a GeoJSON Polygon or MultiPolygon, holes taken out */
export function pointInGeometry(lng: number, lat: number, geometry: unknown): boolean {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (!g || !Array.isArray(g.coordinates)) return false;
  const polygons = (g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : []) as Ring[][];
  return polygons.some((rings) => Array.isArray(rings) && rings.length > 0
    && inRing(rings[0]!, lng, lat) && !rings.slice(1).some((hole) => inRing(hole, lng, lat)));
}

/**
 * The Environment Agency answer (features whose box touches the point) →
 * the highest flood zone whose shape really holds the point.
 */
export function eaFloodZoneAt(json: unknown, lng: number, lat: number): FloodCheck {
  const features = (json as { features?: unknown } | null)?.features;
  let zone: FloodZone = 'none';
  let source: string | null = null;
  for (const f of Array.isArray(features) ? features : []) {
    const p = ((f as { properties?: unknown })?.properties ?? {}) as Record<string, unknown>;
    const z = p.flood_zone === 'FZ3' ? 'FZ3' : p.flood_zone === 'FZ2' ? 'FZ2' : null;
    if (!z || !pointInGeometry(lng, lat, (f as { geometry?: unknown }).geometry)) continue;
    if (zone !== 'FZ3' && (z === 'FZ3' || zone === 'none')) {
      zone = z;
      source = str(p.flood_source);
    }
  }
  return { zone, by: zone === 'none' ? null : 'Environment Agency', sourceOfFlooding: source };
}

// ── Wales: DataMapWales ──────────────────────────────────────────────────

const wfsFeatures = (json: unknown): Array<Record<string, unknown>> => {
  const features = (json as { features?: unknown } | null)?.features;
  return (Array.isArray(features) ? features : []).map((f) => ((f as { properties?: unknown })?.properties ?? {}) as Record<string, unknown>);
};

/** NRW Flood Map for Planning (rivers and sea): "Flood Zone 3" / "Flood Zone 2" */
export function walesFloodZone(json: unknown): FloodCheck {
  let zone: FloodZone = 'none';
  for (const p of wfsFeatures(json)) {
    const risk = String(p.risk ?? '');
    if (/zone\s*3/i.test(risk)) zone = 'FZ3';
    else if (/zone\s*2/i.test(risk) && zone === 'none') zone = 'FZ2';
  }
  return { zone, by: zone === 'none' ? null : 'Natural Resources Wales', sourceOfFlooding: null };
}

export function walesConservation(json: unknown): ConservationArea[] {
  return wfsFeatures(json).map((p) => ({
    name: tidyName(str(p.sitename) ?? 'Conservation area'),
    council: str(p.localplann) ? tidyName(str(p.localplann)!) : null,
    designated: str(p.designation_date)?.slice(0, 10) ?? null,
  }));
}

// ── Putting the checks together ──────────────────────────────────────────

export type AreaCountry = 'england' | 'wales';

/** The countries whose maps to ask: the home's own, or both on a border postcode (or with no postcode at all) */
export function areaCountries(l: Pick<PropertyListing, 'postcode' | 'postcodePartial'>): AreaCountry[] {
  const { region, sure } = taxRegionFromPostcode(l.postcode || l.postcodePartial);
  return sure ? [region] : ['england', 'wales'];
}

/**
 * Several sources answer for the same check (England and Wales; null = it
 * failed): the highest zone wins. "None" stands only when every source
 * answered, as the one that failed may cover the home.
 */
export function combineFlood(...checks: Array<FloodCheck | null>): FloodCheck | null {
  const done = checks.filter((c): c is FloodCheck => c !== null);
  if (done.length === 0) return null;
  const rank = { FZ3: 2, FZ2: 1, none: 0 } as const;
  const best = done.reduce((top, c) => (rank[c.zone] > rank[top.zone] ? c : top));
  return best.zone === 'none' && done.length < checks.length ? null : best;
}

/** Conservation areas from several sources (null = it failed); none found stands only when every source answered */
export function combineConservation(...lists: Array<ConservationArea[] | null>): ConservationArea[] | null {
  const done = lists.filter((l): l is ConservationArea[] => l !== null);
  const found = done.flat();
  return found.length > 0 || (done.length > 0 && done.length === lists.length) ? found : null;
}

/** What the dashboard, CSV and report need, kept on the listing */
export interface AreaSummary {
  checkedAt: string;
  floodZone: FloodZone | null;
  conservation: string | null;
  article4Count: number | null;
  hmoArticle4: boolean | null;
  crimeTotal: number | null;
  crimeMonth: string | null;
}

/**
 * The short version. In Wales there is no Article 4 map, so "none found"
 * there is unknown (null), never a clear "no HMO Article 4". A check that
 * failed this time keeps its result from the `previous` summary.
 */
export function summariseArea(a: AreaChecks, { wales, previous = null }: { wales: boolean; previous?: AreaSummary | null }): AreaSummary {
  const article4 = wales && a.article4?.length === 0 ? null : a.article4;
  const before = cleanAreaSummary(previous);
  // Nothing answered: the last summary stands, with the date it was checked
  if (before && !a.flood && !a.conservation && !article4 && !a.crime) return before;
  return {
    checkedAt: a.checkedAt,
    floodZone: a.flood ? a.flood.zone : before?.floodZone ?? null,
    conservation: a.conservation ? (a.conservation.map((c) => c.name).join('; ') || '') : before?.conservation ?? null,
    article4Count: article4 ? article4.length : a.article4 ? null : before?.article4Count ?? null,
    hmoArticle4: article4 ? article4.some((d) => d.hmo) : a.article4 ? null : before?.hmoArticle4 ?? null,
    crimeTotal: a.crime ? a.crime.total : before?.crimeTotal ?? null,
    crimeMonth: a.crime ? a.crime.month : before?.crimeMonth ?? null,
  };
}

/** Saved summary, checked */
export function cleanAreaSummary(saved: unknown): AreaSummary | null {
  if (!saved || typeof saved !== 'object') return null;
  const s = saved as Record<string, unknown>;
  if (typeof s.checkedAt !== 'string') return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    checkedAt: s.checkedAt,
    floodZone: s.floodZone === 'FZ3' || s.floodZone === 'FZ2' || s.floodZone === 'none' ? s.floodZone : null,
    conservation: typeof s.conservation === 'string' ? s.conservation.slice(0, 300) : null,
    article4Count: num(s.article4Count),
    hmoArticle4: typeof s.hmoArticle4 === 'boolean' ? s.hmoArticle4 : null,
    crimeTotal: num(s.crimeTotal),
    crimeMonth: typeof s.crimeMonth === 'string' && /^\d{4}-\d{2}$/.test(s.crimeMonth) ? s.crimeMonth : null,
  };
}

export const FLOOD_WORDS: Record<FloodZone, string> = {
  FZ3: 'Flood Zone 3: high chance of flooding from rivers or the sea',
  FZ2: 'Flood Zone 2: medium chance of flooding from rivers or the sea',
  none: 'Not in a flood zone for rivers or the sea',
};

// ── Fetching ─────────────────────────────────────────────────────────────

const PLANNING = 'https://www.planning.data.gov.uk/entity.json';
const EA_FLOOD = 'https://environment.data.gov.uk/geoservices/datasets/04532375-a198-476e-985e-0579a0a11b47/ogc/features/v1/collections/Flood_Zones_2_3_Rivers_and_Sea/items';
const WALES_WFS = 'https://datamap.gov.wales/geoserver/ows';
const POLICE = 'https://data.police.uk/api';
const POSTCODES = 'https://api.postcodes.io/postcodes/';

/** A week: crime figures come out monthly, planning maps change rarely */
const AREA_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const RIGHTS_CACHE_MS = 30 * 24 * 60 * 60 * 1000;

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** The listing's map position, else its full postcode's centre (postcodes.io) */
export async function findAreaPoint(listing: Pick<PropertyListing, 'latitude' | 'longitude' | 'postcode'>): Promise<AreaPoint | null> {
  const fromListing = pointFromListing(listing);
  if (fromListing) return fromListing;
  const postcode = (listing.postcode ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(postcode)) return null;
  try {
    return pointFromPostcodeLookup(await getJson(`${POSTCODES}${postcode}`, 10_000));
  } catch {
    return null;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

async function planning(dataset: string, p: AreaPoint): Promise<unknown> {
  const params = new URLSearchParams({ dataset, latitude: p.lat.toFixed(6), longitude: p.lng.toFixed(6), limit: '50', exclude_field: 'geometry,point' });
  return getJson(`${PLANNING}?${params}`, 15_000);
}

async function walesLayer(typeNames: string, propertyName: string, p: AreaPoint): Promise<unknown> {
  const params = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature', outputFormat: 'application/json', count: '20',
    typeNames, propertyName, cql_filter: `INTERSECTS(geom, SRID=4326;POINT(${p.lng.toFixed(6)} ${p.lat.toFixed(6)}))`,
  });
  return getJson(`${WALES_WFS}?${params}`, 20_000);
}

async function eaFlood(p: AreaPoint): Promise<FloodCheck> {
  // A box of about 2 m around the point; the shapes that touch it are checked exactly
  const e = 0.00002;
  const bbox = [p.lng - e, p.lat - e, p.lng + e, p.lat + e].map((n) => n.toFixed(6)).join(',');
  const json = await getJson(`${EA_FLOOD}?${new URLSearchParams({ bbox, f: 'json', limit: '100' })}`, 25_000);
  return eaFloodZoneAt(json, p.lng, p.lat);
}

async function crime(p: AreaPoint): Promise<CrimeSummary | null> {
  const latest = (await getJson(`${POLICE}/crime-last-updated`, 10_000)) as { date?: string };
  const month = (latest?.date ?? '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('No month');
  const params = new URLSearchParams({ lat: p.lat.toFixed(6), lng: p.lng.toFixed(6), date: month });
  return summariseCrimes(await getJson(`${POLICE}/crimes-street/all-crime?${params}`, 20_000), month);
}

/** What each permitted development right code means, kept for a month */
export async function rightsNames(): Promise<Record<string, string>> {
  const kept = await readCache<Record<string, string>>('pd-rights');
  if (kept) return kept.value;
  try {
    const names = parseRightsNames(await getJson(`${PLANNING}?${new URLSearchParams({ dataset: 'permitted-development-right', limit: '500', exclude_field: 'geometry,point' })}`, 15_000));
    if (Object.keys(names).length) await writeCache('pd-rights', names, RIGHTS_CACHE_MS);
    return names;
  } catch {
    return {};
  }
}

/**
 * Every check for a point, against the maps of the countries given; each
 * one that fails is named in `failed` instead of stopping the rest
 */
export async function fetchAreaChecks(point: AreaPoint, countries: AreaCountry[] = ['england', 'wales']): Promise<AreaChecks> {
  const failed: string[] = [];
  const england = countries.includes('england');
  const wales = countries.includes('wales');
  // undefined: not asked (the home is not in that country); null: asked and failed
  const attempt = async <T>(ask: boolean, what: string, run: () => Promise<T>): Promise<T | null | undefined> => {
    if (!ask) return undefined;
    try {
      return await run();
    } catch {
      failed.push(what);
      return null;
    }
  };
  const asked = <T>(...answers: Array<T | null | undefined>) => answers.filter((x): x is T | null => x !== undefined);
  const day = today();
  const [eaFloodCheck, walesFloodCheck, englandConservation, walesConservationAreas, article4, crimeSummary] = await Promise.all([
    attempt(england, 'flood zones (England)', () => eaFlood(point)),
    attempt(wales, 'flood zones (Wales)', async () => walesFloodZone(await walesLayer('inspire-nrw:NRW_FLOODZONE_RIVERS_SEAS_MERGED', 'risk,pub_date', point))),
    attempt(england, 'conservation areas (England)', async () => parseConservation(await planning('conservation-area', point), day)),
    attempt(wales, 'conservation areas (Wales)', async () => walesConservation(await walesLayer('geonode:conservation_areas_wales', 'localplann,sitename,designation_date', point))),
    attempt(england, 'Article 4 directions', async () => parseArticle4(await planning('article-4-direction-area', point), day)),
    attempt(true, 'street crime', () => crime(point)),
  ]);

  return {
    checkedAt: new Date().toISOString(),
    point,
    flood: combineFlood(...asked(eaFloodCheck, walesFloodCheck)),
    conservation: combineConservation(...asked(englandConservation, walesConservationAreas)),
    // Wales has no Article 4 map to ask, which the page and summary say as such
    article4: article4 === undefined ? [] : article4,
    crime: crimeSummary ?? null,
    failed,
  };
}

/** The checks for this point, kept for a week; `fresh` asks again */
export async function fetchAreaChecksCached(
  point: AreaPoint,
  { fresh = false, countries = ['england', 'wales'] }: { fresh?: boolean; countries?: AreaCountry[] } = {},
): Promise<AreaChecks> {
  const key = `area:${point.lat.toFixed(5)},${point.lng.toFixed(5)}:${[...countries].sort().join('+')}`;
  if (!fresh) {
    const kept = await readCache<AreaChecks>(key);
    if (kept) return kept.value;
  }
  const checks = await fetchAreaChecks(point, countries);
  // A check that failed is asked again next time instead of being kept
  if (checks.failed.length === 0) await writeCache(key, checks, AREA_CACHE_MS);
  return checks;
}
