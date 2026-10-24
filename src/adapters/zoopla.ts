import type { PropertyListing, SiteAdapter } from './types';
import { zooplaListedOn, zooplaPriceChanges } from './listing-dates';
import { checkedListingId, LISTING_URLS } from './listing-urls';
import { epcBand } from './epc-band';
import { findFloorAreaInText } from './floor-area-text';
import { findUnitNumberInText } from './unit-number';

/**
 * Zoopla adapter
 *
 * Data sources:
 * 1. JSON-LD (application/ld+json) with schema.org/RealEstateListing
 * 2. Analytics tracking data embedded in page markup
 *
 * Risk: Lowest of the three sites. JSON-LD is a web standard and
 * unlikely to change format. Analytics block is a secondary source.
 */
export class ZooplaAdapter implements SiteAdapter {
  site = 'zoopla' as const;

  matchPatterns = LISTING_URLS.zoopla;

  canHandle(url: string): boolean {
    return this.matchPatterns.some((p) => p.test(url));
  }

  async extract(): Promise<PropertyListing> {
    const jsonLd = this.extractJsonLd();
    const analytics = this.extractAnalytics();

    const listingId = checkedListingId(this.getListingIdFromUrl(), analytics.listing_id);
    const url = window.location.href;
    const isRent = url.includes('/to-rent/');

    // Address — analytics has the cleaner display_address
    const displayAddress = analytics.display_address ?? jsonLd?.name ?? '';

    // Full postcode from outcode + incode
    const outcode = analytics.outcode ?? '';
    const incode = analytics.incode ?? '';
    const fullPostcode = outcode && incode ? `${outcode} ${incode}` : null;

    // Price from JSON-LD (more reliable)
    const price = jsonLd?.offers?.price != null
      ? Number(jsonLd.offers.price)
      : this.parsePrice(analytics.price);

    // Agent info
    const agentName = analytics.branch_name ?? null;
    const agentPhone = this.extractAgentPhone();

    // Coordinates
    const latitude = analytics.latitude != null ? Number(analytics.latitude) : null;
    const longitude = analytics.longitude != null ? Number(analytics.longitude) : null;

    return {
      listingId,
      source: 'zoopla',
      url,

      displayAddress,
      postcode: fullPostcode,
      postcodePartial: outcode || null,
      fullAddress: null,

      price,
      priceQualifier: zooplaLabel(analytics.price_qualifier),
      currency: 'GBP',
      listingType: isRent ? 'rent' : 'sale',
      bedrooms: analytics.num_beds != null ? Number(analytics.num_beds) : null,
      propertyType: zooplaLabel(analytics.property_type),
      floorAreaSqm: floorAreaFromJsonLd(jsonLd) ?? floorAreaFromPageData(analytics.floor_area, analytics.size_sq_feet),
      floorAreaFromText: findFloorAreaInText([jsonLd?.description, this.metaDescription()]),
      numberFromText: findUnitNumberInText([jsonLd?.name, jsonLd?.description, this.metaDescription()], displayAddress),

      agentName,
      agentPhone,
      agentBranch: analytics.branch_name ?? null,

      latitude,
      longitude,

      tenure: zooplaLabel(analytics.tenure),
      furnished: zooplaLabel(analytics.furnishing),
      deposit: null,
      epcRating: epcBand(analytics.epc_rating),

      listedOn: zooplaListedOn(analytics.published_on),
      portalPriceChanges: zooplaPriceChanges(analytics.price_changes),

      capturedAt: new Date().toISOString(),
    };
  }

  // --- Private helpers ---

  /**
   * Parse JSON-LD from <script type="application/ld+json"> tags.
   * We look for the one with @type: "RealEstateListing".
   */
  private extractJsonLd(): any | null {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');

    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent ?? '');

