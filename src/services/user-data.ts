import type { DealInputs } from './calculators';
import { cleanPipeline, type Pipeline } from './pipeline';

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

/** Set or clear (null) one part of a listing's user data; an empty entry is removed */
async function savePart<K extends keyof ListingUserData>(key: string, part: K, value: ListingUserData[K] | null): Promise<void> {
  const all = await getAllUserData();
  const entry = { ...all[key] };
  if (value) entry[part] = value;
  else delete entry[part];
  if (Object.keys(entry).length > 0) all[key] = entry;
  else delete all[key];
  await chrome.storage.local.set({ [USER_DATA_KEY]: all });
}

export async function saveDealInputs(key: string, deal: Partial<DealInputs> | null): Promise<void> {
  await savePart(key, 'deal', deal);
}

/** Save the status, notes and follow-up; "New" with nothing else is the same as none */
export async function savePipeline(key: string, pipeline: Omit<Pipeline, 'updatedAt'>): Promise<void> {
  await savePart(key, 'pipeline', cleanPipeline({ ...pipeline, updatedAt: new Date().toISOString() }));
}

export async function removeUserData(key: string): Promise<void> {
  const all = await getAllUserData();
  if (!(key in all)) return;
  delete all[key];
  await chrome.storage.local.set({ [USER_DATA_KEY]: all });
}

export async function clearUserData(): Promise<void> {
  await chrome.storage.local.remove(USER_DATA_KEY);
}
