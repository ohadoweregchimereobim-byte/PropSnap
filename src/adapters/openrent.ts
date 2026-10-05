import type { PropertyListing, SiteAdapter } from './types';

/**
 * OpenRent adapter
 *
 * Data source: Server-rendered HTML. No JSON-LD, no __NEXT_DATA__,
 * no packed JSON. Data lives directly in HTML tables and semantic elements.
 *
 * Risk: DOM structure can change with redesigns. We use resilient selectors
 * and fall back gracefully when elements are missing.
 *
 * Note: OpenRent is a private landlord platform — we get the landlord's
 * first name + initial, NOT a phone number. Phone is verified but hidden.
 */
export class OpenRentAdapter implements SiteAdapter {
  site = 'openrent' as const;

  matchPatterns = [
    /^https:\/\/www\.openrent\.com\/property-to-rent\/[^/]+\/\d+/,
  ];

  canHandle(url: string): boolean {
    return this.matchPatterns.some((p) => p.test(url));
  }

  async extract(): Promise<PropertyListing> {
    const listingId = this.getListingId();
    const url = window.location.href;

    // Page title gives us bedrooms + property type + address
    // e.g. "1 Bed Flat, Rochester Row, SW1P"
    const pageTitle = document.title;
    const titleParts = this.parseTitle(pageTitle);

    // Full postcode from broadband comparison link
    const fullPostcode = this.extractPostcodeFromBroadbandLink();

    // Table data (rent, deposit, furnished, EPC, available from)
    const tableData = this.extractTableData();

    // Landlord info from profile section
    const landlord = this.extractLandlordInfo();

    // Coordinates from map element attributes
    const coords = this.extractCoordinates();

    // Rent price
    const rentPcm = this.parsePrice(tableData['Rent PCM'] ?? tableData['Rent']);

    return {
      listingId,
      source: 'openrent',
      url,

      displayAddress: titleParts.address,
      postcode: fullPostcode,
      postcodePartial: titleParts.postcodeArea,
      fullAddress: null,

      price: rentPcm,
      priceQualifier: 'pcm',
      currency: 'GBP',
      listingType: 'rent',
      bedrooms: titleParts.bedrooms,
      propertyType: titleParts.propertyType,

      // OpenRent shows landlord name, not agent
      agentName: landlord.name,
      agentPhone: null,  // Phone verified but NOT displayed
      agentBranch: null,

      latitude: coords.lat,
      longitude: coords.lng,

      tenure: null,
      furnished: tableData['Furnishing'] ?? tableData['Furnished'] ?? null,
      deposit: this.parsePrice(tableData['Deposit']),
      epcRating: tableData['EPC Rating'] ?? tableData['EPC'] ?? null,

      capturedAt: new Date().toISOString(),
    };
  }

  // --- Private helpers ---

  /**
   * Parse the page title to extract bedrooms, property type, and address.
   * Format: "1 Bed Flat, Rochester Row, SW1P"
   */
  private parseTitle(title: string): {
    bedrooms: number | null;
    propertyType: string | null;
    address: string;
    postcodeArea: string | null;
  } {
    // Remove site name suffix
    const cleaned = title.replace(/\s*[-|].*OpenRent.*$/i, '').trim();

    const bedroomMatch = cleaned.match(/^(\d+)\s*Bed/i);
    const bedrooms = bedroomMatch ? parseInt(bedroomMatch[1], 10) : null;

    // Property type comes after "Bed " — e.g. "1 Bed Flat, ..."
    const typeMatch = cleaned.match(/\d+\s*Bed\s+(\w+)/i);
    const propertyType = typeMatch?.[1] ?? null;

    // Address is everything after the first comma, or the whole thing
    const commaIndex = cleaned.indexOf(',');
    const address = commaIndex > -1 ? cleaned.substring(commaIndex + 1).trim() : cleaned;

    // Partial postcode — look for outcode at end of address
    const postcodeMatch = address.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\b\s*$/i);
    const postcodeArea = postcodeMatch?.[1]?.toUpperCase() ?? null;

