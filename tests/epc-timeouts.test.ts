import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { enrichWithEpc } from '../src/services/epc-api';

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
});

describe('certificate lookups after a refusal', () => {
  it('pause for ten minutes, then start again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T09:00:00Z'));

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
    vi.setSystemTime(new Date('2026-10-24T09:05:00Z'));
    await enrichWithEpc('token', listing());
    expect(lookups()).toBe(afterRefusal);

    // Eleven minutes on: asking again, and the floor area picks flat 1
    vi.setSystemTime(new Date('2026-10-24T09:11:00Z'));
    const result = await enrichWithEpc('token', listing());
    expect(lookups()).toBeGreaterThan(afterRefusal);
    expect(result.listing.fullAddress).toContain('Flat 1,');
    expect(result.listing.addressConfidence).toBe('exact');
  });
});
