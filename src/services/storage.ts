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
  const data = await chrome.storage.local.get<Record<string, PropertyListing[]>>(STORAGE_KEY);
  return data[STORAGE_KEY] ?? [];
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
  const data = await chrome.storage.local.get<Record<string, Partial<PropSnapSettings>>>(SETTINGS_KEY);
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
    'Postcode',
    'Price',
    'Listing Type',
    'Bedrooms',
    'Property Type',
    'Agent/Landlord',
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
    l.postcode ?? l.postcodePartial ?? '',
    l.price?.toString() ?? '',
    l.listingType,
    l.bedrooms?.toString() ?? '',
    l.propertyType ?? '',
    l.agentName ?? '',
    l.agentPhone ?? '',
    l.epcRating ?? '',
    l.latitude?.toString() ?? '',
    l.longitude?.toString() ?? '',
    l.capturedAt,
  ]);

  const escape = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  return [
    headers.join(','),
    ...rows.map((row) => row.map(escape).join(',')),
  ].join('\n');
}
