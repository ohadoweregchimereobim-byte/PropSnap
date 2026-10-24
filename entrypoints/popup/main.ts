/**
 * PropSnap Popup Script
 *
 * Handles the popup UI:
 * - Checks if current tab is on a listing page
 * - Triggers extraction via content script
 * - Sends captured data to background for EPC enrichment
 * - Displays results
 * - Settings management
 */

import { downloadCsv } from '../../src/services/csv-download';
import { latestMove } from '../../src/services/price-history';
import { getListings, getSettings, saveSettings } from '../../src/services/storage';
import { formatMoney, SITE_NAMES } from '../../src/services/format';
import { listingSiteForUrl } from '../../src/adapters/listing-urls';
import type { PropertyListing } from '../../src/adapters/types';

// DOM elements
const statusEl = document.getElementById('status')!;
const captureBtn = document.getElementById('captureBtn') as HTMLButtonElement;
const resultCard = document.getElementById('resultCard')!;
const exportBtn = document.getElementById('exportBtn')!;
const dashboardBtn = document.getElementById('dashboardBtn')!;
const settingsBtn = document.getElementById('settingsBtn')!;
const settingsPanel = document.getElementById('settingsPanel')!;
const saveSettingsBtn = document.getElementById('saveSettingsBtn')!;
const epcTokenInput = document.getElementById('epcToken') as HTMLInputElement;
const autoEnrichCheckbox = document.getElementById('autoEnrich') as HTMLInputElement;
const floorAreaFromTextCheckbox = document.getElementById('floorAreaFromText') as HTMLInputElement;
const listingCountEl = document.getElementById('listingCount')!;

// Result fields
const fields = {
  address: document.getElementById('resultAddress')!,
  fullAddress: document.getElementById('resultFullAddress')!,
  postcode: document.getElementById('resultPostcode')!,
  price: document.getElementById('resultPrice')!,
  beds: document.getElementById('resultBeds')!,
  type: document.getElementById('resultType')!,
  agent: document.getElementById('resultAgent')!,
  phone: document.getElementById('resultPhone')!,
  epc: document.getElementById('resultEpc')!,
  source: document.getElementById('resultSource')!,
};

// Initialise
init();

async function init() {
  captureBtn.addEventListener('click', handleCapture);
  exportBtn.addEventListener('click', handleExport);
  dashboardBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('/dashboard.html') });
  });

  // The settings form only works once it holds the saved settings, so Save
  // can never write an empty token over the real one
  const settingsReady = loadSettings().then(() => {
    settingsBtn.addEventListener('click', toggleSettings);
    saveSettingsBtn.addEventListener('click', handleSaveSettings);
  });

  // The Capture button first; the count and settings fill in alongside
  await Promise.all([checkCurrentTab(), updateListingCount(), settingsReady]);
}

/**
 * Check if the current tab is on a supported listing page.
 */
async function checkCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url) {
    setStatus('Open a property listing to get started', '');
    return;
  }

  // The same check the page's content script makes, so the two always agree
  const site = listingSiteForUrl(tab.url);

  if (site) {
    setStatus(`${SITE_NAMES[site]} listing detected — ready to capture`, 'ready');
    captureBtn.disabled = false;
  } else {
    setStatus('Navigate to a Rightmove, Zoopla, or OpenRent listing', '');
  }
}

/**
 * Handle the capture button click.
 */
async function handleCapture() {
  captureBtn.disabled = true;
  captureBtn.textContent = 'Capturing...';
  setStatus('Extracting listing data...', '');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');

    // Ask content script to extract data. A tab opened before PropSnap was
    // installed or reloaded has no content script to answer.
    const extractResponse = await chrome.tabs
      .sendMessage(tab.id, { type: 'EXTRACT_LISTING' })
      .catch((error: Error) => {
        if (/receiving end does not exist|could not establish connection/i.test(error.message)) {
          throw new Error('PropSnap cannot read this tab yet. Reload the page, then click Capture again.');
        }
        throw error;
      });

    if (!extractResponse?.success) {
      throw new Error(extractResponse?.error ?? 'Extraction failed');
    }

    setStatus('Enriching with EPC data...', '');

    // Send to background for EPC enrichment and storage
    const enrichResponse = await chrome.runtime.sendMessage({
      type: 'CAPTURE_AND_ENRICH',
      listing: extractResponse.listing,
    });

    if (!enrichResponse?.success) {
      throw new Error(enrichResponse?.error ?? 'Enrichment failed');
    }

    // Display result
    displayResult(enrichResponse.listing, enrichResponse.enrichmentStatus, enrichResponse.enrichmentDetail);

    if (enrichResponse.enrichmentStatus === 'enriched' && enrichResponse.listing.addressConfidence === 'best_guess') {
      setStatus(`Captured — full address is a best guess, please check it. ${enrichResponse.enrichmentDetail ?? ''}`.trim(), 'warning');
    } else if (enrichResponse.enrichmentStatus === 'enriched') {
      setStatus(`Property captured with full address! ${enrichResponse.enrichmentDetail ?? ''}`.trim(), 'success');
    } else if (enrichResponse.enrichmentStatus === 'no_postcode') {
      setStatus(`Captured — ${enrichResponse.enrichmentDetail ?? 'no postcode to search'}`, 'warning');
    } else if (enrichResponse.enrichmentStatus === 'api_error') {
      setStatus(`Captured — EPC error: ${enrichResponse.enrichmentDetail}`, 'error');
    } else if (enrichResponse.enrichmentStatus === 'no_match') {
      setStatus('Captured — no EPC match found', 'error');
    } else {
      setStatus('Property captured!', 'success');
    }
    await updateListingCount();

  } catch (error: any) {
    setStatus(`Error: ${error.message}`, 'error');
  } finally {
    captureBtn.disabled = false;
    captureBtn.textContent = 'Capture Property';
  }
}

