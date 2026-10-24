import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { readCache, writeCache } from '../src/services/session-cache';
import { enrichWithEpc } from '../src/services/epc-api';
import { fetchSoldPricesCached } from '../src/services/land-registry';

/** A stand-in for chrome.storage.session */
function fakeSession() {
  let data: Record<string, unknown> = {};
  const session = {
    async get(key: string | null) {
      if (key === null) return { ...data };
      return key in data ? { [key]: data[key] } : {};
    },
    async set(items: Record<string, unknown>) { data = { ...data, ...JSON.parse(JSON.stringify(items)) }; },
    async remove(keys: string | string[]) { for (const k of [keys].flat()) delete data[k]; },
  };
  vi.stubGlobal('chrome', { storage: { session } });
  return () => data;
}

const HOUR = 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T09:00:00Z'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('session cache', () => {
  it('gives back what was kept, with when, until it is too old', async () => {
    fakeSession();
    await writeCache('a', [1, 2], HOUR);
    expect(await readCache('a')).toEqual({ value: [1, 2], at: Date.parse('2026-10-24T09:00:00Z') });

    vi.setSystemTime(new Date('2026-10-24T10:01:00Z'));
    expect(await readCache('a')).toBeNull();
  });

  it('drops old entries when it keeps a new one, whatever their own age limit', async () => {
    const data = fakeSession();
    await writeCache('short', 1, HOUR);
    await writeCache('long', 2, 30 * 24 * HOUR);
    vi.setSystemTime(new Date('2026-10-24T11:00:00Z'));
    await writeCache('new', 3, HOUR);
    expect(Object.keys(data()).sort()).toEqual(['propsnap_cache:long', 'propsnap_cache:new']);
  });

  it('starts again when the store is full', async () => {
    const data = fakeSession();
    await writeCache('old', 1, HOUR);
    const session = (globalThis as any).chrome.storage.session;
    const set = session.set;
    let full = true;
    session.set = async (items: Record<string, unknown>) => {
      if (full) { full = false; throw new Error('QUOTA_BYTES quota exceeded'); }
      return set(items);
    };
    await writeCache('new', 2, HOUR);
    expect(Object.keys(data())).toEqual(['propsnap_cache:new']);
  });

  it('keeps no certificate that came back empty', async () => {
    fakeSession();
    const fetchMock = vi.fn(async (url: string) => url.includes('/search')
      ? new Response(JSON.stringify({ data: [flat(1), flat(2)] }))
      : new Response(JSON.stringify({ unexpected: true })));
    vi.stubGlobal('fetch', fetchMock);
    const lookups = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/certificate')).length;
    await enrichWithEpc('token', listing());
    await enrichWithEpc('token', listing());
    expect(lookups()).toBe(4);
  });

  it('does nothing where there is no session storage', async () => {
    vi.stubGlobal('chrome', undefined);
    await writeCache('a', 1, HOUR);
    expect(await readCache('a')).toBeNull();
  });
});

function listing(): PropertyListing {
  return {
    listingId: '1', source: 'zoopla', url: 'https://example.test', displayAddress: 'Ferry Court, Cardiff',
    postcode: 'CF11 0AS', postcodePartial: 'CF11', fullAddress: null, price: null, priceQualifier: null,
    currency: 'GBP', listingType: 'sale', bedrooms: 2, propertyType: 'Flat', floorAreaSqm: 60,
    agentName: null, agentPhone: null, agentBranch: null, latitude: null, longitude: null,
    tenure: null, furnished: null, deposit: null, epcRating: null, capturedAt: '2026-10-18T00:00:00Z',
  };
}

const flat = (n: number) => ({
  certificateNumber: `cert-${n}`, addressLine1: `Flat ${n}`, addressLine2: 'Ferry Court',
  postcode: 'CF11 0AS', postTown: 'CARDIFF', currentEnergyEfficiencyBand: 'C', registrationDate: '2024-01-01',
});

describe('kept certificate details', () => {
  it('are not fetched twice', async () => {
    fakeSession();
    const fetchMock = vi.fn(async (url: string) => url.includes('/search')
      ? new Response(JSON.stringify({ data: [flat(1), flat(2), flat(3)] }))
      : new Response(JSON.stringify({ data: { total_floor_area: url.endsWith('cert-1') ? 60 : 90 } })));
    vi.stubGlobal('fetch', fetchMock);
    const lookups = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/certificate')).length;

    const first = await enrichWithEpc('token', listing());
    expect(lookups()).toBe(3);
    const second = await enrichWithEpc('token', listing());
    expect(lookups()).toBe(3);
    expect(second.listing.fullAddress).toBe(first.listing.fullAddress);
    expect(second.listing.addressConfidence).toBe('exact');
  });
});

describe('kept sold prices', () => {
  const answer = {
    results: { bindings: [{
      transx: { value: 'http://landregistry.data.gov.uk/data/ppi/transaction/1' },
      amount: { value: '250000' }, date: { value: '2025-03-01' },
      propertyType: { value: 'http://landregistry.data.gov.uk/def/common/terraced' },
      postcode: { value: 'CF24 2QH' },
    }] },
  };
  const area = { postcode: 'CF24 2QH', street: null, outcode: null };

  it('are the same area however the postcode is written', async () => {
    fakeSession();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer)));
    vi.stubGlobal('fetch', fetchMock);
    await fetchSoldPricesCached(area);
    await fetchSoldPricesCached({ ...area, postcode: 'cf242qh' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('come from the cache the second time, and Refresh asks again', async () => {
    fakeSession();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer)));
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchSoldPricesCached(area);
    expect(first.sales).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
    const second = await fetchSoldPricesCached(area);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.at).toBe(Date.parse('2026-10-24T09:00:00Z'));

    const fresh = await fetchSoldPricesCached(area, { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fresh.at).toBe(Date.parse('2026-10-24T12:00:00Z'));
  });

  it('say which search failed, and are not kept until both answer', async () => {
    fakeSession();
    const both = { postcode: 'CF24 2QH', street: 'TWEEDSMUIR ROAD', outcode: 'CF24' };
    let streetUp = false;
    // The street search is the slow one; it fails the first time
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (String(init?.body).includes('STRSTARTS') && !streetUp
      ? new Response('', { status: 503 })
      : new Response(JSON.stringify(answer))));
    vi.stubGlobal('fetch', fetchMock);

    const half = await fetchSoldPricesCached(both);
    expect(half.sales).toHaveLength(1);
    expect(half.failed).toEqual(['street']);

    streetUp = true;
    const whole = await fetchSoldPricesCached(both);
    expect(whole.failed).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await fetchSoldPricesCached(both);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('are asked for again after a day', async () => {
    fakeSession();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer)));
    vi.stubGlobal('fetch', fetchMock);
    await fetchSoldPricesCached(area);
    vi.setSystemTime(new Date('2026-10-25T09:01:00Z'));
    await fetchSoldPricesCached(area);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
