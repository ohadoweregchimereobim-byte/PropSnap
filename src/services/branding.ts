/**
 * The user's own branding for the property report: company name, contact
 * line, colour and logo. Saved once for every report; the checks are pure,
 * so they are unit tested.
 */

export const BRANDING_KEY = 'propsnap_branding';

export interface Branding {
  company: string;
  /** Phone, email, website: shown under the company name, line breaks kept */
  contact: string;
  /** #rrggbb */
  colour: string;
  /** A PNG, JPEG, WebP or GIF as a data URL; null for none */
  logo: string | null;
}

export const DEFAULT_COLOUR = '#1d4ed8';
export const COMPANY_MAX = 80;
export const CONTACT_MAX = 300;
/** About 300 KB of image once base64 is undone */
export const LOGO_MAX_CHARS = 400_000;

const LOGO = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const COLOUR = /^#[0-9a-f]{6}$/i;

export const NO_BRANDING: Branding = { company: '', contact: '', colour: DEFAULT_COLOUR, logo: null };

/** Saved branding, checked. SVG is not allowed as a logo: it can carry script */
export function cleanBranding(saved: unknown): Branding {
  if (!saved || typeof saved !== 'object') return { ...NO_BRANDING };
  const b = saved as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
  return {
    company: text(b.company, COMPANY_MAX).replace(/\s+/g, ' '),
    contact: text(b.contact, CONTACT_MAX),
    colour: typeof b.colour === 'string' && COLOUR.test(b.colour) ? b.colour.toLowerCase() : DEFAULT_COLOUR,
    logo: typeof b.logo === 'string' && b.logo.length <= LOGO_MAX_CHARS && LOGO.test(b.logo) ? b.logo : null,
  };
}

/** True when there is something to put on the report */
export const isBranded = (b: Branding) => !!(b.company || b.contact || b.logo);

/** Why a logo file can't be used, or null when it can */
export function logoProblem(file: { type: string; size: number }): string | null {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return 'Use a PNG, JPEG, WebP or GIF image';
  // Base64 makes the file a third bigger
  if (Math.ceil(file.size / 3) * 4 + 30 > LOGO_MAX_CHARS) return 'Use an image under 290 KB';
  return null;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * The brand colour for headings on white paper: the colour itself when it is
 * dark enough to read (contrast 4.5 or more), else dark grey.
 */
export function headingColour(colour: string): string {
  if (!COLOUR.test(colour)) return '#0f172a';
  const contrast = 1.05 / (luminance(colour) + 0.05);
  return contrast >= 4.5 ? colour.toLowerCase() : '#0f172a';
}

export async function getBranding(): Promise<Branding> {
  const result = await chrome.storage.local.get(BRANDING_KEY);
  return cleanBranding(result[BRANDING_KEY]);
}

/** Saves the whole branding; with nothing in it the key is removed */
export async function saveBranding(branding: Branding): Promise<void> {
  const clean = cleanBranding(branding);
  if (!isBranded(clean) && clean.colour === DEFAULT_COLOUR) await chrome.storage.local.remove(BRANDING_KEY);
  else await chrome.storage.local.set({ [BRANDING_KEY]: clean });
}