        // Could be a single object or an array
        if (Array.isArray(data)) {
          const listing = data.find((item: any) => item['@type'] === 'RealEstateListing');
          if (listing) return listing;
        } else if (data['@type'] === 'RealEstateListing') {
          return data;
        }
      } catch {
        // Skip malformed JSON-LD blocks
      }
    }

    return null;
  }

  /**
   * Extract analytics tracking data from page markup.
   * Zoopla embeds tracking variables in script tags — we look for
   * common patterns like `branch_name`, `listing_id`, etc.
   */
  private extractAnalytics(): Record<string, string> {
    const result: Record<string, string> = {};
    const scripts = document.querySelectorAll('script');

    for (const script of scripts) {
      // Next.js flight data is a JS string, so its JSON arrives with escaped quotes
      const text = (script.textContent ?? '').replace(/\\"/g, '"');

      // Look for tracking data patterns
      const patterns: Record<string, RegExp> = {
        listing_id: /["']listing_id["']\s*:\s*["']?(\d+)["']?/,
        display_address: /["']display_address["']\s*:\s*["']([^"']+)["']/,
        outcode: /["']outcode["']\s*:\s*["']([A-Z]{1,2}\d[A-Z\d]?)["']/i,
        incode: /["']incode["']\s*:\s*["'](\d[A-Z]{2})["']/i,
        price: /["']price["']\s*:\s*["']?(\d+)["']?/,
        price_qualifier: /["']price_qualifier["']\s*:\s*["']([^"']+)["']/,
        num_beds: /["']num_beds["']\s*:\s*["']?(\d+)["']?/,
        property_type: /["']property_type["']\s*:\s*["']([^"']+)["']/,
        branch_name: /["']branch_name["']\s*:\s*["']([^"']+)["']/,
        branch_id: /["']branch_id["']\s*:\s*["']?(\d+)["']?/,
        tenure: /["']tenure["']\s*:\s*["']([^"']+)["']/,
        epc_rating: /["'](?:epcRating|epc_rating)["']\s*:\s*["']([A-Ga-g])["']/,
        furnishing: /["']furnishing["']\s*:\s*["']([^"']+)["']/,
        latitude: /["']latitude["']\s*:\s*["']?([\d.-]+)["']?/,
        longitude: /["']longitude["']\s*:\s*["']?([\d.-]+)["']?/,
        has_epc: /["']has_epc["']\s*:\s*["']?(true|false)["']?/,
        has_floorplan: /["']has_floorplan["']\s*:\s*["']?(true|false)["']?/,
        // The size the page shows ("624 sq. ft"). Not ingested.sizeSqft: that is
        // Zoopla's estimate from neighbouring homes, not this home's own size.
        floor_area: /["']floorArea["']\s*:\s*(\{[^{}]*\})/,
        size_sq_feet: /["']sizeSqFeet["']\s*:\s*["']?(\d[\d,.]*)/,
        // Zoopla's own dates: first published, and each price change (date and drop or rise, no amount)
        published_on: /["']publishedOn["']\s*:\s*["'](\d{4}-\d{2}-\d{2}[^"']*)["']/,
        price_changes: /["']priceChanges["']\s*:\s*(\[[^\]]*\])/,
      };

      for (const [key, regex] of Object.entries(patterns)) {
        if (!result[key]) {
          const match = text.match(regex);
          if (match?.[1]) {
            result[key] = match[1];
          }
        }
      }
    }

    return result;
  }

  /**
   * Extract agent phone number.
   * Zoopla stores this in a `redirectPhone` field in the page data.
   */
  private extractAgentPhone(): string | null {
    const scripts = document.querySelectorAll('script');

    for (const script of scripts) {
      const text = (script.textContent ?? '').replace(/\\"/g, '"');
      const match = text.match(/["']redirectPhone["']\s*:\s*["']([^"']+)["']/);
      if (match?.[1]) return match[1];
    }

    // Fallback: look for a tel: link near agent info
    const telLink = document.querySelector('a[href^="tel:"]');
    if (telLink) {
      return telLink.getAttribute('href')?.replace('tel:', '') ?? null;
    }

    return null;
  }

  private metaDescription(): string | null {
    return document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null;
  }

  private getListingIdFromUrl(): string {
    const match = window.location.pathname.match(/\/details\/(\d+)/);
    return match?.[1] ?? '';
  }

  private parsePrice(priceStr: string | undefined): number | null {
    if (!priceStr) return null;
    const num = parseFloat(priceStr.replace(/[^0-9.]/g, ''));
    return isNaN(num) ? null : num;
  }
}

/**
 * schema.org floorSize, found anywhere in the listing's JSON-LD:
 * { "@type": "QuantitativeValue", "value": 1050, "unitCode": "FTK" }.
 * FTK/sq ft is converted to square metres; MTK/sq m is used as is.
 */
export function floorAreaFromJsonLd(jsonLd: unknown): number | null {
  const find = (value: any, depth: number): any => {
    if (!value || typeof value !== 'object' || depth > 4) return null;
    if (value.floorSize) return value.floorSize;
    for (const child of Object.values(value)) {
      const hit = find(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  const floorSize = find(jsonLd, 0);
  if (!floorSize) return null;

  const size = parseFloat(String(floorSize.value ?? floorSize).replace(/,/g, ''));
  if (!Number.isFinite(size) || size <= 0) return null;

  const unit = String(floorSize.unitCode ?? floorSize.unitText ?? '').toLowerCase();
  // No unit given: homes over 250 are almost certainly in square feet
  const isFeet = /ftk|ft|feet/.test(unit) || (!unit && size > 250);
  return Math.round(isFeet ? size * 0.092903 : size);
}

/**
 * Floor area from Zoopla's page data, for listings whose JSON-LD has no floorSize.
 * `floorArea` is an object such as { "value": 624, "unitsLabel": "sq. ft" };
 * `sizeSqFeet` is the analytics copy in square feet. Returns square metres.
 */
export function floorAreaFromPageData(floorAreaJson?: string | null, sizeSqFeet?: string | null): number | null {
  if (floorAreaJson) {
    try {
      const area = JSON.parse(floorAreaJson);
      const size = Number(area.value ?? area.size ?? area.minimum ?? area.maximum);
      if (Number.isFinite(size) && size > 0) {
        const unit = String(area.unitsLabel ?? area.units ?? area.unit ?? area.unitCode ?? '').toLowerCase();
        const isFeet = /ft|feet|sqft|ftk/.test(unit) || (!/m/.test(unit) && size > 250);
        return Math.round(isFeet ? size * 0.092903 : size);
      }
    } catch {
      // Fall through to sizeSqFeet
    }
  }

  const feet = parseFloat(String(sizeSqFeet ?? '').replace(/,/g, ''));
  return Number.isFinite(feet) && feet > 0 ? Math.round(feet * 0.092903) : null;
}

/**
 * Zoopla's page data uses codes: "offers_over", "share_of_freehold",
 * "semi_detached_house", "flat". Shown as words: "Offers over",
 * "Share of freehold", "Semi-detached house", "Flat". Text that is already
 * words keeps its spelling, with a capital first letter.
 */
export function zooplaLabel(code: string | null | undefined): string | null {
  const text = (code ?? '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (/^poa$/i.test(text)) return 'POA';
  const words = text.replace(/\bsemi detached\b/i, 'semi-detached');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
