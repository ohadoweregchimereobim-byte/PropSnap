import type { DealInputs } from './calculators';
import { cleanPipeline, type Pipeline } from './pipeline';
import { withLock } from './storage-lock';

/**
 * What the user types in for a listing: calculator numbers, and deal status,
 * notes and follow-up date. Kept apart from the captured listing, so a new
 * capture of the same listing never overwrites it.
 */
export const USER_DATA_KEY = 'propsnap_user_data';

export interface ListingUserData {
  deal?: Partial<DealInputs>;
  pipeline?: Pipeline;
}

export type UserDataMap = Record<string, ListingUserData>;

export const listingKey = (l: { source: string; listingId: string }) => `${l.source}:${l.listingId}`;

export async function getAllUserData(): Promise<UserDataMap> {
  const data = await chrome.storage.local.get(USER_DATA_KEY);
  return (data[USER_DATA_KEY] as UserDataMap | undefined) ?? {};
}

export async function getUserData(key: string): Promise<ListingUserData> {
  return (await getAllUserData())[key] ?? {};
}

/**
 * Set or clear (null) one part of a listing's user data; an empty entry is
 * removed. `next` can be worked out from the part as saved now, read under
 * the same lock, so a change saved elsewhere in between is never lost.
 */
function savePart<K extends keyof ListingUserData>(
  key: string,
  part: K,
  next: ListingUserData[K] | null | ((saved: ListingUserData[K] | undefined) => ListingUserData[K] | null),
): Promise<void> {
  return withLock(USER_DATA_KEY, async () => {
    const all = await getAllUserData();
    const entry = { ...all[key] };
    const value = typeof next === 'function' ? next(entry[part]) : next;
    if (value) entry[part] = value;
    else delete entry[part];
    if (Object.keys(entry).length > 0) all[key] = entry;
    else delete all[key];
    await chrome.storage.local.set({ [USER_DATA_KEY]: all });
  });
}

export async function saveDealInputs(key: string, deal: Partial<DealInputs> | null): Promise<void> {
  await savePart(key, 'deal', deal);
}

type PipelineFields = Omit<Pipeline, 'updatedAt'>;

/**
 * Save the pipeline fields given, keeping the others as saved now, so a page
 * showing an older copy never puts an old value back. "New" with nothing
 * else is the same as none.
 */
export async function updatePipeline(key: string, changes: Partial<PipelineFields>): Promise<void> {
  await savePart(key, 'pipeline', (saved) => {
    const current = cleanPipeline(saved);
    return cleanPipeline({
      status: current?.status ?? 'new',
      notes: current?.notes ?? '',
      followUp: current?.followUp ?? null,
      ...changes,
      updatedAt: new Date().toISOString(),
    });
  });
}

export function removeUserData(key: string): Promise<void> {
  return withLock(USER_DATA_KEY, async () => {
    const all = await getAllUserData();
    if (!(key in all)) return;
    delete all[key];
    await chrome.storage.local.set({ [USER_DATA_KEY]: all });
  });
}

export function clearUserData(): Promise<void> {
  return withLock(USER_DATA_KEY, () => chrome.storage.local.remove(USER_DATA_KEY));
}
