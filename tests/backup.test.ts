import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import {
  backupFileName,
  makeBackup,
  planRestore,
  readAllForBackup,
  readBackup,
  restoreBackup,
  BACKUP_VERSION,
} from '../src/services/backup';

function listing(id: string, extra: Partial<PropertyListing> = {}): PropertyListing {
  return {
    listingId: id, source: 'zoopla', url: `https://www.zoopla.co.uk/${id}`, displayAddress: `Home ${id}`,
    postcode: null, postcodePartial: 'CF23', fullAddress: null, price: 250_000, priceQualifier: null, currency: 'GBP',
    listingType: 'sale', bedrooms: 3, propertyType: 'Terraced', agentName: null, agentPhone: null, agentBranch: null,
    latitude: null, longitude: null, tenure: null, furnished: null, deposit: null, epcRating: null,
    capturedAt: '2026-10-24T09:00:00Z', ...extra,
  };
}

const stored = () => ({
  propsnap_listings: [listing('1'), listing('2')],
  propsnap_user_data: { 'zoopla:1': { labels: ['BRR'] }, 'zoopla:2': { pipeline: { status: 'viewing', notes: 'Roof', followUp: null, updatedAt: '' } } },
  propsnap_agents: { 'acme|roath': { note: 'Ask for Sam', updatedAt: '' } },
  propsnap_plan: { keys: ['zoopla:1'], times: {}, date: '2026-10-30', start: '', minutes: 30 },
  propsnap_branding: { company: 'Acme', contact: '', colour: '#1d4ed8', logo: null },
  propsnap_letters: { templates: [], templateId: 'buyer', senderName: 'Sam', signOff: 'Kind regards' },
  propsnap_settings: { epcApiToken: 'SECRET-TOKEN', autoEnrich: true, floorAreaFromText: false },
  // The cache and the last backup date are not backed up
  propsnap_last_backup: '2026-10-01T00:00:00Z',
});

describe('making a backup', () => {
  it('holds everything the user saved, but never the EPC key', () => {
    const b = makeBackup(stored(), new Date('2026-10-24T12:00:00Z'), '0.8.0');
    expect(b).toMatchObject({ app: 'PropSnap', kind: 'backup', version: BACKUP_VERSION, createdAt: '2026-10-24T12:00:00.000Z', appVersion: '0.8.0' });
    expect(Object.keys(b.data)).toEqual(['propsnap_listings', 'propsnap_user_data', 'propsnap_agents', 'propsnap_plan', 'propsnap_branding', 'propsnap_letters', 'propsnap_settings']);
    expect(b.data.propsnap_settings).toEqual({ autoEnrich: true, floorAreaFromText: false });
    expect(JSON.stringify(b)).not.toContain('SECRET-TOKEN');
  });

  it('names the file by the day', () => {
    expect(backupFileName(new Date(2026, 9, 24, 23, 30))).toBe('propsnap-backup-2026-10-24.json');
  });
});

describe('reading a backup', () => {
  const good = () => makeBackup(stored(), new Date('2026-10-24T12:00:00Z'), '0.8.0');

  it('reads a good file back', () => {
    const r = readBackup(JSON.stringify(good()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.listings.map((l) => l.listingId)).toEqual(['1', '2']);
  });

  it('says why a file is not a backup', () => {
    expect(readBackup('not json')).toEqual({ ok: false, why: expect.stringMatching(/not JSON/) });
    expect(readBackup('{"app":"Other","kind":"backup","version":1,"data":{}}')).toEqual({ ok: false, why: expect.stringMatching(/not a PropSnap backup/) });
    expect(readBackup(JSON.stringify({ ...good(), version: BACKUP_VERSION + 1 }))).toEqual({ ok: false, why: expect.stringMatching(/newer PropSnap/) });
  });

  it('drops broken and repeated listings, unknown keys, and any EPC key in the file', () => {
    const file = good();
    file.data.propsnap_listings = [listing('1'), { listingId: 'x', source: 'evil' }, listing('1'), 'junk', listing('3')];
    (file.data as Record<string, unknown>).propsnap_something_else = { a: 1 };
    file.data.propsnap_settings = { epcApiToken: 'LEAKED', autoEnrich: false };
    const r = readBackup(JSON.stringify(file));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.listings.map((l) => l.listingId)).toEqual(['1', '3']);
    expect(r.skipped).toBe(3);
    expect(Object.keys(r.backup.data)).not.toContain('propsnap_something_else');
    expect(r.backup.data.propsnap_settings).toEqual({ autoEnrich: false });
  });
});

