import type { DealInputs } from './calculators';
import { cleanPipeline, type Pipeline } from './pipeline';
import { AGENTS_KEY, cleanActivity, cleanAgentNotes, cleanLabels, newActivity, type Activity, type AgentNotes } from './crm';
import { withLock } from './storage-lock';

/**
 * What the user types in for a listing: calculator numbers, deal status,
 * notes and follow-up date, labels, hidden or not, and the activity
 * timeline. Kept apart from the captured listing, so a new capture of the
 * same listing never overwrites it.
 */
export const USER_DATA_KEY = 'propsnap_user_data';

export interface ListingUserData {
  deal?: Partial<DealInputs>;
  pipeline?: Pipeline;
  labels?: string[];
  hidden?: boolean;
  /** Notes, calls and stage changes, oldest first */
  activity?: Activity[];
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

/**
 * Change a listing's whole entry under the lock: `change` gets the entry as
 * saved now and returns the new one. Empty parts and empty entries are removed.
 */
function updateEntry(key: string, change: (entry: ListingUserData) => ListingUserData): Promise<void> {
  return withLock(USER_DATA_KEY, async () => {
    const all = await getAllUserData();
    const entry = change({ ...all[key] });
    for (const part of Object.keys(entry) as (keyof ListingUserData)[]) {
      const value = entry[part];
      if (value == null || value === false || (Array.isArray(value) && value.length === 0)) delete entry[part];
    }
    if (Object.keys(entry).length > 0) all[key] = entry;
    else delete all[key];
    await chrome.storage.local.set({ [USER_DATA_KEY]: all });
  });
}

export async function saveDealInputs(key: string, deal: Partial<DealInputs> | null): Promise<void> {
  await savePart(key, 'deal', deal);
}

type PipelineFields = Omit<Pipeline, 'updatedAt'>;

/** A stage changed back within this long is taken as a mis-click */
const UNDO_STAGE_MS = 10 * 60_000;

/**
 * Save the pipeline fields given, keeping the others as saved now, so a page
 * showing an older copy never puts an old value back. "New" with nothing
 * else is the same as none.
 */
export async function updatePipeline(key: string, changes: Partial<PipelineFields>): Promise<void> {
  const now = new Date();
  await updateEntry(key, (entry) => {
    const current = cleanPipeline(entry.pipeline);
    const pipeline = cleanPipeline({
      status: current?.status ?? 'new',
      notes: current?.notes ?? '',
      followUp: current?.followUp ?? null,
      ...changes,
      updatedAt: now.toISOString(),
    });
    // A new stage goes in the timeline too
    const before = current?.status ?? 'new';
    const after = pipeline?.status ?? 'new';
    let activity = cleanActivity(entry.activity);
    if (changes.status && after !== before) {
      const stages = activity.filter((a) => a.kind === 'stage');
      const last = stages[stages.length - 1];
      const stageBeforeLast = stages[stages.length - 2]?.stage ?? 'new';
      // Going straight back within a few minutes undoes a mis-click instead of adding to the history
      if (last && activity[activity.length - 1] === last && now.getTime() - Date.parse(last.at) < UNDO_STAGE_MS && after === stageBeforeLast) {
        activity = activity.slice(0, -1);
      } else {
        activity.push(newActivity('stage', '', now, { stage: after }));
      }
    }
    return { ...entry, pipeline: pipeline ?? undefined, activity };
  });
}

export function setLabels(key: string, labels: string[]): Promise<void> {
  return updateEntry(key, (entry) => ({ ...entry, labels: cleanLabels(labels) }));
}

export function setHidden(key: string, hidden: boolean): Promise<void> {
  return updateEntry(key, (entry) => ({ ...entry, hidden }));
}

export function addActivity(key: string, activity: Activity): Promise<void> {
  return updateEntry(key, (entry) => ({ ...entry, activity: cleanActivity([...(entry.activity ?? []), activity]) }));
}

export function removeActivity(key: string, id: string): Promise<void> {
  return updateEntry(key, (entry) => ({ ...entry, activity: cleanActivity(entry.activity).filter((a) => a.id !== id) }));
}

/** Notes per agent branch, shown on every listing from that agent */
export async function getAgentNotes(): Promise<AgentNotes> {
  return cleanAgentNotes((await chrome.storage.local.get(AGENTS_KEY))[AGENTS_KEY]);
}

export function saveAgentNote(agent: string, note: string): Promise<void> {
  return withLock(AGENTS_KEY, async () => {
    const all = await getAgentNotes();
    if (note.trim()) all[agent] = { note: note.slice(0, 2_000), updatedAt: new Date().toISOString() };
    else delete all[agent];
    await chrome.storage.local.set({ [AGENTS_KEY]: all });
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

export async function clearUserData(): Promise<void> {
  await withLock(USER_DATA_KEY, () => chrome.storage.local.remove(USER_DATA_KEY));
  await withLock(AGENTS_KEY, () => chrome.storage.local.remove(AGENTS_KEY));
}
