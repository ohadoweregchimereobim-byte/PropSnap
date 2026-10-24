import type { PropertyListing } from './types';

/**
 * Which addresses are listing pages, per site. Kept apart from the adapters
 * so the popup can make the same check without loading the extraction code.
 */
export const LISTING_URLS: Record<PropertyListing['source'], RegExp[]> = {
  rightmove: [
    /^https:\/\/www\.rightmove\.co\.uk\/properties\/\d+/,
  ],
  zoopla: [
    /^https:\/\/www\.zoopla\.co\.uk\/for-sale\/details\/\d+/,
    /^https:\/\/www\.zoopla\.co\.uk\/to-rent\/details\/\d+/,
  ],
  openrent: [
    /^https:\/\/www\.openrent\.(?:co\.uk|com)\/property-to-rent\/[^/]+\/[^/]+\/\d+/,
    /^https:\/\/www\.openrent\.(?:co\.uk|com)\/property-to-rent\/[^/]+\/\d+/,
  ],
};

/** The site whose listing page this is, or null */
export function listingSiteForUrl(url: string): PropertyListing['source'] | null {
  for (const [site, patterns] of Object.entries(LISTING_URLS)) {
    if (patterns.some((p) => p.test(url))) return site as PropertyListing['source'];
  }
  return null;
}
