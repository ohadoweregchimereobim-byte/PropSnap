import type { PricePoint, PropertyListing } from '../adapters/types';
import { formatMoney } from './format';
import { STATUSES, statusLabel, type PipelineStatus } from './pipeline';

/**
 * Keeping track of each deal: labels, hidden homes, a dated activity
 * timeline (notes, calls, stage changes), and notes per agent. Pure, so it
 * is unit tested; the user-data store saves it.
 */

// ── Labels ──────────────────────────────────────────────────────────────

/** Also leaves a home out of every letter (letters.ts) */
export const DO_NOT_CONTACT_LABEL = 'Do not contact';

/** Offered on every listing; the user can add their own */
export const BUILT_IN_LABELS = ['Potential flip', 'BRR', 'Buy-to-let', 'HMO', 'Needs work', 'Motivated seller', DO_NOT_CONTACT_LABEL];

export const LABEL_MAX = 30;
const LABELS_PER_LISTING = 20;

/** "  motivated   seller " → "motivated seller"; null when empty */
export function cleanLabel(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const label = text.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX).trim();
  return label || null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The labels with one added (once, ignoring case, in the spelling already used) */
export function addLabel(labels: string[], text: string, known: string[] = BUILT_IN_LABELS): string[] {
  const label = cleanLabel(text);
  if (!label || labels.some((l) => same(l, label)) || labels.length >= LABELS_PER_LISTING) return labels;
  return [...labels, known.find((k) => same(k, label)) ?? label];
}

export const removeLabel = (labels: string[], label: string) => labels.filter((l) => !same(l, label));

/** Saved labels, checked */
export function cleanLabels(saved: unknown): string[] {
  if (!Array.isArray(saved)) return [];
  return saved.reduce<string[]>((kept, l) => addLabel(kept, typeof l === 'string' ? l : '', []), []);
}

/** Every label to offer: the built-in ones first, then the user's own A to Z */
export function allLabels(used: Iterable<string[]>): string[] {
  const own = new Map<string, string>();
  for (const labels of used) {
    for (const l of labels) if (!BUILT_IN_LABELS.some((b) => same(b, l))) own.set(l.toLowerCase(), l);
  }
  return [...BUILT_IN_LABELS, ...[...own.values()].sort((a, b) => a.localeCompare(b, 'en-GB'))];
}

// ── Activity timeline ───────────────────────────────────────────────────

export const CALL_OUTCOMES = [
  { value: 'spoke', label: 'Spoke to the agent' },
  { value: 'left_message', label: 'Left a message' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'viewing_booked', label: 'Booked a viewing' },
  { value: 'offer_made', label: 'Made an offer' },
  { value: 'offer_accepted', label: 'Offer accepted' },
  { value: 'offer_rejected', label: 'Offer rejected' },
] as const;

export type CallOutcome = typeof CALL_OUTCOMES[number]['value'];

/** The deal stage a call outcome means, or null when it leaves the stage as it is */
export function stageForOutcome(outcome: CallOutcome | undefined): PipelineStatus | null {
  switch (outcome) {
    case 'viewing_booked': return 'viewing';
    case 'offer_made': return 'offer';
    case 'offer_accepted': return 'accepted';
    case 'offer_rejected': return 'rejected';
    default: return null;
  }
}

export interface Activity {
  id: string;
  /** ISO 8601 */
  at: string;
  /** A letter: `text` is the letter's name */
  kind: 'note' | 'call' | 'stage' | 'letter';
  text: string;
  /** Calls only */
  outcome?: CallOutcome;
  /** Stage changes: the new stage. Calls: the stage the call moved the deal to, if it did */
  stage?: PipelineStatus;
}

export const ACTIVITY_TEXT_MAX = 2_000;
/** Oldest entries go beyond this */
const ACTIVITY_MAX = 300;

export function newActivity(kind: Activity['kind'], text: string, now: Date, extra: Pick<Activity, 'outcome' | 'stage'> = {}): Activity {
  return {
    id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: now.toISOString(),
    kind,
    text: text.trim().slice(0, ACTIVITY_TEXT_MAX),
    ...extra,
  };
}

/** Saved activity, checked, oldest first */
export function cleanActivity(saved: unknown): Activity[] {
  if (!Array.isArray(saved)) return [];
  const kept: Activity[] = [];
  for (const raw of saved) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    if (typeof a.id !== 'string' || typeof a.at !== 'string' || Number.isNaN(Date.parse(a.at))) continue;
    if (a.kind !== 'note' && a.kind !== 'call' && a.kind !== 'stage' && a.kind !== 'letter') continue;
    const text = typeof a.text === 'string' ? a.text.slice(0, ACTIVITY_TEXT_MAX) : '';
    const entry: Activity = { id: a.id, at: a.at, kind: a.kind, text };
    if (a.kind === 'call') {
      entry.outcome = CALL_OUTCOMES.some((o) => o.value === a.outcome) ? (a.outcome as CallOutcome) : 'spoke';
      if (STATUSES.some((s) => s.value === a.stage)) entry.stage = a.stage as PipelineStatus;
    }
    if (a.kind === 'stage') {
      if (!STATUSES.some((s) => s.value === a.stage)) continue;
      entry.stage = a.stage as PipelineStatus;
    }
    if (a.kind === 'note' && !text.trim()) continue;
    kept.push(entry);
  }
  return kept.sort((x, y) => x.at.localeCompare(y.at)).slice(-ACTIVITY_MAX);
}

