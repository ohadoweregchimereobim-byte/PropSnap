import type { PropertyListing } from '../adapters/types';

/**
 * Small display helpers shared by the popup, the pages and the report, so
 * prices and site names look the same everywhere.
 */

// One formatter for the whole page; making one per number is slow
// signDisplay 'negative': a value that rounds to nothing shows "£0", not "-£0"
const MONEY = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0, signDisplay: 'negative' });

/** 295000 → "£295,000" */
export function formatMoney(value: number): string {
  return MONEY.format(value);
}

export const SITE_NAMES: Record<PropertyListing['source'], string> = {
  rightmove: 'Rightmove',
  zoopla: 'Zoopla',
  openrent: 'OpenRent',
};
