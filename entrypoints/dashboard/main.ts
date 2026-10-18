/**
 * PropSnap Dashboard
 *
 * A full-page view of every saved listing: search, filter, sort, open,
 * delete and export. Reads chrome.storage.local directly and redraws when
 * a new capture is saved, so it stays live while open.
 */
import type { PropertyListing } from '../../src/adapters/types';
import { clearListings, deleteListing, getListings, listingsToCsv } from '../../src/services/storage';
import { downloadCsv } from '../../src/services/csv-download';
import {
  applyView,
  DEFAULT_VIEW,
  matchGroup,
  safeLink,
  summarise,
  type SortKey,
  type ViewOptions,
} from '../../src/services/dashboard-view';

const STORAGE_KEY = 'propsnap_listings';

const rowsEl = document.getElementById('rows')!;
const emptyEl = document.getElementById('empty')!;
const statusEl = document.getElementById('status')!;
const shownEl = document.getElementById('shownCount')!;
const searchInput = document.getElementById('search') as HTMLInputElement;
const sourceSelect = document.getElementById('sourceFilter') as HTMLSelectElement;
const matchSelect = document.getElementById('matchFilter') as HTMLSelectElement;
const sortButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('th button[data-sort]'));

const stats = {
  total: document.getElementById('statTotal')!,
  exact: document.getElementById('statExact')!,
  best_guess: document.getElementById('statGuess')!,
  none: document.getElementById('statNone')!,
};

const SITE_NAMES: Record<PropertyListing['source'], string> = {
  rightmove: 'Rightmove',
  zoopla: 'Zoopla',
  openrent: 'OpenRent',
};

const view: ViewOptions = { ...DEFAULT_VIEW };
let listings: PropertyListing[] = [];

init();

async function init() {
  searchInput.addEventListener('input', () => { view.search = searchInput.value; render(); });
  sourceSelect.addEventListener('change', () => { view.source = sourceSelect.value as ViewOptions['source']; render(); });
  matchSelect.addEventListener('change', () => { view.match = matchSelect.value as ViewOptions['match']; render(); });

  for (const button of sortButtons) {
    button.addEventListener('click', () => {
      const key = button.dataset.sort as SortKey;
      if (view.sortKey === key) {
        view.sortDir = view.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        view.sortKey = key;
        // Dates and numbers read best biggest first, text A to Z
        view.sortDir = ['capturedAt', 'price', 'bedrooms'].includes(key) ? 'desc' : 'asc';
      }
      render();
    });
  }

  document.getElementById('exportBtn')!.addEventListener('click', handleExport);
  document.getElementById('clearBtn')!.addEventListener('click', handleClearAll);

  // A capture in another tab saves here too, so redraw when storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && STORAGE_KEY in changes) reload();
  });

  await reload();
}

async function reload() {
  try {
    listings = await getListings();
    render();
  } catch (error: any) {
    setStatus(`Could not read saved listings: ${error.message}`);
  }
}

function render() {
  const counts = summarise(listings);
  stats.total.textContent = String(counts.total);
  stats.exact.textContent = String(counts.exact);
  stats.best_guess.textContent = String(counts.best_guess);
  stats.none.textContent = String(counts.none);

  for (const button of sortButtons) {
    if (button.dataset.sort === view.sortKey) {
      button.setAttribute('aria-sort', view.sortDir === 'asc' ? 'ascending' : 'descending');
    } else {
      button.removeAttribute('aria-sort');
    }
  }

  const shown = applyView(listings, view);
  rowsEl.replaceChildren(...shown.map(renderRow));
  shownEl.textContent = listings.length > 0 ? `Showing ${shown.length} of ${listings.length}` : '';

  if (listings.length === 0) {
    emptyEl.textContent = 'No saved listings yet. Open a Rightmove, Zoopla or OpenRent listing and click Capture in the PropSnap popup.';
    emptyEl.hidden = false;
  } else if (shown.length === 0) {
    emptyEl.textContent = 'No listings match these filters.';
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
  }
}

/** Build one table row. Listing text comes from other websites, so only textContent is used. */
function renderRow(l: PropertyListing): HTMLTableRowElement {
  const tr = document.createElement('tr');

  tr.append(
    cell(formatDate(l.capturedAt), 'nowrap'),
    cell(SITE_NAMES[l.source] ?? l.source),
    addressCell(l),
    cell(l.postcode || l.postcodePartial || '—', 'nowrap'),
    cell(formatPrice(l), 'num nowrap'),
    cell(l.bedrooms?.toString() ?? '—', 'num'),
    cell(l.propertyType || '—'),
    cell(l.epcRating || '—'),
    cell(l.agentName || '—'),
    actionsCell(l),
  );

  return tr;
}

function cell(text: string, className = ''): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  if (text === '—') td.classList.add('muted');
  return td;
}

function addressCell(l: PropertyListing): HTMLTableCellElement {
  const td = document.createElement('td');
  const group = matchGroup(l);

  const main = document.createElement('div');
  main.className = 'address-main';
  main.textContent = l.fullAddress || l.displayAddress || '—';

  const badge = document.createElement('span');
  badge.className = `badge badge-${group === 'exact' ? 'exact' : group === 'best_guess' ? 'guess' : 'none'}`;
  badge.textContent = group === 'exact' ? 'Exact' : group === 'best_guess' ? 'Best guess' : 'Not matched';
  badge.title = l.enrichmentDetail || (group === 'none' ? 'No full address from the EPC register' : 'Captured before match details were saved');
  main.append(badge);
  td.append(main);

  // Show the listing's own address under the full one, so the two can be compared
  if (l.fullAddress && l.displayAddress) {
    const listed = document.createElement('div');
    listed.className = 'address-listing';
    listed.textContent = `Listed as: ${l.displayAddress}`;
    td.append(listed);
  }

  return td;
}

function actionsCell(l: PropertyListing): HTMLTableCellElement {
  const td = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';

  const href = safeLink(l.url);
  if (href) {
    const open = document.createElement('a');
    open.className = 'btn btn-row';
    open.href = href;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open';
    wrap.append(open);
  }

  const remove = document.createElement('button');
  remove.className = 'btn btn-row btn-danger';
  remove.textContent = 'Delete';
  remove.addEventListener('click', async () => {
    const name = l.fullAddress || l.displayAddress || 'this listing';
    if (!confirm(`Delete ${name}?`)) return;
    try {
      await deleteListing(l.source, l.listingId);
      setStatus(`Deleted ${name}`);
    } catch (error: any) {
      setStatus(`Delete failed: ${error.message}`);
    }
  });
  wrap.append(remove);

  td.append(wrap);
  return td;
}

function handleExport() {
  if (listings.length === 0) {
    setStatus('No listings to export');
    return;
  }
  downloadCsv(listingsToCsv(listings));
  setStatus(`Exported ${listings.length} listing${listings.length === 1 ? '' : 's'}`);
}

async function handleClearAll() {
  if (listings.length === 0) return;
  if (!confirm(`Delete all ${listings.length} saved listings? This cannot be undone. Export a CSV first if you want a copy.`)) return;
  try {
    await clearListings();
    setStatus('All listings deleted');
  } catch (error: any) {
    setStatus(`Clear failed: ${error.message}`);
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatPrice(l: PropertyListing): string {
  if (!l.price) return '—';
  const formatted = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(l.price);
  return l.listingType === 'rent' ? `${formatted} pcm` : formatted;
}

function setStatus(message: string) {
  statusEl.textContent = message;
}
