import type { PropertyListing } from '../adapters/types';
import { AGENTS_KEY } from './crm';
import { BRANDING_KEY } from './branding';
import { LETTERS_KEY } from './letters';
import { LISTINGS_KEY, SETTINGS_KEY } from './storage';
import { USER_DATA_KEY, listingKey } from './user-data';
import { PLAN_KEY } from './viewing-plan';
import { withLock } from './storage-lock';

/**
 * Back up everything the user has saved to one file, and restore it on this
 * computer or another. The checks are pure, so they are unit tested.
 *
 * The EPC API key is never written to the file: a backup can end up in an
 * email or a cloud folder. Restoring keeps the key this computer has.
 * The session cache (sold prices, certificates, area checks) is not backed
 * up; it fills again on its own.
 */

export const BACKUP_APP = 'PropSnap';
export const BACKUP_KIND = 'backup';
export const BACKUP_VERSION = 1;
/** When the user last made a backup on this computer; not itself backed up */
export const LAST_BACKUP_KEY = 'propsnap_last_backup';
/** A backup bigger than this is not a PropSnap backup (a logo is at most about 0.4 MB) */
export const BACKUP_MAX_BYTES = 50 * 1024 * 1024;

/** Everything a backup holds, in the order it is written */
export const BACKUP_KEYS = [LISTINGS_KEY, USER_DATA_KEY, AGENTS_KEY, PLAN_KEY, BRANDING_KEY, LETTERS_KEY, SETTINGS_KEY] as const;
type BackupKey = typeof BACKUP_KEYS[number];

export interface BackupFile {
  app: typeof BACKUP_APP;
  kind: typeof BACKUP_KIND;
  version: number;
  createdAt: string;
  /** The PropSnap version that made it */
  appVersion: string;
  data: Partial<Record<BackupKey, unknown>>;
}

/** The settings that go in a backup: never the EPC key */
function settingsWithoutKey(settings: unknown): Record<string, unknown> | undefined {
  if (!settings || typeof settings !== 'object') return undefined;
  const { epcApiToken: _key, ...rest } = settings as Record<string, unknown>;
  return rest;
}

/** The backup file for what storage holds now */
export function makeBackup(stored: Record<string, unknown>, now: Date, appVersion: string): BackupFile {
  const data: Partial<Record<BackupKey, unknown>> = {};
  for (const key of BACKUP_KEYS) {
    const value = key === SETTINGS_KEY ? settingsWithoutKey(stored[key]) : stored[key];
    if (value !== undefined) data[key] = value;
  }
  return { app: BACKUP_APP, kind: BACKUP_KIND, version: BACKUP_VERSION, createdAt: now.toISOString(), appVersion, data };
}

export const backupFileName = (now: Date) => {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `propsnap-backup-${day}.json`;
};

const SOURCES = new Set(['rightmove', 'zoopla', 'openrent']);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A saved listing has at least these; anything else is checked when the pages read it */
function isListing(v: unknown): v is PropertyListing {
  return isObject(v)
    && typeof v.source === 'string' && SOURCES.has(v.source)
    && typeof v.listingId === 'string' && v.listingId.length > 0
    && typeof v.url === 'string'
    && typeof v.displayAddress === 'string'
    && typeof v.capturedAt === 'string';
}

export interface ReadBackup {
  ok: true;
  backup: BackupFile;
  listings: PropertyListing[];
  /** Listings in the file that were not usable */
  skipped: number;
}

