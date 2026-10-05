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

// DOM elements
const statusEl = document.getElementById('status')!;
const captureBtn = document.getElementById('captureBtn') as HTMLButtonElement;
const resultCard = document.getElementById('resultCard')!;
const exportBtn = document.getElementById('exportBtn')!;
const settingsBtn = document.getElementById('settingsBtn')!;
const settingsPanel = document.getElementById('settingsPanel')!;
const saveSettingsBtn = document.getElementById('saveSettingsBtn')!;
const epcTokenInput = document.getElementById('epcToken') as HTMLInputElement;
const autoEnrichCheckbox = document.getElementById('autoEnrich') as HTMLInputElement;
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
  await updateListingCount();
  await loadSettings();
  await checkCurrentTab();

  captureBtn.addEventListener('click', handleCapture);
  exportBtn.addEventListener('click', handleExport);
  settingsBtn.addEventListener('click', toggleSettings);
  saveSettingsBtn.addEventListener('click', handleSaveSettings);
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

  const supported = [
    /rightmove\.co\.uk\/properties\/\d+/,
    /zoopla\.co\.uk\/(for-sale|to-rent)\/details\/\d+/,
    /openrent\.com\/property-to-rent\/[^/]+\/\d+/,
  ];

  const isListing = supported.some((p) => p.test(tab.url!));

  if (isListing) {
    const site = tab.url!.includes('rightmove') ? 'Rightmove'
      : tab.url!.includes('zoopla') ? 'Zoopla'
      : 'OpenRent';

    setStatus(`${site} listing detected — ready to capture`, 'ready');
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

    // Ask content script to extract data
    const extractResponse = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXTRACT_LISTING',
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
    displayResult(enrichResponse.listing);
    setStatus('Property captured!', 'success');
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
function displayResult(listing: any) {
  fields.address.textContent = listing.displayAddress || '—';
  fields.fullAddress.textContent = listing.fullAddress || 'Not enriched';
  fields.postcode.textContent = listing.postcode || listing.postcodePartial || '—';
  fields.beds.textContent = listing.bedrooms?.toString() || '—';
  fields.type.textContent = listing.propertyType || '—';
  fields.agent.textContent = listing.agentName || '—';
  fields.phone.textContent = listing.agentPhone || '—';
  fields.epc.textContent = listing.epcRating || '—';
  fields.source.textContent = listing.source || '—';

  // Format price
  if (listing.price) {
    const formatted = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'GBP',
      maximumFractionDigits: 0,
    }).format(listing.price);
    const suffix = listing.listingType === 'rent' ? '/pcm' : '';
    fields.price.textContent = `${formatted}${suffix}`;
  } else {
    fields.price.textContent = '—';
  }

  resultCard.hidden = false;
}

/**
 * Export all saved listings as CSV.
 */
async function handleExport() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'EXPORT_CSV' });

    if (!response?.success || !response.csv) {
      setStatus('No listings to export', 'error');
      return;
    }

    // Create download
    const blob = new Blob([response.csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `propsnap-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

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
  const data = await chrome.storage.local.get('propsnap_settings');
  const settings = data.propsnap_settings ?? {};

  epcTokenInput.value = settings.epcApiToken ?? '';
  autoEnrichCheckbox.checked = settings.autoEnrich ?? true;
}

/**
 * Save settings from the form.
 */
async function handleSaveSettings() {
  const settings = {
    epcApiToken: epcTokenInput.value.trim(),
    autoEnrich: autoEnrichCheckbox.checked,
  };

  await chrome.storage.local.set({ propsnap_settings: settings });
  setStatus('Settings saved!', 'success');
  settingsPanel.hidden = true;
}

/**
 * Update the listing count display.
 */
async function updateListingCount() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_LISTINGS' });
    const count = response?.listings?.length ?? 0;
    listingCountEl.textContent = `${count} listing${count === 1 ? '' : 's'} saved`;
  } catch {
    listingCountEl.textContent = '0 listings saved';
  }
}

/**
 * Set the status message.
 */
function setStatus(message: string, type: '' | 'success' | 'error' | 'ready') {
  statusEl.textContent = message;
  statusEl.className = `status${type ? ` ${type}` : ''}`;
}
