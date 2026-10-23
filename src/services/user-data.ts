import type { DealInputs } from './calculators';

/**
 * What the user types in for a listing (calculator numbers now; notes and
 * deal status later). Kept apart from the captured listing, so a new
 * capture of the same listing never overwrites it.
 */
export const USER_DATA_KEY = 'propsnap_user_data';

export interface ListingUserData {
  deal?: Partial<DealInputs>;
}

type UserDataMap = Record<string, ListingUserData>;

export const listingKey = (l: { source: string; listingId: string }) => `${l.source}:${l.listingId}`;

async function getAll(): Promise<UserDataMap> {
  const data = await chrome.storage.local.get(USER_DATA_KEY);
  return (data[USER_DATA_KEY] as UserDataMap | undefined) ?? {};
}

export async function getUserData(key: string): Promise<ListingUserData> {
  return (await getAll())[key] ?? {};
}

export async function saveDealInputs(key: string, deal: Partial<DealInputs> | null): Promise<void> {
  const all = await getAll();
  const entry = { ...all[key] };
  if (deal) entry.deal = deal;
  else delete entry.deal;
  if (Object.keys(entry).length > 0) all[key] = entry;
  else delete all[key];
  await chrome.storage.local.set({ [USER_DATA_KEY]: all });
}

export async function removeUserData(key: string): Promise<void> {
  const all = await getAll();
  if (!(key in all)) return;
  delete all[key];
  await chrome.storage.local.set({ [USER_DATA_KEY]: all });
}

export async function clearUserData(): Promise<void> {
  await chrome.storage.local.remove(USER_DATA_KEY);
}
