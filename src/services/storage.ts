import type { PropertyListing } from '../adapters/types';
import type { EpcEnergy } from './epc-energy';
import { chooseCandidate, keepUserChoice } from './address-choice';
import { clearUserData, listingKey, removeUserData, type UserDataMap } from './user-data';
import { cleanPipeline, statusLabel } from './pipeline';
import { cleanActivity, cleanLabels, lastCall, outcomeLabel } from './crm';
import { priceChange, withPriceHistory } from './price-history';
import { withLock } from './storage-lock';

export const LISTINGS_KEY = 'propsnap_listings';
export const SETTINGS_KEY = 'propsnap_settings';

export interface PropSnapSettings {
  epcApiToken: string;
  autoEnrich: boolean;  // Automatically run EPC lookup on capture
  floorAreaFromText: boolean;  // Use a floor area read from the description when the site gives none
}

const DEFAULT_SETTINGS: PropSnapSettings = {
  epcApiToken: '',
  autoEnrich: true,
  floorAreaFromText: true,
};

/**
 * Save a captured listing to Chrome extension storage.
 * Returns the listing as saved (a home the user picked earlier, and the
 * prices seen before, are kept).
 */
export function saveListing(listing: PropertyListing): Promise<PropertyListing> {
  return withLock(LISTINGS_KEY, async () => {
    const existing = await getListings();

    // Deduplicate by listingId + source
    const key = listingKey(listing);
    const previous = existing.find((l) => listingKey(l) === key);
    const filtered = existing.filter((l) => listingKey(l) !== key);

    // Keep the user's pick of home, and every price seen before
    const saved = withPriceHistory(previous, keepUserChoice(previous, listing));
    filtered.unshift(saved); // Most recent first

    await chrome.storage.local.set({ [LISTINGS_KEY]: filtered });
    return saved;
  });
}

/**
 * Get all saved listings from storage.
 */
export async function getListings(): Promise<PropertyListing[]> {
  const data = await chrome.storage.local.get(LISTINGS_KEY);
  return (data[LISTINGS_KEY] as PropertyListing[] | undefined) ?? [];
}

/**
 * Set a saved listing's full address to the close home the user picked.
 */
export function chooseAddress(source: string, listingId: string, certificateNumber: string): Promise<void> {
  return withLock(LISTINGS_KEY, async () => {
    const existing = await getListings();
    const key = listingKey({ source, listingId });
    const index = existing.findIndex((l) => listingKey(l) === key);
    if (index === -1) throw new Error('Listing not found');

    existing[index] = chooseCandidate(existing[index]!, certificateNumber);
    await chrome.storage.local.set({ [LISTINGS_KEY]: existing });
  });
}

/**
 * Keep the EPC certificate and its energy figures on a saved listing, as long
 * as the listing still points at the same home.
 */
export function setEpcEnergy(source: string, listingId: string, energy: EpcEnergy): Promise<PropertyListing | null> {
  return withLock(LISTINGS_KEY, async () => {
    const existing = await getListings();
    const key = listingKey({ source, listingId });
    const index = existing.findIndex((l) => listingKey(l) === key);
    if (index === -1) return null;
    const current = existing[index]!;
    // The user may have picked another home while the lookup ran
    if (current.epcCertificateNumber && current.epcCertificateNumber !== energy.certificateNumber) return current;

    existing[index] = { ...current, epcCertificateNumber: energy.certificateNumber, epcEnergy: energy };
    await chrome.storage.local.set({ [LISTINGS_KEY]: existing });
    return existing[index]!;
  });
}

/**
 * Delete a listing from storage, with what the user typed in for it.
 */
export async function deleteListing(source: string, listingId: string): Promise<void> {
  const key = listingKey({ source, listingId });
  await withLock(LISTINGS_KEY, async () => {
    const existing = await getListings();
    const filtered = existing.filter((l) => listingKey(l) !== key);
    await chrome.storage.local.set({ [LISTINGS_KEY]: filtered });
  });
  await removeUserData(key);
}