    return { bedrooms, propertyType, address, postcodeArea };
  }

  /**
   * Extract full postcode from broadband comparison link.
   * OpenRent leaks it via: href="/comparebroadband?postCode=SW1P%201LQ"
   */
  private extractPostcodeFromBroadbandLink(): string | null {
    const link = document.querySelector('a[href*="comparebroadband"]') as HTMLAnchorElement | null;
    if (!link) return null;

    try {
      const url = new URL(link.href, window.location.origin);
      const postCode = url.searchParams.get('postCode');
      return postCode ? decodeURIComponent(postCode).trim() : null;
    } catch {
      // Fallback: regex the href
      const match = link.href.match(/postCode=([^&]+)/);
      return match ? decodeURIComponent(match[1]).trim() : null;
    }
  }

  /**
   * Extract key-value data from HTML tables.
   * OpenRent puts property details in <table> rows with two cells each.
   */
  private extractTableData(): Record<string, string> {
    const data: Record<string, string> = {};

    const rows = document.querySelectorAll('table tr, .property-info tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const key = (cells[0].textContent ?? '').trim();
        const value = (cells[1].textContent ?? '').trim();
        if (key && value) {
          data[key] = value;
        }
      }
    }

    // Also try definition-list style markup
    const dts = document.querySelectorAll('dt');
    for (const dt of dts) {
      const dd = dt.nextElementSibling;
      if (dd?.tagName === 'DD') {
        const key = (dt.textContent ?? '').trim();
        const value = (dd.textContent ?? '').trim();
        if (key && value) {
          data[key] = value;
        }
      }
    }

    return data;
  }

  /**
   * Extract landlord info from profile section.
   * Name is in a <p> tag near the profile image.
   * Landlord ID is in a link: href="/search/searchbylandlord?landlordID=9206477"
   */
  private extractLandlordInfo(): { name: string | null; landlordId: string | null } {
    let name: string | null = null;
    let landlordId: string | null = null;

    // Try to find landlord name — usually in a prominent text element near profile
    const profileSection = document.querySelector('[class*="landlord"], [class*="profile"], [id*="landlord"]');
    if (profileSection) {
      const nameEl = profileSection.querySelector('p, h3, h4, .fw-medium');
      if (nameEl) {
        name = (nameEl.textContent ?? '').trim() || null;
      }
    }

    // Fallback: look for any text element with a short name pattern near a profile image
    if (!name) {
      const candidates = document.querySelectorAll('p.mb-0, p.fw-medium, .text-center.fw-medium');
      for (const el of candidates) {
        const text = (el.textContent ?? '').trim();
        // Landlord names are typically "Firstname L." pattern
        if (text && text.length < 30 && /^[A-Z][a-z]+\s[A-Z]\.?$/.test(text)) {
          name = text;
          break;
        }
      }
    }

    // Landlord ID from link
    const landlordLink = document.querySelector('a[href*="landlordID="]');
    if (landlordLink) {
      const match = landlordLink.getAttribute('href')?.match(/landlordID=(\d+)/);
      landlordId = match?.[1] ?? null;
    }

    return { name, landlordId };
  }

  /**
   * Extract coordinates from map element attributes.
   * OpenRent puts lat/lng as data attributes on map containers.
   */
  private extractCoordinates(): { lat: number | null; lng: number | null } {
    // Look for data attributes on map elements
    const mapEl = document.querySelector('[lat][lng], [data-lat][data-lng], [data-latitude][data-longitude]');

    if (mapEl) {
      const lat = mapEl.getAttribute('lat') ?? mapEl.getAttribute('data-lat') ?? mapEl.getAttribute('data-latitude');
      const lng = mapEl.getAttribute('lng') ?? mapEl.getAttribute('data-lng') ?? mapEl.getAttribute('data-longitude');

      return {
        lat: lat ? parseFloat(lat) : null,
        lng: lng ? parseFloat(lng) : null,
      };
    }

    // Fallback: search all elements for lat/lng attributes
    const allWithLat = document.querySelector('[lat]');
    const allWithLng = document.querySelector('[lng]');

    return {
      lat: allWithLat ? parseFloat(allWithLat.getAttribute('lat') ?? '') : null,
      lng: allWithLng ? parseFloat(allWithLng.getAttribute('lng') ?? '') : null,
    };
  }

  private getListingId(): string {
    const match = window.location.pathname.match(/\/(\d+)(?:\/?$)/);
    return match?.[1] ?? '';
  }

  private parsePrice(priceStr: string | undefined | null): number | null {
    if (!priceStr) return null;
    const cleaned = priceStr.replace(/[^0-9.]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }
}
