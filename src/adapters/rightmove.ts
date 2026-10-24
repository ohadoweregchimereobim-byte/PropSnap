import type { PropertyListing, SiteAdapter } from './types';
import { rightmoveAddedDate, rightmovePriceChanges } from './listing-dates';
import { LISTING_URLS } from './listing-urls';
import { findEpcBandInText } from './epc-band';
import { findFloorAreaInText } from './floor-area-text';
import { findUnitNumberInText } from './unit-number';

/**
 * Rightmove adapter
 *
 * Data source: window.__PAGE_MODEL = { data: "<json string>", encoding: "on" }
 *
 * `data` is a JSON string holding a flat array in a devalue-style packed
 * format: every object value and array element is an index into that same
 * array, and element 0 is the root object. unpackPageModel() rebuilds the
 * normal nested structure so the rest of the adapter can use plain property
 * access (propertyData.prices.primaryPrice etc.).
 *
 * Risk: the packed format can change without warning. unpackPageModel()
 * returns null when the structure is not what we expect, and extract()
 * then throws a clear error instead of returning wrong data.
 */
export class RightmoveAdapter implements SiteAdapter {
  site = 'rightmove' as const;

  matchPatterns = LISTING_URLS.rightmove;

  canHandle(url: string): boolean {
    return this.matchPatterns.some((p) => p.test(url));
  }

  async extract(): Promise<PropertyListing> {
    const rawModel = this.readModelFromScripts() ?? (await this.readModelFromPage());
    const root = rawModel ? unpackPageModel(rawModel) : null;
    const propertyData = root?.propertyData;

    if (!propertyData) {
      throw new Error('PropSnap: Could not read Rightmove page data. The page format may have changed.');
    }

    const prices = propertyData.prices ?? {};
    const address = propertyData.address ?? {};
    const location = propertyData.location ?? {};
    const customer = propertyData.customer ?? {};

    const displayAddress: string = address.displayAddress ?? '';

    // UK listings carry outcode/incode; overseas listings leave them null.
    const outcode: string | null = address.outcode || null;
    const incode: string | null = address.incode || null;

    const keyFeatures: string[] = Array.isArray(propertyData.keyFeatures) ? propertyData.keyFeatures : [];
    const listingText = [propertyData.text?.pageTitle, ...keyFeatures, propertyData.text?.description];

    const latitude = location.latitude;
    const longitude = location.longitude;
    const now = new Date();

    return {
      listingId: String(propertyData.id ?? this.getListingId()),
      source: 'rightmove',
      url: window.location.href,

      displayAddress,
      postcode: outcode && incode ? `${outcode} ${incode}` : null,
      postcodePartial: outcode ?? this.extractPartialPostcode(displayAddress),
      fullAddress: null,

      price: this.parsePrice(prices.primaryPrice),
      priceQualifier: prices.displayPriceQualifier || null,
      currency: 'GBP',
      listingType: propertyData.transactionType === 'RENT' ? 'rent' : 'sale',
      bedrooms: propertyData.bedrooms != null ? Number(propertyData.bedrooms) : null,
      propertyType: propertyData.propertySubType ?? null,
      floorAreaSqm: floorAreaFromSizings(propertyData.sizings),
      floorAreaFromText: findFloorAreaInText(listingText),
      numberFromText: findUnitNumberInText(listingText, displayAddress),

      agentName: customer.companyName ?? null,
      agentPhone: propertyData.contactInfo?.telephoneNumbers?.localNumber ?? null,
      agentBranch: customer.branchDisplayName ?? null,

      latitude: latitude != null ? Number(latitude) : null,
      longitude: longitude != null ? Number(longitude) : null,

      tenure: propertyData.tenure?.tenureType ?? null,
      furnished: null,
      deposit: null,
      // Rightmove has no rating field; agents often write it in key features or the description
      epcRating: findEpcBandInText([...keyFeatures, propertyData.text?.description]),

      // Rightmove's own dates: first added, and the latest reduction ("Reduced on 12/10/2026")
      listedOn: rightmoveAddedDate(root?.analyticsInfo?.analyticsProperty?.added),
      portalPriceChanges: rightmovePriceChanges(propertyData.listingHistory?.listingUpdateReason, now),

      capturedAt: now.toISOString(),
    };
  }

  // --- Private helpers ---

