import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { enrichWithEpc, retryAfterMs } from '../src/services/epc-api';

function listing(): PropertyListing {
  return {
    listingId: '1',
    source: 'zoopla',
    url: 'https://example.test',
    displayAddress: 'Ferry Court, Cardiff',
    postcode: 'CF11 0AS',
    postcodePartial: 'CF11',
    fullAddress: null,
    price: null,
    priceQualifier: null,
    currency: 'GBP',
    listingType: 'sale',
    bedrooms: 2,
    propertyType: 'Flat',
    floorAreaSqm: 60,
    agentName: null,
    agentPhone: null,
    agentBranch: null,
    latitude: null,
    longitude: null,
    tenure: null,
    furnished: null,
    deposit: null,
    epcRating: null,
    capturedAt: '2026-10-18T00:00:00Z',
  };
}

const flat = (n: number) => ({
  certificateNumber: `cert-${n}`,
  addressLine1: `Flat ${n}`,
  addressLine2: 'Ferry Court',
  postcode: 'CF11 0AS',
  postTown: 'CARDIFF',
  currentEnergyEfficiencyBand: 'C',
  registrationDate: '2024-01-01',
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('EPC requests that take too long', () => {
  it('gives every request a time limit', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes('/search') ? { data: [flat(1), flat(2)] } : { data: { total_floor_area: 60 } })));
    vi.stubGlobal('fetch', fetchMock);

    await enrichWithEpc('token', listing());
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('says the EPC register did not answer, instead of waiting forever', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }));

    const result = await enrichWithEpc('token', listing());
    expect(result.enrichmentStatus).toBe('api_error');
    expect(result.enrichmentDetail).toContain('did not answer in 15 seconds');
  });

  it('gives the same message when the answer stops halfway', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new DOMException('signal timed out', 'TimeoutError'); },
    })));

    const result = await enrichWithEpc('token', listing());
    expect(result.enrichmentDetail).toContain('did not answer in 15 seconds');
  });
});

describe('certificate lookups that hang', () => {
  it('stop after the first pair instead of waiting on every one', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/search')) return new Response(JSON.stringify({ data: [1, 2, 3, 4, 5, 6].map(flat) }));
      throw new DOMException('signal timed out', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichWithEpc('token', listing());
    const lookups = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/certificate'));
    expect(lookups).toHaveLength(2);
    expect(result.enrichmentStatus).toBe('enriched');
    expect(result.listing.addressConfidence).toBe('best_guess');
  });
});

describe('certificate lookups after a refusal', () => {
  it('pause for ten minutes, then start again', async () => {
    // An hour on, so a pause left by the tests above is over
    const start = Date.now() + 60 * 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);

    let refuse = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/search')) return new Response(JSON.stringify({ data: [flat(1), flat(2), flat(3)] }));
      if (refuse) return new Response('', { status: 404 });
      return new Response(JSON.stringify({ data: { total_floor_area: url.endsWith('cert-1') ? 60 : 90 } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const lookups = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/certificate')).length;

    await enrichWithEpc('token', listing());
    expect(lookups()).toBeGreaterThan(0);
    const afterRefusal = lookups();

    // Five minutes on: still paused
    refuse = false;
    vi.setSystemTime(start + 5 * 60_000);
    await enrichWithEpc('token', listing());
    expect(lookups()).toBe(afterRefusal);

    // Eleven minutes on: asking again, and the floor area picks flat 1
    vi.setSystemTime(start + 11 * 60_000);
    const result = await enrichWithEpc('token', listing());
    expect(lookups()).toBeGreaterThan(afterRefusal);
    expect(result.listing.fullAddress).toContain('Flat 1,');
    expect(result.listing.addressConfidence).toBe('exact');
  });
});

describe('certificate lookups when rate limited', () => {
  it('wait as long as the register asks, then start again', async () => {
    // Hours on, so no pause from the tests above is left
    const start = Date.now() + 3 * 60 * 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);

    let limited = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/search')) return new Response(JSON.stringify({ data: [flat(1), flat(2), flat(3)] }));
      if (limited) return new Response('', { status: 429, headers: { 'Retry-After': '30' } });
      return new Response(JSON.stringify({ data: { total_floor_area: 60 } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const lookups = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/certificate')).length;

    await enrichWithEpc('token', listing());
    const afterLimit = lookups();
    expect(afterLimit).toBeGreaterThan(0);

    // Ten seconds on: still waiting
    limited = false;
    vi.setSystemTime(start + 10_000);
    await enrichWithEpc('token', listing());
    expect(lookups()).toBe(afterLimit);

    // Forty seconds on: asking again
    vi.setSystemTime(start + 40_000);
    await enrichWithEpc('token', listing());
    expect(lookups()).toBeGreaterThan(afterLimit);
  });

  it('reads Retry-After as seconds or a date', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(retryAfterMs('30', now)).toBe(30_000);
    expect(retryAfterMs('Sat, 24 Oct 2026 12:02:00 GMT', now)).toBe(120_000);
    expect(retryAfterMs(null, now)).toBe(60_000);
    expect(retryAfterMs('soon', now)).toBe(60_000);
    expect(retryAfterMs('0', now)).toBe(1000);
    expect(retryAfterMs('86400', now)).toBe(10 * 60_000);
  });
});