/**
 * Display a captured listing in the result card.
 */
function displayResult(listing: PropertyListing, enrichmentStatus?: string, enrichmentDetail?: string) {
  fields.address.textContent = listing.displayAddress || '—';

  if (listing.fullAddress) {
    const choices = listing.addressCandidates?.length ?? 0;
    const label = listing.addressConfidence === 'exact' ? ' (exact match)'
      : listing.addressConfidence === 'user_choice' ? ' (your choice)'
      : listing.addressConfidence === 'best_guess' && choices > 1
        ? ` (best guess: pick the right one of ${choices} close homes in the Dashboard)`
      : listing.addressConfidence === 'best_guess' ? ' (best guess)'
      : '';
    fields.fullAddress.textContent = `${listing.fullAddress}${label}`;
  } else if (enrichmentStatus === 'api_error') {
    fields.fullAddress.textContent = `API error: ${enrichmentDetail ?? 'unknown'}`;
  } else if (enrichmentStatus === 'no_match') {
    fields.fullAddress.textContent = 'No EPC match found';
  } else if (enrichmentStatus === 'no_postcode') {
    fields.fullAddress.textContent = 'Full postcode not available';
  } else {
    fields.fullAddress.textContent = 'Not enriched';
  }
  fields.postcode.textContent = listing.postcode || listing.postcodePartial || '—';
  fields.beds.textContent = listing.bedrooms?.toString() || '—';
  fields.type.textContent = listing.propertyType || '—';
  fields.agent.textContent = listing.agentName || '—';
  fields.phone.textContent = listing.agentPhone || '—';
  fields.epc.textContent = listing.epcRating || '—';
  fields.source.textContent = SITE_NAMES[listing.source] ?? listing.source ?? '—';

  // Format price
  if (listing.price) {
    const formatted = formatMoney(listing.price);
    const suffix = listing.listingType === 'rent' ? '/pcm' : '';
    fields.price.textContent = `${formatted}${suffix}`;
  } else {
    fields.price.textContent = '—';
  }

  // Say when this capture found a new price
  const move = latestMove(listing);
  const moveEl = document.getElementById('resultPriceMove')!;
  moveEl.hidden = !move || move.seenAt !== listing.capturedAt;
  if (move) {
    const down = move.to < move.from;
    moveEl.className = `price-move ${down ? 'price-reduced' : 'price-increased'}`;
    moveEl.textContent = `${down ? 'Price reduced' : 'Price up'} since your last capture: ${formatMoney(move.from)} → ${formatMoney(move.to)}`;
  }

  resultCard.hidden = false;
}

/**
 * Export all saved listings as CSV.
 */
async function handleExport() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'EXPORT_CSV' });

    if (!response?.success) {
      throw new Error(response?.error ?? 'no answer from PropSnap');
    }
    if (!response.csv) {
      setStatus('No listings to export', 'error');
      return;
    }

    downloadCsv(response.csv);

    setStatus('CSV exported!', 'success');
  } catch (error: any) {
    setStatus(`Export failed: ${error.message}`, 'error');
  }
}

/**
 * Toggle settings panel visibility.
 */
function toggleSettings() {
  settingsPanel.hidden = !settingsPanel.hidden;
}

/**
 * Load saved settings into the form.
 */
async function loadSettings() {
  const settings = await getSettings();
  epcTokenInput.value = settings.epcApiToken;
  autoEnrichCheckbox.checked = settings.autoEnrich;
  floorAreaFromTextCheckbox.checked = settings.floorAreaFromText;
}

/**
 * Save settings from the form.
 */
async function handleSaveSettings() {
  await saveSettings({
    epcApiToken: epcTokenInput.value.trim(),
    autoEnrich: autoEnrichCheckbox.checked,
    floorAreaFromText: floorAreaFromTextCheckbox.checked,
  });
  setStatus('Settings saved!', 'success');
  settingsPanel.hidden = true;
}

/**
 * Update the listing count display.
 */
async function updateListingCount() {
  try {
    // Read straight from storage: no need to wake the background worker for a number
    const count = (await getListings()).length;
    listingCountEl.textContent = `${count} listing${count === 1 ? '' : 's'} saved`;
  } catch {
    listingCountEl.textContent = '0 listings saved';
  }
}

/**
 * Set the status message.
 */
function setStatus(message: string, type: '' | 'success' | 'error' | 'ready' | 'warning') {
  statusEl.textContent = message;
  statusEl.className = `status${type ? ` ${type}` : ''}`;
}
