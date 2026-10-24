import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { chooseAddress, clearListings, deleteListing, getListings, saveListing } from '../src/services/storage';
import { addActivity, getAgentNotes, getAllUserData, getUserData, removeActivity, saveAgentNote, saveDealInputs, setHidden, setLabels, updatePipeline } from '../src/services/user-data';
import { newActivity } from '../src/services/crm';

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

describe('labels, hiding, activity and agent notes', () => {
  it('keeps a stage changed back later in the timeline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
      await updatePipeline('rightmove:1', { status: 'offer' });
      vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
      await updatePipeline('rightmove:1', { status: 'new' });
      // Back to New a day later is history, not a mis-click
      expect((await getUserData('rightmove:1')).activity?.map((a) => a.stage)).toEqual(['offer', 'new']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a stage change in the timeline, but not other pipeline saves', async () => {
    await updatePipeline('rightmove:1', { notes: 'hello' });
    await updatePipeline('rightmove:1', { status: 'viewing' });
    await updatePipeline('rightmove:1', { status: 'viewing' });
    await updatePipeline('rightmove:1', { followUp: '2026-10-30' });
    const activity = (await getUserData('rightmove:1')).activity ?? [];
    expect(activity.map((a) => [a.kind, a.stage])).toEqual([['stage', 'viewing']]);
  });

  it('saves labels and hidden, and removes them when cleared', async () => {
    await setLabels('rightmove:1', ['BRR', 'brr', 'HMO']);
    await setHidden('rightmove:1', true);
    expect(await getUserData('rightmove:1')).toEqual({ labels: ['BRR', 'HMO'], hidden: true });
    await setLabels('rightmove:1', []);
    await setHidden('rightmove:1', false);
    expect(await getAllUserData()).toEqual({});
  });

  it('loses neither of two notes added at the same moment, and deletes one', async () => {
    const a = newActivity('note', 'first', new Date('2026-10-23T09:00:00Z'));
    const b = newActivity('call', 'second', new Date('2026-10-23T09:01:00Z'), { outcome: 'spoke' });
    await Promise.all([addActivity('rightmove:1', a), addActivity('rightmove:1', b)]);
    expect((await getUserData('rightmove:1')).activity?.map((x) => x.text)).toEqual(['first', 'second']);
    await removeActivity('rightmove:1', a.id);
    expect((await getUserData('rightmove:1')).activity?.map((x) => x.text)).toEqual(['second']);
  });

  it('keeps agent notes apart, and Clear all removes them', async () => {
    await saveAgentNote('example estates|roath', 'Ask for Sam');
    await saveAgentNote('zeta|', 'Slow to reply');
    await saveAgentNote('zeta|', '  ');
    expect(Object.keys(await getAgentNotes())).toEqual(['example estates|roath']);
    await clearListings();
    expect(await getAgentNotes()).toEqual({});
  });
});

