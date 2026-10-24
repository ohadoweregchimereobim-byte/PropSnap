/**
 * PropSnap Background Service Worker
 *
 * Handles:
 * - EPC API calls (content scripts can't make cross-origin requests)
 * - Badge updates to show when user is on a listing page
 * - Storage coordination
 */
import { enrichWithEpc, type EnrichmentResult } from '../src/services/epc-api';
import { saveListing, getSettings, getListings, listingsToCsv } from '../src/services/storage';
import { reuseKnownAddress } from '../src/services/address-choice';
import { getAllUserData } from '../src/services/user-data';
import type { PropertyListing } from '../src/adapters/types';
import { applyFloorAreaSetting } from '../src/adapters/floor-area-text';

export default defineBackground(() => {
  // Update badge when on a listing page
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'LISTING_PAGE_DETECTED') {
      // Show green badge on the extension icon
      if (sender.tab?.id) {
        chrome.action.setBadgeText({ text: '✓', tabId: sender.tab.id });
        chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId: sender.tab.id });
      }
    }

    if (message.type === 'CAPTURE_AND_ENRICH') {
      handleCaptureAndEnrich(message.listing)
        .then((result) => sendResponse({
          success: true,
          listing: result.listing,
          enrichmentStatus: result.enrichmentStatus,
          enrichmentDetail: result.enrichmentDetail,
        }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true; // Async response
    }

    if (message.type === 'EXPORT_CSV') {
      Promise.all([getListings(), getAllUserData()])
        .then(([listings, userData]) => sendResponse({ success: true, csv: listingsToCsv(listings, userData) }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    }
  });

  console.log('PropSnap: Background service worker started');
});

/**
 * Capture a listing, optionally enrich with EPC data, and save.
 */
async function handleCaptureAndEnrich(
  captured: PropertyListing
): Promise<EnrichmentResult> {
  const settings = await getSettings();
  const listing = applyFloorAreaSetting(captured, settings.floorAreaFromText);

  // Run EPC enrichment if enabled and we have a token
  if (settings.autoEnrich && settings.epcApiToken) {
    // Captured again, and the home is already known: no need to ask the register
    const previous = (await getListings()).find((l) => l.source === listing.source && l.listingId === listing.listingId);
    const known = reuseKnownAddress(previous, listing);
    if (known) {
      console.log('PropSnap: Address already known from an earlier capture, EPC lookup skipped');
      const saved = await saveListing(known);
      return { listing: saved, enrichmentStatus: 'enriched', enrichmentDetail: saved.enrichmentDetail ?? undefined };
    }

    console.log('PropSnap: Starting EPC enrichment...');
    const result = await enrichWithEpc(settings.epcApiToken, listing);
    console.log(`PropSnap: Enrichment status: ${result.enrichmentStatus}`, result.enrichmentDetail ?? '');
    // Keep the explanation with the listing so the CSV can show it later
    result.listing = await saveListing({ ...result.listing, enrichmentDetail: result.enrichmentDetail ?? null });
    if (result.listing.addressConfidence === 'user_choice') result.enrichmentDetail = result.listing.enrichmentDetail ?? undefined;
    return result;
  }

  // No enrichment — save as-is
  console.log('PropSnap: EPC enrichment skipped (disabled or no token)');
  return {
    listing: await saveListing(listing),
    enrichmentStatus: 'skipped',
    enrichmentDetail: !settings.epcApiToken ? 'No EPC API token set' : 'Auto-enrich is disabled',
  };
}
