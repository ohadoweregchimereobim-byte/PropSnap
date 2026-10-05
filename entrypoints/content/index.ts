/**
 * PropSnap Content Script
 *
 * Runs on Rightmove, Zoopla, and OpenRent listing pages.
 * Detects which site the user is on, extracts listing data using
 * the appropriate adapter, and sends it to the background script.
 */
import { getAdapterForUrl } from '../../src/adapters';

export default defineContentScript({
  matches: [
    'https://www.rightmove.co.uk/properties/*',
    'https://www.zoopla.co.uk/for-sale/details/*',
    'https://www.zoopla.co.uk/to-rent/details/*',
    'https://www.openrent.com/property-to-rent/*',
  ],

  async main() {
    const url = window.location.href;
    const adapter = getAdapterForUrl(url);

    if (!adapter) {
      console.log('PropSnap: Not a supported listing page');
      return;
    }

    console.log(`PropSnap: Detected ${adapter.site} listing page`);

    // Listen for extraction requests from the popup
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'EXTRACT_LISTING') {
        adapter
          .extract()
          .then((listing) => {
            sendResponse({ success: true, listing });
          })
          .catch((error) => {
            console.error('PropSnap: Extraction failed:', error);
            sendResponse({ success: false, error: error.message });
          });

        // Return true to indicate we'll respond asynchronously
        return true;
      }
    });

    // Notify the background script that we're on a listing page
    chrome.runtime.sendMessage({
      type: 'LISTING_PAGE_DETECTED',
      site: adapter.site,
      url,
    });
  },
});