  /**
   * Read __PAGE_MODEL straight from the inline <script> that assigns it.
   * Content scripts live in an isolated world and cannot see page globals,
   * but they can read script text, and this avoids injecting inline code
   * that a page CSP could block.
   */
  private readModelFromScripts(): unknown | null {
    const marker = 'window.__PAGE_MODEL = ';

    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent ?? '';
      const at = text.indexOf(marker);
      if (at === -1) continue;

      const json = sliceJsonObject(text, at + marker.length);
      if (!json) continue;

      try {
        return JSON.parse(json);
      } catch {
        // Try the next script
      }
    }

    return null;
  }

  /**
   * Fallback: inject a script into the page world to read window.__PAGE_MODEL
   * and hand it back through a custom event.
   */
  private readModelFromPage(): Promise<unknown | null> {
    return new Promise((resolve) => {
      // Whichever comes first, the answer or the timeout, tidies up after itself
      const finish = (value: unknown | null) => {
        clearTimeout(timer);
        document.removeEventListener('__PROPSNAP_DATA__', handler);
        resolve(value);
      };
      const handler = (event: Event) => {
        try {
          finish(JSON.parse((event as CustomEvent).detail));
        } catch {
          finish(null);
        }
      };
      // A page whose rules block the script never answers
      const timer = setTimeout(() => finish(null), 3000);

      document.addEventListener('__PROPSNAP_DATA__', handler);

      const script = document.createElement('script');
      script.textContent = `
        (function() {
          try {
            const data = window.__PAGE_MODEL || window.PAGE_MODEL;
            document.dispatchEvent(new CustomEvent('__PROPSNAP_DATA__', {
              detail: JSON.stringify(data)
            }));
          } catch(e) {
            document.dispatchEvent(new CustomEvent('__PROPSNAP_DATA__', {
              detail: 'null'
            }));
          }
        })();
      `;
      document.documentElement.appendChild(script);
      script.remove();
    });
  }

  private getListingId(): string {
    const match = window.location.pathname.match(/\/properties\/(\d+)/);
    return match?.[1] ?? '';
  }

  private parsePrice(priceStr: unknown): number | null {
    if (priceStr == null) return null;
    const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  private extractPartialPostcode(address: string): string | null {
    // Try to find a UK outcode pattern (e.g. "SW1", "IG8", "EC2A")
    const match = address.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\b/i);
    return match?.[1]?.toUpperCase() ?? null;
  }
}

/**
 * Rightmove gives sizes as [{ unit: "sqft", minimumSize, maximumSize }, { unit: "sqm", ... }].
 * Prefer square metres (what EPC certificates use), else convert square feet.
 */
export function floorAreaFromSizings(sizings: unknown): number | null {
  if (!Array.isArray(sizings)) return null;

  const sizeOf = (unit: string) => {
    const entry = sizings.find((s: any) => String(s?.unit ?? '').toLowerCase() === unit);
    const size = Number(entry?.maximumSize ?? entry?.minimumSize);
    return Number.isFinite(size) && size > 0 ? size : null;
  };

  const sqm = sizeOf('sqm');
  if (sqm) return Math.round(sqm);
  const sqft = sizeOf('sqft');
  return sqft ? Math.round(sqft * 0.092903) : null;
}

/**
 * Rebuild the nested structure from Rightmove's packed page model.
 *
 * Input is the value of window.__PAGE_MODEL ({ data: "<json>" }) or the
 * already-parsed array. Returns the root object, or null if the input is
 * not in the expected packed shape.
 */
export function unpackPageModel(model: unknown): any | null {
  let packed: unknown = model;

  if (packed && !Array.isArray(packed) && typeof packed === 'object' && 'data' in packed) {
    packed = (packed as { data: unknown }).data;
  }

  if (typeof packed === 'string') {
    try {
      packed = JSON.parse(packed);
    } catch {
      return null;
    }
  }

  if (!Array.isArray(packed) || packed.length === 0) return null;

  const cache = new Map<number, unknown>();

  const resolve = (index: number): unknown => {
    if (!Number.isInteger(index) || index < 0 || index >= packed.length) return undefined;
    if (cache.has(index)) return cache.get(index);

    const value = packed[index];

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      cache.set(index, out); // set first so cyclic references terminate
      for (const item of value) out.push(resolve(item));
      return out;
    }

    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      cache.set(index, out);
      for (const [key, ref] of Object.entries(value)) out[key] = resolve(ref as number);
      return out;
    }

    cache.set(index, value);
    return value;
  };

  const root = resolve(0);
  return root && typeof root === 'object' ? root : null;
}

/**
 * Return the JSON object literal that starts at `start` in `text`,
 * respecting strings and escapes so braces inside values are ignored.
 */
function sliceJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;

  let depth = 0;
  let inString = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }

  return null;
}
