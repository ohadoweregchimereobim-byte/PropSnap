import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { chooseAddress, clearListings, deleteListing, getListings, saveListing } from '../src/services/storage';
import { getAllUserData, getUserData, saveDealInputs, updatePipeline } from '../src/services/user-data';

/**
 * A stand-in for chrome.storage.local. Every call waits a tick, like the real
 * one, so two saves started together really do overlap.
 */
function fakeStorage() {
  let data: Record<string, unknown> = {};
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const copy = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const local = {
    async get(key: string) {
      await tick();
      return key in data ? { [key]: copy(data[key]) } : {};
    },
    async set(items: Record<string, unknown>) {
      await tick();
      data = { ...data, ...copy(items) };
    },
    async remove(key: string) {
      await tick();
      delete data[key];
    },
  };
  vi.stubGlobal('chrome', { storage: { local } });
}

function listing(id: string, extra: Partial<PropertyListing> = {}): PropertyListing {
  return {
    listingId: id,
    source: 'rightmove',
    url: `https://www.rightmove.co.uk/properties/${id}`,
    displayAddress: 'Tweedsmuir Road, Cardiff',
    postcode: 'CF24 2QH',
    postcodePartial: 'CF24',
    fullAddress: null,
    price: 300_000,
    priceQualifier: null,
    currency: 'GBP',
    listingType: 'sale',
    bedrooms: 3,
    propertyType: 'Terraced',
    agentName: null,
    agentPhone: null,
    agentBranch: null,
    latitude: null,
    longitude: null,
    tenure: null,
    furnished: null,
    deposit: null,
    epcRating: null,
    capturedAt: '2026-10-01T10:00:00Z',
    ...extra,
  };
}

const candidates = [
  { fullAddress: '1 Tweedsmuir Road, Cardiff', postcode: 'CF24 2QH', certificateNumber: 'c1', epcRating: 'D', floorAreaSqm: 80, propertyType: 'House' },
  { fullAddress: '3 Tweedsmuir Road, Cardiff', postcode: 'CF24 2QH', certificateNumber: 'c3', epcRating: 'D', floorAreaSqm: 80, propertyType: 'House' },
];

beforeEach(() => {
  vi.unstubAllGlobals();
  fakeStorage();
});

describe('saving listings', () => {
  it('keeps one copy per listing, newest first, with every price seen', async () => {
    await saveListing(listing('1'));
    await saveListing(listing('2'));
    await saveListing(listing('1', { price: 290_000, capturedAt: '2026-10-12T10:00:00Z' }));

    const saved = await getListings();
    expect(saved.map((l) => l.listingId)).toEqual(['1', '2']);
    expect(saved[0]!.priceHistory?.map((p) => p.price)).toEqual([300_000, 290_000]);
  });

  it('keeps the home the user picked when the listing is captured again', async () => {
    await saveListing(listing('1', { fullAddress: candidates[0]!.fullAddress, addressConfidence: 'best_guess', addressCandidates: candidates }));
    await chooseAddress('rightmove', '1', 'c3');
    await saveListing(listing('1', { fullAddress: candidates[0]!.fullAddress, addressConfidence: 'best_guess', addressCandidates: candidates }));

    const [saved] = await getListings();
    expect(saved!.fullAddress).toBe('3 Tweedsmuir Road, Cardiff');
    expect(saved!.addressConfidence).toBe('user_choice');
  });

  it('loses neither of two captures saved at the same moment', async () => {
    await Promise.all([saveListing(listing('1')), saveListing(listing('2')), saveListing(listing('3'))]);
    expect((await getListings()).map((l) => l.listingId).sort()).toEqual(['1', '2', '3']);
  });

  it('keeps a capture that lands while the user picks a home', async () => {
    await saveListing(listing('1', { fullAddress: candidates[0]!.fullAddress, addressConfidence: 'best_guess', addressCandidates: candidates }));
    await Promise.all([chooseAddress('rightmove', '1', 'c3'), saveListing(listing('2'))]);

    const saved = await getListings();
    expect(saved).toHaveLength(2);
    expect(saved.find((l) => l.listingId === '1')!.addressConfidence).toBe('user_choice');
  });

  it('deletes what the user typed with the listing', async () => {
    await saveListing(listing('1'));
    await saveListing(listing('2'));
    await saveDealInputs('rightmove:1', { price: 280_000 });
    await saveDealInputs('rightmove:2', { price: 250_000 });

    await deleteListing('rightmove', '1');
    expect((await getListings()).map((l) => l.listingId)).toEqual(['2']);
    expect(Object.keys(await getAllUserData())).toEqual(['rightmove:2']);
  });

  it('clears everything', async () => {
    await saveListing(listing('1'));
    await saveDealInputs('rightmove:1', { price: 280_000 });
    await clearListings();
    expect(await getListings()).toEqual([]);
    expect(await getAllUserData()).toEqual({});
  });
});

describe('saving the deal pipeline', () => {
  it('changes only the fields given', async () => {
    await updatePipeline('rightmove:1', { status: 'viewing', notes: 'Agent says flexible' });
    await updatePipeline('rightmove:1', { status: 'offer' });

    const { pipeline } = await getUserData('rightmove:1');
    expect(pipeline).toMatchObject({ status: 'offer', notes: 'Agent says flexible', followUp: null });
  });

  it('keeps a stage changed on the dashboard when notes are saved from the listing page', async () => {
    await updatePipeline('rightmove:1', { status: 'viewing', notes: 'First' });
    // The dashboard changes the stage while the listing page saves new notes
    await Promise.all([
      updatePipeline('rightmove:1', { status: 'offer' }),
      updatePipeline('rightmove:1', { notes: 'First. Offer at 290k' }),
    ]);

    const { pipeline } = await getUserData('rightmove:1');
    expect(pipeline).toMatchObject({ status: 'offer', notes: 'First. Offer at 290k' });
  });

  it('removes the entry when nothing is left', async () => {
    await updatePipeline('rightmove:1', { status: 'viewing' });
    await updatePipeline('rightmove:1', { status: 'new' });
    expect(await getAllUserData()).toEqual({});
  });

  it('keeps the deal numbers and the pipeline apart', async () => {
    await Promise.all([
      saveDealInputs('rightmove:1', { price: 280_000 }),
      updatePipeline('rightmove:1', { followUp: '2026-11-02' }),
    ]);
    const data = await getUserData('rightmove:1');
    expect(data.deal).toEqual({ price: 280_000 });
    expect(data.pipeline?.followUp).toBe('2026-11-02');
  });
});
