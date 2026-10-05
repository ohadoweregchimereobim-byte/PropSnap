export { RightmoveAdapter } from './rightmove';
export { ZooplaAdapter } from './zoopla';
export { OpenRentAdapter } from './openrent';
export type { PropertyListing, SiteAdapter, EpcResult } from './types';

import { RightmoveAdapter } from './rightmove';
import { ZooplaAdapter } from './zoopla';
import { OpenRentAdapter } from './openrent';
import type { SiteAdapter } from './types';

/**
 * Get the right adapter for the current page URL.
 * Returns null if no adapter matches (user isn't on a supported listing page).
 */
export function getAdapterForUrl(url: string): SiteAdapter | null {
  const adapters: SiteAdapter[] = [
    new RightmoveAdapter(),
    new ZooplaAdapter(),
    new OpenRentAdapter(),
  ];

  return adapters.find((a) => a.canHandle(url)) ?? null;
}
