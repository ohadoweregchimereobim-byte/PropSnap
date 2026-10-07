import type { PropertyListing, SiteAdapter } from './types';

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

  matchPatterns = [
    /^https:\/\/www\.zoopla\.co\.uk\/for-sale\/details\/\d+/,
    /^https:\/\/www\.zoopla\.co\.uk\/to-rent\/details\/\d+/,
  ];

  canHandle(url: string): boolean {
    return this.matchPatterns.some((p) => p.test(url));
  }

  async extract(): Promise<PropertyListing> {
    const jsonLd = this.extractJsonLd();
    const analytics = this.extractAnalytics();

    const listingId = analytics.listing_id ?? this.getListingIdFromUrl();
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
      priceQualifier: analytics.price_qualifier ?? null,
      currency: 'GBP',
      listingType: isRent ? 'rent' : 'sale',
      bedrooms: analytics.num_beds != null ? Number(analytics.num_beds) : null,
      propertyType: analytics.property_type ?? null,

      agentName,
      agentPhone,
      agentBranch: analytics.branch_name ?? null,

      latitude,
      longitude,

      tenure: analytics.tenure ?? null,
      furnished: analytics.furnishing ?? null,
      deposit: null,
      epcRating: null,

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
      const text = script.textContent ?? '';

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
        furnishing: /["']furnishing["']\s*:\s*["']([^"']+)["']/,
        latitude: /["']latitude["']\s*:\s*["']?([\d.-]+)["']?/,
        longitude: /["']longitude["']\s*:\s*["']?([\d.-]+)["']?/,
        has_epc: /["']has_epc["']\s*:\s*["']?(true|false)["']?/,
        has_floorplan: /["']has_floorplan["']\s*:\s*["']?(true|false)["']?/,
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
      const text = script.textContent ?? '';
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