/**
 * Clear all saved listings, and what the user typed in for them.
 */
export async function clearListings(): Promise<void> {
  await withLock(LISTINGS_KEY, () => chrome.storage.local.remove(LISTINGS_KEY));
  await clearUserData();
}

/**
 * Get extension settings.
 */
export async function getSettings(): Promise<PropSnapSettings> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = (data[SETTINGS_KEY] ?? {}) as Partial<Record<keyof PropSnapSettings, unknown>>;
  // A value of the wrong kind (an older build, a hand edit) falls back to the default
  const pick = <K extends keyof PropSnapSettings>(key: K): PropSnapSettings[K] =>
    typeof saved[key] === typeof DEFAULT_SETTINGS[key] ? (saved[key] as PropSnapSettings[K]) : DEFAULT_SETTINGS[key];
  return { epcApiToken: pick('epcApiToken'), autoEnrich: pick('autoEnrich'), floorAreaFromText: pick('floorAreaFromText') };
}

/**
 * Save extension settings.
 */
export function saveSettings(settings: Partial<PropSnapSettings>): Promise<void> {
  return withLock(SETTINGS_KEY, async () => {
    const current = await getSettings();
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...current, ...settings },
    });
  });
}

/**
 * Export listings as CSV string.
 */
export function listingsToCsv(listings: PropertyListing[], userData: UserDataMap = {}): string {
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
    'First Price Seen',
    'Price Change',
    'Price History',
    'Listing Type',
    'Bedrooms',
    'Property Type',
    'Floor Area (sqm)',
    'Floor Area Source',
    'Tenure',
    'Furnished',
    'Deposit',
    'Agent/Landlord',
    'Agent Branch',
    'Phone',
    'EPC Rating',
    'EPC Certificate Now',
    'EPC Potential',
    'Latitude',
    'Longitude',
    'Captured At',
    'Stage',
    'Follow Up',
    'Notes',
    'Labels',
    'Hidden',
    'Last Call',
  ];

  const rows = listings.map((l) => {
    const change = priceChange(l);
    const own = userData[listingKey(l)];
    const pipeline = cleanPipeline(own?.pipeline);
    const call = lastCall(cleanActivity(own?.activity));
    return [
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
    change?.first.price?.toString() ?? '',
    change?.change.toString() ?? '',
    // "2026-10-01 300000; 2026-10-12 290000"
    (l.priceHistory ?? []).map((p) => `${p.seenAt.slice(0, 10)} ${p.price ?? ''}`.trim()).join('; '),
    l.listingType,
    l.bedrooms?.toString() ?? '',
    l.propertyType ?? '',
    l.floorAreaSqm?.toString() ?? '',
    l.floorAreaSource === 'text' ? 'description' : l.floorAreaSource ?? '',
    l.tenure ?? '',
    l.furnished ?? '',
    l.deposit?.toString() ?? '',
    l.agentName ?? '',
    l.agentBranch ?? '',
    l.agentPhone ?? '',
    l.epcRating ?? '',
    // "E 50" and "C 72": band and score from the matched home's certificate
    [l.epcEnergy?.currentBand, l.epcEnergy?.currentScore].filter((x) => x != null).join(' '),
    [l.epcEnergy?.potentialBand, l.epcEnergy?.potentialScore].filter((x) => x != null).join(' '),
    l.latitude?.toString() ?? '',
    l.longitude?.toString() ?? '',
    l.capturedAt,
    statusLabel(pipeline?.status),
    pipeline?.followUp ?? '',
    pipeline?.notes ?? '',
    cleanLabels(own?.labels).join('; '),
    own?.hidden ? 'yes' : '',
    // "2026-10-20 Spoke to the agent: vendor flexible"
    call ? `${call.at.slice(0, 10)} ${outcomeLabel(call.outcome)}${call.text ? `: ${call.text}` : ''}` : '',
  ];
  });

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
