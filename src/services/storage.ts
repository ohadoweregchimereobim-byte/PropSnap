import type { PropertyListing } from '../adapters/types';

const STORAGE_KEY = 'propsnap_listings';
const SETTINGS_KEY = 'propsnap_settings';

export interface PropSnapSettings {
  epcApiToken: string;
  autoEnrich: boolean;  // Automatically run EPC lookup on capture
}

const DEFAULT_SETTINGS: PropSnapSettings = {
  epcApiToken: '',
  autoEnrich: true,
};

/**
 * Save a captured listing to Chrome extension storage.
 */
export async function saveListing(listing: PropertyListing): Promise<void> {
  const existing = await getListings();

  // Deduplicate by listingId + source
  const key = `${listing.source}:${listing.listingId}`;
  const filtered = existing.filter(
    (l) => `${l.source}:${l.listingId}` !== key
  );

  filtered.unshift(listing); // Most recent first

  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
}

/**
 * Get all saved listings from storage.
 */
export async function getListings(): Promise<PropertyListing[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (data[STORAGE_KEY] as PropertyListing[] | undefined) ?? [];
}

/**
 * Delete a listing from storage.
 */
export async function deleteListing(source: string, listingId: string): Promise<void> {
  const existing = await getListings();
  const key = `${source}:${listingId}`;
  const filtered = existing.filter(
    (l) => `${l.source}:${l.listingId}` !== key
  );
  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
}

/**
 * Clear all saved listings.
 */
export async function clearListings(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/**
 * Get extension settings.
 */
export async function getSettings(): Promise<PropSnapSettings> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] ?? {}) };
}

/**
 * Save extension settings.
 */
export async function saveSettings(settings: Partial<PropSnapSettings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { ...current, ...settings },
  });
}

/**
 * Export listings as CSV string.
 */
export function listingsToCsv(listings: PropertyListing[]): string {
  if (listings.length === 0) return '';

  const headers = [
    'Source',
    'Listing ID',
    'URL',
    'Display Address',
    'Full Address',
    'Address Confidence',
    'Match Detail',
    'Postcode',
    'Price',
    'Price Qualifier',
    'Listing Type',
    'Bedrooms',
    'Property Type',
    'Floor Area (sqm)',
    'Tenure',
    'Furnished',
    'Deposit',
    'Agent/Landlord',
    'Agent Branch',
    'Phone',
    'EPC Rating',
    'Latitude',
    'Longitude',
    'Captured At',
  ];

  const rows = listings.map((l) => [
    l.source,
    l.listingId,
    l.url,
    l.displayAddress,
    l.fullAddress ?? '',
    l.addressConfidence ?? '',
    l.enrichmentDetail ?? '',
    l.postcode ?? l.postcodePartial ?? '',
    l.price?.toString() ?? '',
    l.priceQualifier ?? '',
    l.listingType,
    l.bedrooms?.toString() ?? '',
    l.propertyType ?? '',
    l.floorAreaSqm?.toString() ?? '',
    l.tenure ?? '',
    l.furnished ?? '',
    l.deposit?.toString() ?? '',
    l.agentName ?? '',
    l.agentBranch ?? '',
    l.agentPhone ?? '',
    l.epcRating ?? '',
    l.latitude?.toString() ?? '',
    l.longitude?.toString() ?? '',
    l.capturedAt,
  ]);

  const escape = (raw: string) => {
    // Listing text comes from other websites. Excel runs a cell that starts
    // with = + - or @ as a formula, so make such text plain. Numbers like a
    // negative longitude stay as they are.
    const val = /^[=+\-@\t\r]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw;
    if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  return [
    headers.join(','),
    ...rows.map((row) => row.map(escape).join(',')),
  ].join('\n');
}
