/**
 * Deal pipeline: where the user is with each listing, their notes and the
 * next follow-up. Pure, so it is unit tested; the user-data store saves it.
 */

export const STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'researching', label: 'Researching' },
  { value: 'viewing', label: 'Viewing booked' },
  { value: 'offer', label: 'Offer made' },
  { value: 'accepted', label: 'Offer accepted' },
  { value: 'bought', label: 'Bought' },
  { value: 'rejected', label: 'Offer rejected' },
  { value: 'passed', label: 'Not interested' },
] as const;

export type PipelineStatus = typeof STATUSES[number]['value'];

/** Stages where the user is still working on the deal */
const ACTIVE: PipelineStatus[] = ['researching', 'viewing', 'offer', 'accepted'];
const CLOSED: PipelineStatus[] = ['bought', 'rejected', 'passed'];

export interface Pipeline {
  status: PipelineStatus;
  notes: string;
  /** YYYY-MM-DD, or null for none */
  followUp: string | null;
  updatedAt: string;
}

export const NOTES_MAX = 5_000;

export function statusLabel(status: PipelineStatus | null | undefined): string {
  return STATUSES.find((s) => s.value === status)?.label ?? 'New';
}

export const isActive = (status: PipelineStatus) => ACTIVE.includes(status);
export const isClosed = (status: PipelineStatus) => CLOSED.includes(status);

/** Saved data comes from storage, so keep only values of the right kind */
export function cleanPipeline(saved: unknown): Pipeline | null {
  if (!saved || typeof saved !== 'object') return null;
  const s = saved as Record<string, unknown>;
  const status = STATUSES.some((x) => x.value === s.status) ? (s.status as PipelineStatus) : 'new';
  const notes = typeof s.notes === 'string' ? s.notes.slice(0, NOTES_MAX) : '';
  const followUp = typeof s.followUp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.followUp) ? s.followUp : null;
  const updatedAt = typeof s.updatedAt === 'string' ? s.updatedAt : '';
  if (status === 'new' && !notes.trim() && !followUp) return null;
  return { status, notes, followUp, updatedAt };
}

/** Today's date as YYYY-MM-DD in the user's own time zone */
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export type FollowUpState = 'overdue' | 'today' | 'soon' | 'later';

/** How near a follow-up is; "soon" is within the next 7 days. Null when there is none, or the deal is closed */
export function followUpState(p: Pipeline | null, today: string): FollowUpState | null {
  if (!p?.followUp || isClosed(p.status)) return null;
  if (p.followUp < today) return 'overdue';
  if (p.followUp === today) return 'today';
  const days = (Date.parse(`${p.followUp}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return days <= 7 ? 'soon' : 'later';
}

/** Follow-ups due today or overdue */
export const isDue = (p: Pipeline | null, today: string) => {
  const state = followUpState(p, today);
  return state === 'overdue' || state === 'today';
};
