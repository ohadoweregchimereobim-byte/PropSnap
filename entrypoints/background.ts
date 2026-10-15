/**
 * PropSnap Background Service Worker
 *
 * Handles:
 * - EPC API calls (content scripts can't make cross-origin requests)
 * - Badge updates to show when user is on a listing page
 * - Storage coordination
 */
import { enrichWithEpc, type EnrichmentResult } from '../src/services/epc-api';
import { saveListing, getSettings, getListings } from '../src/services/storage';
import type { PropertyListing } from '../src/adapters/types';

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

    if (message.type === 'GET_LISTINGS') {
      getListings()
        .then((listings) => sendResponse({ success: true, listings }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    }

    if (message.type === 'EXPORT_CSV') {
      import('../src/services/storage').then(({ listingsToCsv }) => {
        getListings().then((listings) => {
          const csv = listingsToCsv(listings);
          sendResponse({ success: true, csv });
        });
      });
      return true;
    }
  });

  console.log('PropSnap: Background service worker started');
});

/**
 * Capture a listing, optionally enrich with EPC data, and save.
 */
async function handleCaptureAndEnrich(
  listing: PropertyListing
): Promise<EnrichmentResult> {
  const settings = await getSettings();

  // Run EPC enrichment if enabled and we have a token
  if (settings.autoEnrich && settings.epcApiToken) {
    console.log('PropSnap: Starting EPC enrichment...');
    const result = await enrichWithEpc(settings.epcApiToken, listing);
    console.log(`PropSnap: Enrichment status: ${result.enrichmentStatus}`, result.enrichmentDetail ?? '');
    await saveListing(result.listing);
    return result;
  }

  // No enrichment — save as-is
  console.log('PropSnap: EPC enrichment skipped (disabled or no token)');
  await saveListing(listing);
  return {
    listing,
    enrichmentStatus: 'skipped',
    enrichmentDetail: !settings.epcApiToken ? 'No EPC API token set' : 'Auto-enrich is disabled',
  };
}
