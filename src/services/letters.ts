import type { PropertyListing } from '../adapters/types';
import type { Branding } from './branding';
import { DO_NOT_CONTACT_LABEL } from './crm';

/**
 * Printable letters to the owners of saved homes. Pure, so it is unit
 * tested; the letters page prints them and the timeline logs them.
 *
 * A letter goes only to a full address PropSnap is sure of (an exact match
 * or a home the user picked), never to a best guess, and never to a home
 * labelled "Do not contact".
 */

export const LETTERS_KEY = 'propsnap_letters';
export const DO_NOT_CONTACT = DO_NOT_CONTACT_LABEL;

export interface LetterTemplate {
  id: string;
  name: string;
  body: string;
}

export interface LetterSettings {
  templates: LetterTemplate[];
  templateId: string;
  /** Signs the letter */
  senderName: string;
  /** "Kind regards" */
  signOff: string;
}

export const TEMPLATE_NAME_MAX = 60;
export const TEMPLATE_BODY_MAX = 4_000;
export const SENDER_MAX = 80;

export const PLACEHOLDERS = ['{street}', '{address}', '{date}', '{your name}', '{company}', '{contact}'];

const OPT_OUT = "If you would rather not hear from me again, just let me know using the details above and I won't write to you again.";

export const DEFAULT_TEMPLATES: LetterTemplate[] = [
  {
    id: 'buyer',
    name: 'A buyer for your home',
    body: `Dear Owner,

I am looking to buy a home on {street} and I am writing to ask whether you would consider selling yours.

I can move at a pace that suits you. If you would like to talk about it, with no obligation at all, please get in touch.

${OPT_OUT}`,
  },
  {
    id: 'on-market',
    name: 'Your home has been for sale a while',
    body: `Dear Owner,

I have seen that your home on {street} has been for sale for some time. Sometimes a sale takes longer than anyone hoped, and I wanted to let you know that I am a buyer who is interested in homes like yours.

If your plans change, or you would like to talk about other options, please get in touch. There is no obligation.

${OPT_OUT}`,
  },
  {
    id: 'landlord',
    name: 'To a landlord',
    body: `Dear Owner,

I am writing about {address}. I buy homes in this area, including homes that are let, and I wanted to ask whether you have thought about selling.

I can buy with a tenant in place if that suits you. If you would like to talk about it, with no obligation, please get in touch.

${OPT_OUT}`,
  },
];

export const DEFAULT_LETTER_SETTINGS: LetterSettings = {
  templates: DEFAULT_TEMPLATES,
  templateId: 'buyer',
  senderName: '',
  signOff: 'Kind regards',
};

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max) : '');

/** Saved settings, checked; a built-in template the user deleted or broke comes back */
export function cleanLetterSettings(saved: unknown): LetterSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const templates: LetterTemplate[] = [];
  const savedTemplates = Array.isArray(s.templates) ? s.templates : [];
  for (const raw of savedTemplates) {
    const t = (raw ?? {}) as Record<string, unknown>;
    const id = typeof t.id === 'string' ? t.id.slice(0, 40) : '';
    const body = text(t.body, TEMPLATE_BODY_MAX);
    if (!id || !body.trim() || templates.some((x) => x.id === id)) continue;
    templates.push({ id, name: text(t.name, TEMPLATE_NAME_MAX).trim() || 'Letter', body });
  }
  for (const builtIn of DEFAULT_TEMPLATES) {
    if (!templates.some((t) => t.id === builtIn.id)) templates.push(builtIn);
  }
  const templateId = typeof s.templateId === 'string' && templates.some((t) => t.id === s.templateId) ? s.templateId : templates[0]!.id;
  return {
    templates,
    templateId,
    senderName: text(s.senderName, SENDER_MAX).replace(/\s+/g, ' ').trim(),
    signOff: text(s.signOff, SENDER_MAX).replace(/\s+/g, ' ').trim() || DEFAULT_LETTER_SETTINGS.signOff,
  };
}

