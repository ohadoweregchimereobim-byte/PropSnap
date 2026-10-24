import { describe, expect, it } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import {
  addLabel,
  agentKey,
  allLabels,
  cleanActivity,
  cleanAgentNotes,
  cleanLabel,
  cleanLabels,
  groupByAgent,
  lastCall,
  newActivity,
  removeLabel,
  stageForOutcome,
  timeline,
  whenText,
  type Activity,
} from '../src/services/crm';

describe('labels', () => {
  it('cleans, adds once ignoring case, and keeps the built-in spelling', () => {
    expect(cleanLabel('  motivated   seller ')).toBe('motivated seller');
    expect(cleanLabel('   ')).toBeNull();
    expect(cleanLabel('x'.repeat(50))).toHaveLength(30);
    expect(addLabel([], 'motivated seller')).toEqual(['Motivated seller']);
    expect(addLabel(['BRR'], 'brr')).toEqual(['BRR']);
    expect(addLabel(['BRR'], 'Corner plot')).toEqual(['BRR', 'Corner plot']);
    expect(removeLabel(['BRR', 'HMO'], 'hmo')).toEqual(['BRR']);
  });

  it('checks saved labels and lists every label to offer', () => {
    expect(cleanLabels(['HMO', 'hmo', 7, '', 'Garage'])).toEqual(['HMO', 'Garage']);
    expect(cleanLabels('nope')).toEqual([]);
    const all = allLabels([['Garage', 'BRR'], ['annex']]);
    expect(all.slice(0, 7)).toEqual(['Potential flip', 'BRR', 'Buy-to-let', 'HMO', 'Needs work', 'Motivated seller', 'Do not contact']);
    expect(all.slice(7)).toEqual(['annex', 'Garage']);
  });
});

describe('activity', () => {
  const at = (iso: string) => new Date(iso);

  it('checks saved entries and keeps them oldest first', () => {
    const kept = cleanActivity([
      { id: 'b', at: '2026-10-20T10:00:00Z', kind: 'call', text: 'Agent says flexible', outcome: 'spoke' },
      { id: 'a', at: '2026-10-19T10:00:00Z', kind: 'note', text: 'Nice road' },
      { id: 'c', at: 'not a date', kind: 'note', text: 'x' },
      { id: 'd', at: '2026-10-21T10:00:00Z', kind: 'note', text: '   ' },
      { id: 'e', at: '2026-10-21T10:00:00Z', kind: 'stage', text: '', stage: 'hacked' },
      { id: 'f', at: '2026-10-21T10:00:00Z', kind: 'call', text: '', outcome: 'weird' },
      'junk',
    ]);
    expect(kept.map((a) => a.id)).toEqual(['a', 'b', 'f']);
    expect(kept[2]!.outcome).toBe('spoke');
    expect(cleanActivity(null)).toEqual([]);
  });

  it('makes new entries with a time and trimmed text', () => {
    const a = newActivity('call', '  Left voicemail  ', at('2026-10-23T09:00:00Z'), { outcome: 'left_message' });
    expect(a).toMatchObject({ at: '2026-10-23T09:00:00.000Z', kind: 'call', text: 'Left voicemail', outcome: 'left_message' });
    expect(a.id).toMatch(/\w+-\w+/);
  });

  it('builds a timeline with price changes and the first capture, newest first', () => {
    const activity: Activity[] = [
      { id: '1', at: '2026-10-05T10:00:00Z', kind: 'note', text: 'Needs a new kitchen' },
      { id: '2', at: '2026-10-15T10:00:00Z', kind: 'call', text: '', outcome: 'viewing_booked' },
      { id: '3', at: '2026-10-16T10:00:00Z', kind: 'stage', text: '', stage: 'viewing' },
    ];
    const items = timeline(activity, [
      { price: 300_000, qualifier: 'Guide price', seenAt: '2026-10-01T09:00:00Z' },
      { price: 300_000, qualifier: 'Offers over', seenAt: '2026-10-08T09:00:00Z' },
      { price: 290_000, qualifier: 'Offers over', seenAt: '2026-10-12T09:00:00Z' },
    ]);
    expect(items.map((i) => `${i.title}: ${i.text}`)).toEqual([
      'Stage: Viewing booked: ',
      'Call: Booked a viewing: ',
      'Price reduced: £300,000 → £290,000',
      'Note: Needs a new kitchen',
      'First captured: Guide price £300,000',
    ]);
    expect(items[0]!.id).toBe('3');
    expect(items[2]!.id).toBeUndefined();
  });

  it('finds the last call and says when', () => {
    const calls: Activity[] = [
      { id: '1', at: '2026-10-10T10:00:00Z', kind: 'call', text: '', outcome: 'spoke' },
      { id: '2', at: '2026-10-20T10:00:00Z', kind: 'call', text: '', outcome: 'no_answer' },
      { id: '3', at: '2026-10-22T10:00:00Z', kind: 'note', text: 'x' },
    ];
    expect(lastCall(calls)?.id).toBe('2');
    expect(lastCall([])).toBeNull();
    const now = new Date(2026, 9, 23, 12, 0);
    expect(whenText(new Date(2026, 9, 23, 8, 0).toISOString(), now)).toBe('today');
    expect(whenText(new Date(2026, 9, 22, 23, 0).toISOString(), now)).toBe('yesterday');
    expect(whenText(new Date(2026, 9, 18, 9, 0).toISOString(), now)).toBe('5 days ago');
  });
});