export const outcomeLabel = (outcome: CallOutcome | undefined) => CALL_OUTCOMES.find((o) => o.value === outcome)?.label ?? 'Call';

/** One line in the timeline */
export interface TimelineItem {
  at: string;
  kind: Activity['kind'] | 'price' | 'captured' | 'listed';
  title: string;
  text: string;
  /** Set on the user's own entries, so they can be deleted */
  id?: string;
}

/**
 * The user's activity with the listing's price changes and first capture,
 * and the date the site first listed it when known, newest first
 */
export function timeline(
  activity: Activity[],
  priceHistory: PricePoint[] | null | undefined,
  listed?: { on: string | null | undefined; site: string } | null,
): TimelineItem[] {
  const items: TimelineItem[] = activity.map((a) => ({
    at: a.at,
    kind: a.kind,
    id: a.id,
    title: a.kind === 'call'
      ? `Call: ${outcomeLabel(a.outcome)}${a.stage ? ` (stage moved to ${statusLabel(a.stage)})` : ''}`
      : a.kind === 'stage' ? `Stage: ${statusLabel(a.stage)}` : a.kind === 'letter' ? 'Letter sent' : 'Note',
    text: a.text,
  }));

  const prices = (priceHistory ?? []).filter((p) => typeof p.price === 'number' && p.price > 0);
  prices.forEach((p, i) => {
    if (i === 0) {
      items.push({ at: p.seenAt, kind: 'captured', title: 'First captured', text: `${p.qualifier ? `${p.qualifier} ` : ''}${formatMoney(p.price!)}` });
      return;
    }
    const before = prices[i - 1]!.price!;
    if (p.price === before) return;
    const down = p.price! < before;
    items.push({
      at: p.seenAt,
      kind: 'price',
      title: down ? 'Price reduced' : 'Price increased',
      text: `${formatMoney(before)} → ${formatMoney(p.price!)}`,
    });
  });

  if (listed?.on && /^\d{4}-\d{2}-\d{2}$/.test(listed.on)) {
    items.push({ at: `${listed.on}T00:00:00.000Z`, kind: 'listed', title: `Listed on ${listed.site}`, text: '' });
  }

  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/** The newest logged call, or null */
export function lastCall(activity: Activity[]): Activity | null {
  return activity.filter((a) => a.kind === 'call').reduce<Activity | null>((latest, a) => (!latest || a.at > latest.at ? a : latest), null);
}

/** Whole days from an ISO time to now, by the user's calendar days */
export function daysAgo(iso: string, now: Date): number {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.max(0, Math.round((day(now) - day(new Date(iso))) / 86_400_000));
}

/** "today", "yesterday", "5 days ago" */
export function whenText(iso: string, now: Date): string {
  const days = daysAgo(iso, now);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

// ── Agents ──────────────────────────────────────────────────────────────

export const AGENTS_KEY = 'propsnap_agents';

export interface AgentNote {
  note: string;
  updatedAt: string;
}

export type AgentNotes = Record<string, AgentNote>;

/** One key per agent branch: "Example Estates|Roath" and "example estates | roath" are the same; null with no agent */
export function agentKey(l: Pick<PropertyListing, 'agentName' | 'agentBranch'>): string | null {
  const part = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const name = part(l.agentName);
  return name ? `${name}|${part(l.agentBranch)}` : null;
}

export interface AgentGroup {
  key: string;
  name: string;
  branch: string | null;
  phone: string | null;
  listings: PropertyListing[];
  /** The newest call logged on any of this agent's listings */
  lastCall: Activity | null;
  note: string;
}

/**
 * The listings grouped by agent, in the order given within each group;
 * groups A to Z, and listings with no agent last.
 */
export function groupByAgent(
  listings: PropertyListing[],
  activityOf: (l: PropertyListing) => Activity[],
  notes: AgentNotes,
): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const l of listings) {
    const key = agentKey(l) ?? '';
    let group = groups.get(key);
    if (!group) {
      group = { key, name: key ? l.agentName!.trim() : 'No agent', branch: l.agentBranch?.trim() || null, phone: null, listings: [], lastCall: null, note: key ? notes[key]?.note ?? '' : '' };
      groups.set(key, group);
    }
    group.listings.push(l);
    if (key) group.phone ??= l.agentPhone?.trim() || null;
    const call = lastCall(activityOf(l));
    if (call && (!group.lastCall || call.at > group.lastCall.at)) group.lastCall = call;
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.key || !b.key) return a.key ? -1 : b.key ? 1 : 0;
    return a.name.localeCompare(b.name, 'en-GB') || (a.branch ?? '').localeCompare(b.branch ?? '', 'en-GB');
  });
}

/** Saved agent notes, checked */
export function cleanAgentNotes(saved: unknown): AgentNotes {
  const kept: AgentNotes = {};
  if (!saved || typeof saved !== 'object') return kept;
  for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
    const v = value as Record<string, unknown> | null;
    if (!v || typeof v.note !== 'string' || !v.note.trim()) continue;
    kept[key] = { note: v.note.slice(0, ACTIVITY_TEXT_MAX), updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '' };
  }
  return kept;
}