/** Read and check a backup file's text; says why when it is not one */
export function readBackup(text: string): ReadBackup | { ok: false; why: string } {
  if (text.length > BACKUP_MAX_BYTES) return { ok: false, why: 'This file is too big to be a PropSnap backup.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, why: 'This file is not a PropSnap backup (it is not JSON).' };
  }
  if (!isObject(parsed) || parsed.app !== BACKUP_APP || parsed.kind !== BACKUP_KIND || !isObject(parsed.data)) {
    return { ok: false, why: 'This file is not a PropSnap backup.' };
  }
  if (typeof parsed.version !== 'number' || parsed.version > BACKUP_VERSION) {
    return { ok: false, why: 'This backup was made by a newer PropSnap. Update PropSnap, then restore it.' };
  }

  const raw = parsed.data;
  const data: Partial<Record<BackupKey, unknown>> = {};
  // Only the keys PropSnap knows, each of the right shape
  const rawListings = Array.isArray(raw[LISTINGS_KEY]) ? raw[LISTINGS_KEY] as unknown[] : [];
  const seen = new Set<string>();
  const listings = rawListings.filter((l): l is PropertyListing => {
    if (!isListing(l)) return false;
    const key = listingKey(l);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  data[LISTINGS_KEY] = listings;
  for (const key of [USER_DATA_KEY, AGENTS_KEY, PLAN_KEY, BRANDING_KEY, LETTERS_KEY] as const) {
    if (isObject(raw[key])) data[key] = raw[key];
  }
  const settings = settingsWithoutKey(raw[SETTINGS_KEY]);
  if (settings) data[SETTINGS_KEY] = settings;

  return {
    ok: true,
    backup: {
      app: BACKUP_APP,
      kind: BACKUP_KIND,
      version: parsed.version,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '',
      data,
    },
    listings,
    skipped: rawListings.length - listings.length,
  };
}

export type RestoreMode = 'add' | 'replace';

/**
 * What storage should hold after a restore.
 * add: homes not saved here are added, with their notes and labels; every
 *      home already here, and every setting, stays as it is.
 * replace: everything becomes the backup's, except the EPC key, which stays.
 * Returns only the keys to write; null means remove that key.
 */
export function planRestore(
  current: Record<string, unknown>,
  backup: BackupFile,
  mode: RestoreMode,
): { write: Record<string, unknown>; remove: string[]; added: number } {
  const incoming = (backup.data[LISTINGS_KEY] ?? []) as PropertyListing[];
  const currentListings = (Array.isArray(current[LISTINGS_KEY]) ? current[LISTINGS_KEY] : []) as PropertyListing[];
  const incomingUserData = (backup.data[USER_DATA_KEY] ?? {}) as Record<string, unknown>;
  const keyHere = (current[SETTINGS_KEY] as { epcApiToken?: unknown } | undefined)?.epcApiToken;

  if (mode === 'replace') {
    const write: Record<string, unknown> = {};
    const remove: string[] = [];
    for (const key of BACKUP_KEYS) {
      let value = backup.data[key];
      if (key === SETTINGS_KEY) value = { ...((value as object) ?? {}), ...(typeof keyHere === 'string' && keyHere ? { epcApiToken: keyHere } : {}) };
      if (value === undefined) remove.push(key);
      else write[key] = value;
    }
    return { write, remove, added: incoming.length };
  }

  const have = new Set(currentListings.map(listingKey));
  const newOnes = incoming.filter((l) => !have.has(listingKey(l)));
  const userData = { ...((current[USER_DATA_KEY] as Record<string, unknown> | undefined) ?? {}) };
  for (const l of newOnes) {
    const key = listingKey(l);
    if (incomingUserData[key] !== undefined && userData[key] === undefined) userData[key] = incomingUserData[key];
  }
  // Agent notes: add the agents this computer has no note for
  const agents = { ...((backup.data[AGENTS_KEY] as Record<string, unknown> | undefined) ?? {}), ...((current[AGENTS_KEY] as Record<string, unknown> | undefined) ?? {}) };
  const write: Record<string, unknown> = { [LISTINGS_KEY]: [...currentListings, ...newOnes], [USER_DATA_KEY]: userData };
  if (Object.keys(agents).length) write[AGENTS_KEY] = agents;
  return { write, remove: [], added: newOnes.length };
}

// ── Storage ──────────────────────────────────────────────────────────────

export async function readAllForBackup(): Promise<Record<string, unknown>> {
  return chrome.storage.local.get([...BACKUP_KEYS]);
}

/** Restore under every lock a save uses, so nothing is saved half way through */
export async function restoreBackup(backup: BackupFile, mode: RestoreMode): Promise<{ added: number }> {
  const run = async () => {
    const current = await chrome.storage.local.get([...BACKUP_KEYS]);
    const { write, remove, added } = planRestore(current, backup, mode);
    if (remove.length) await chrome.storage.local.remove(remove);
    await chrome.storage.local.set(write);
    return { added };
  };
  return withLock(LISTINGS_KEY, () => withLock(USER_DATA_KEY, () => withLock(AGENTS_KEY, run)));
}

export async function getLastBackup(): Promise<string | null> {
  const at = (await chrome.storage.local.get(LAST_BACKUP_KEY))[LAST_BACKUP_KEY];
  return typeof at === 'string' ? at : null;
}

export async function noteBackupMade(at: Date): Promise<void> {
  await chrome.storage.local.set({ [LAST_BACKUP_KEY]: at.toISOString() });
}

/** Save the backup as a file download */
export function downloadBackup(backup: BackupFile, now: Date): void {
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFileName(now);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