describe('the site listed date in the timeline', () => {
  it('adds "Listed on" at the date the site gives', () => {
    const items = timeline([], null, { on: '2026-03-06', site: 'Zoopla' });
    expect(items).toEqual([{ at: '2026-03-06T00:00:00.000Z', kind: 'listed', title: 'Listed on Zoopla', text: '' }]);
    expect(timeline([], null, { on: null, site: 'Zoopla' })).toEqual([]);
  });
});

describe('calls that move the stage', () => {
  it('maps the stage outcomes, and leaves the others alone', () => {
    expect(stageForOutcome('viewing_booked')).toBe('viewing');
    expect(stageForOutcome('offer_made')).toBe('offer');
    expect(stageForOutcome('offer_accepted')).toBe('accepted');
    expect(stageForOutcome('offer_rejected')).toBe('rejected');
    expect(stageForOutcome('spoke')).toBeNull();
    expect(stageForOutcome('no_answer')).toBeNull();
  });

  it('keeps the stage on a call and says so in the timeline', () => {
    const [call] = cleanActivity([{ id: 'c', at: '2026-10-20T09:00:00Z', kind: 'call', text: '', outcome: 'offer_accepted', stage: 'accepted' }]);
    expect(call!.stage).toBe('accepted');
    expect(timeline([call!], null)[0]!.title).toBe('Call: Offer accepted (stage moved to Offer accepted)');
    expect(cleanActivity([{ id: 'd', at: '2026-10-20T09:00:00Z', kind: 'call', text: '', outcome: 'spoke', stage: 'nonsense' }])[0]!.stage).toBeUndefined();
  });
});

describe('agents', () => {
  const listing = (id: string, agentName: string | null, agentBranch: string | null, extra: Partial<PropertyListing> = {}) =>
    ({ listingId: id, source: 'zoopla', agentName, agentBranch, agentPhone: null, ...extra }) as PropertyListing;

  it('gives one key per agent branch, however it is written', () => {
    expect(agentKey(listing('1', 'Example Estates', 'Roath'))).toBe('example estates|roath');
    expect(agentKey(listing('2', ' example  ESTATES ', 'roath.'))).toBe('example estates|roath');
    expect(agentKey(listing('3', null, null))).toBeNull();
  });

  it('groups listings by agent A to Z, with the last call and the agent note', () => {
    const listings = [
      listing('1', 'Zeta Homes', null, { agentPhone: '029 1' }),
      listing('2', 'Example Estates', 'Roath'),
      listing('3', null, null, { agentPhone: '07700 900000' }),
      listing('4', 'example estates', 'Roath', { agentPhone: '029 2' }),
    ];
    const activity: Record<string, Activity[]> = {
      '2': [{ id: 'a', at: '2026-10-10T10:00:00Z', kind: 'call', text: '', outcome: 'spoke' }],
      '4': [{ id: 'b', at: '2026-10-20T10:00:00Z', kind: 'call', text: '', outcome: 'no_answer' }],
    };
    const groups = groupByAgent(listings, (l) => activity[l.listingId] ?? [], { 'example estates|roath': { note: 'Ask for Sam', updatedAt: '' } });
    expect(groups.map((g) => `${g.name} (${g.listings.map((l) => l.listingId).join(',')})`)).toEqual([
      'Example Estates (2,4)', 'Zeta Homes (1)', 'No agent (3)',
    ]);
    expect(groups[0]).toMatchObject({ branch: 'Roath', phone: '029 2', note: 'Ask for Sam' });
    expect(groups[0]!.lastCall?.id).toBe('b');
    // A home with no agent never lends its phone to the group
    expect(groups[2]!.phone).toBeNull();
  });

  it('checks saved agent notes', () => {
    expect(cleanAgentNotes({ a: { note: 'Hi', updatedAt: 'x' }, b: { note: '  ' }, c: 'junk' })).toEqual({ a: { note: 'Hi', updatedAt: 'x' } });
  });
});