describe('planning a restore', () => {
  const backup = () => {
    const r = readBackup(JSON.stringify(makeBackup(stored(), new Date(), '0.8.0')));
    if (!r.ok) throw new Error(r.why);
    return r.backup;
  };

  it('add: brings in homes not saved here, with their notes, and changes nothing else', () => {
    const current = {
      propsnap_listings: [listing('2', { price: 199_000 }), listing('9')],
      propsnap_user_data: { 'zoopla:2': { labels: ['Mine'] } },
      propsnap_agents: { 'acme|roath': { note: 'My own note', updatedAt: '' } },
      propsnap_settings: { epcApiToken: 'HERE', autoEnrich: false, floorAreaFromText: true },
    };
    const { write, remove, added } = planRestore(current, backup(), 'add');
    expect(added).toBe(1);
    expect(remove).toEqual([]);
    const listings = write.propsnap_listings as PropertyListing[];
    expect(listings.map((l) => l.listingId)).toEqual(['2', '9', '1']);
    // The home already here keeps its own price and notes
    expect(listings[0]!.price).toBe(199_000);
    expect(write.propsnap_user_data).toEqual({ 'zoopla:2': { labels: ['Mine'] }, 'zoopla:1': { labels: ['BRR'] } });
    expect(write.propsnap_agents).toEqual({ 'acme|roath': { note: 'My own note', updatedAt: '' } });
    expect(write).not.toHaveProperty('propsnap_settings');
    expect(write).not.toHaveProperty('propsnap_branding');
  });

  it('replace: everything becomes the backup, but this computer keeps its EPC key', () => {
    const current = { propsnap_listings: [listing('9')], propsnap_settings: { epcApiToken: 'HERE', autoEnrich: false } };
    const { write, remove, added } = planRestore(current, backup(), 'replace');
    expect(added).toBe(2);
    expect(remove).toEqual([]);
    expect((write.propsnap_listings as PropertyListing[]).map((l) => l.listingId)).toEqual(['1', '2']);
    expect(write.propsnap_settings).toEqual({ autoEnrich: true, floorAreaFromText: false, epcApiToken: 'HERE' });
    expect(write.propsnap_branding).toMatchObject({ company: 'Acme' });
  });

  it('replace: removes what the backup does not have', () => {
    const b = backup();
    delete b.data.propsnap_plan;
    expect(planRestore({}, b, 'replace').remove).toEqual(['propsnap_plan']);
  });
});

describe('restoring into storage', () => {
  let data: Record<string, unknown>;
  beforeEach(() => {
    data = {};
    const copy = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
    const keys = (k: string | string[]) => (Array.isArray(k) ? k : [k]);
    vi.stubGlobal('chrome', { storage: { local: {
      async get(k: string | string[]) { return Object.fromEntries(keys(k).filter((x) => x in data).map((x) => [x, copy(data[x])])); },
      async set(items: Record<string, unknown>) { data = { ...data, ...copy(items) }; },
      async remove(k: string | string[]) { for (const x of keys(k)) delete data[x]; },
    } } });
  });

  it('round trip: back up, clear, restore gives the same data back, with the key kept here', async () => {
    data = stored();
    const file = JSON.stringify(makeBackup(await readAllForBackup(), new Date(), '0.8.0'));
    const before = { ...data };
    data = { propsnap_settings: { epcApiToken: 'NEW-COMPUTER-KEY', autoEnrich: true, floorAreaFromText: true } };
    const r = readBackup(file);
    if (!r.ok) throw new Error(r.why);
    await restoreBackup(r.backup, 'replace');
    for (const key of ['propsnap_listings', 'propsnap_user_data', 'propsnap_agents', 'propsnap_plan', 'propsnap_branding', 'propsnap_letters']) {
      expect(data[key]).toEqual(before[key as keyof typeof before]);
    }
    expect(data.propsnap_settings).toEqual({ autoEnrich: true, floorAreaFromText: false, epcApiToken: 'NEW-COMPUTER-KEY' });
  });
});
