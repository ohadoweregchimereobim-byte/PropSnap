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

/**
 * The listing number from the web address, checked against the one in the
 * page's data. A site that moves to another listing without a full page load
 * can leave the last listing's data in the page; saving it under this address
 * would mix two homes, so the user is asked to reload instead.
 */
export function checkedListingId(fromUrl: string, fromPage: unknown): string {
  const page = fromPage == null ? '' : String(fromPage).trim();
  if (fromUrl && page && fromUrl !== page) {
    throw new Error('PropSnap: This page still holds the details of another listing. Reload the page, then click Capture again.');
  }
  return fromUrl || page;
}