const KEEP_UPPER = /^([A-Z]{1,2}\d[A-Z\d]?|\d[A-Z]{2}|\d+[A-Z]?)$/;

function titleCase(line: string): string {
  return line
    .toLowerCase()
    .split(/(\s+)/)
    .map((w) => (KEEP_UPPER.test(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

/** "FLAT 3, 10 HIGH STREET, CARDIFF" + "CF10 1AA" → ["The Owner", "Flat 3", "10 High Street", "Cardiff", "CF10 1AA"] */
export function recipientLines(fullAddress: string, postcode: string | null | undefined): string[] {
  const pc = (postcode ?? '').toUpperCase().trim();
  const parts = fullAddress.split(',').map((p) => p.trim()).filter(Boolean)
    // The postcode goes on its own last line
    .map((p) => (pc && p.toUpperCase().endsWith(pc) ? p.slice(0, -pc.length).trim() : p))
    .filter(Boolean)
    .map(titleCase);
  return ['The Owner', ...parts, ...(pc ? [pc] : [])];
}

/** The street name from a full address: "10 HIGH STREET, CARDIFF" → "High Street" */
export function streetOf(fullAddress: string): string {
  for (const part of fullAddress.split(',').map((p) => p.trim())) {
    if (/^(FLAT|APARTMENT|APT|UNIT|MAISONETTE)\b/i.test(part)) continue;
    const street = part.replace(/^\d+[A-Z]?(\s*-\s*\d+[A-Z]?)?\s+/i, '').trim();
    if (street && !/\d/.test(street)) return titleCase(street);
  }
  return 'your street';
}

/** Fills {placeholders}, ignoring case; unknown ones stay as typed */
export function fillTemplate(body: string, values: Record<string, string>): string {
  const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return body.replace(/\{([^{}]{1,30})\}/g, (whole, name: string) => lower[name.trim().toLowerCase()] ?? whole);
}

export type Letter =
  | { key: string; ok: true; recipient: string[]; date: string; body: string; signOff: string; senderName: string }
  | { key: string; ok: false; why: string };

/** One letter for a home, or why it is left out */
export function letterFor(
  listing: PropertyListing,
  labels: string[],
  settings: LetterSettings,
  branding: Pick<Branding, 'company' | 'contact'>,
  today: Date,
): Letter {
  const key = `${listing.source}:${listing.listingId}`;
  if (labels.some((l) => l.toLowerCase() === DO_NOT_CONTACT.toLowerCase())) {
    return { key, ok: false, why: 'Labelled "Do not contact"' };
  }
  if (!listing.fullAddress) return { key, ok: false, why: 'No full address yet: capture it with the EPC lookup on' };
  if (listing.addressConfidence !== 'exact' && listing.addressConfidence !== 'user_choice') {
    return { key, ok: false, why: 'The address is a best guess: pick the right home on the dashboard first' };
  }

  const template = settings.templates.find((t) => t.id === settings.templateId) ?? settings.templates[0]!;
  const date = today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const recipient = recipientLines(listing.fullAddress, listing.postcode);
  const body = fillTemplate(template.body, {
    street: streetOf(listing.fullAddress),
    address: recipient.slice(1).join(', '),
    date,
    'your name': settings.senderName || branding.company || '',
    company: branding.company,
    contact: branding.contact.replace(/\n/g, ', '),
  });
  return { key, ok: true, recipient, date, body, signOff: settings.signOff, senderName: settings.senderName };
}

export async function getLetterSettings(): Promise<LetterSettings> {
  return cleanLetterSettings((await chrome.storage.local.get(LETTERS_KEY))[LETTERS_KEY]);
}

export async function saveLetterSettings(settings: LetterSettings): Promise<void> {
  await chrome.storage.local.set({ [LETTERS_KEY]: cleanLetterSettings(settings) });
}
