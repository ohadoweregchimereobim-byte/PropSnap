import type { PropertyListing } from '../adapters/types';

/**
 * Small display helpers shared by the popup, the pages and the report, so
 * prices and site names look the same everywhere.
 */

// One formatter for the whole page; making one per number is slow
const MONEY = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });

/** 295000 → "£295,000" */
export function formatMoney(value: number): string {
  return MONEY.format(Math.round(value));
}

export const SITE_NAMES: Record<PropertyListing['source'], string> = {
  rightmove: 'Rightmove',
  zoopla: 'Zoopla',
  openrent: 'OpenRent',
};
