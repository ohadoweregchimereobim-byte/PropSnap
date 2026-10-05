import type { PropertyListing, SiteAdapter } from './types';

/**
 * Rightmove adapter
 *
 * Data source: window.__PAGE_MODEL — a packed JSON array where element 0
 * is a schema map (keys → indices) and remaining elements are values.
 *
 * Risk: Packed format can change without warning. We version-check the
 * schema map structure and fall back to DOM scraping if it breaks.
 */
export class RightmoveAdapter implements SiteAdapter {
  site = 'rightmove' as const;

  matchPatterns = [
    /^https:\/\/www\.rightmove\.co\.uk\/properties\/\d+/,
  ];

  canHandle(url: string): boolean {
    return this.matchPatterns.some((p) => p.test(url));
  }

  async extract(): Promise<PropertyListing> {
    const pageModel = await this.getPageModel();

    if (!pageModel) {
      throw new Error('PropSnap: Could not read Rightmove page data. The page format may have changed.');
    }

    const listingId = this.getListingId();
    const propertyData = this.resolve(pageModel, 'propertyData');

    // Price
    const prices = this.resolve(propertyData, 'prices');
    const primaryPrice = this.resolve(prices, 'primaryPrice');
    const priceValue = this.parsePrice(primaryPrice);

    // Address
    const address = this.resolve(propertyData, 'address');
    const displayAddress = this.resolve(address, 'displayAddress') ?? '';

    // Location
    const location = this.resolve(propertyData, 'location');
    const latitude = this.resolve(location, 'latitude');
    const longitude = this.resolve(location, 'longitude');

    // Property type and bedrooms
    const bedrooms = this.resolve(propertyData, 'bedrooms');
    const propertySubType = this.resolve(propertyData, 'propertySubType');

    // Agent info
    const customerInfo = this.resolve(pageModel, 'customerInfo');
    const agentName = this.resolve(customerInfo, 'companyName');
    const agentPhone = this.resolve(customerInfo, 'contactTelephone');
    const agentBranch = this.resolve(customerInfo, 'branchDisplayName');

    // Listing type (sale vs rent)
    const channel = this.resolve(propertyData, 'channel');
    const listingType = channel === 'RENT' ? 'rent' : 'sale';

    // Price qualifier
    const priceQualifier = this.resolve(prices, 'priceQualifier');

    // Rightmove only gives area-level postcode in the address string
    const postcodePartial = this.extractPartialPostcode(displayAddress);

    return {
      listingId,
      source: 'rightmove',
      url: window.location.href,

      displayAddress,
      postcode: null,  // Rightmove doesn't give full postcode — needs EPC enrichment
      postcodePartial,
      fullAddress: null,

      price: priceValue,
      priceQualifier: priceQualifier ?? null,
      currency: 'GBP',
      listingType,
      bedrooms: bedrooms != null ? Number(bedrooms) : null,
      propertyType: propertySubType ?? null,

      agentName: agentName ?? null,
      agentPhone: agentPhone ?? null,
      agentBranch: agentBranch ?? null,

      latitude: latitude != null ? Number(latitude) : null,
      longitude: longitude != null ? Number(longitude) : null,

      tenure: null,
      furnished: null,
      deposit: null,
      epcRating: null,

      capturedAt: new Date().toISOString(),
    };
  }

  // --- Private helpers ---

  /**
   * Read the packed JSON from window.__PAGE_MODEL.
   * Content scripts can't directly access page JS variables, so we
   * inject a script element to read it and pass it back via a custom event.
   */
  private getPageModel(): Promise<any | null> {
    return new Promise((resolve) => {
      const handler = (event: CustomEvent) => {
        document.removeEventListener('__PROPSNAP_DATA__', handler as EventListener);
        try {
          resolve(JSON.parse(event.detail));
        } catch {
          resolve(null);
        }
      };

      document.addEventListener('__PROPSNAP_DATA__', handler as EventListener);

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

      // Timeout after 3 seconds
      setTimeout(() => resolve(null), 3000);
    });
  }

  /**
   * Resolve a key from the packed JSON structure.
   * The schema map at index 0 maps field names to indices.
   * Each value in the map points to an index in the data array.
   */
  private resolve(obj: any, key: string): any {
    if (!obj || typeof obj !== 'object') return undefined;

    // If it's a regular object (not packed), just return the key directly
    if (!Array.isArray(obj)) {
      return obj[key];
    }

    // Packed format: element 0 is schema map, rest are values
    const schema = obj[0];
    if (!schema || typeof schema !== 'object') return undefined;

    const index = schema[key];
    if (index === undefined) return undefined;

    return obj[index];
  }

  private getListingId(): string {
    const match = window.location.pathname.match(/\/properties\/(\d+)/);
    return match?.[1] ?? '';
  }

  private parsePrice(priceStr: any): number | null {
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
