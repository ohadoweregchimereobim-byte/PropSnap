/**
 * PropSnap Dashboard
 *
 * A full-page view of every saved listing: search, filter, sort, open,
 * delete and export. Reads chrome.storage.local directly and redraws when
 * a new capture is saved, so it stays live while open.
 */
import type { PropertyListing } from '../../src/adapters/types';
import { chooseAddress, clearListings, deleteListing, getListings, listingsToCsv } from '../../src/services/storage';
import { mapsLink } from '../../src/services/address-choice';
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
  user_choice: document.getElementById('statChosen')!,
  best_guess: document.getElementById('statGuess')!,
  none: document.getElementById('statNone')!,
};

const SITE_NAMES: Record<PropertyListing['source'], string> = {
  rightmove: 'Rightmove',
  zoopla: 'Zoopla',
  openrent: 'OpenRent',
};

const BADGES: Record<ReturnType<typeof matchGroup>, { text: string; style: string }> = {
  exact: { text: 'Exact', style: 'exact' },
  user_choice: { text: 'Your choice', style: 'chosen' },
  best_guess: { text: 'Best guess', style: 'guess' },
  none: { text: 'Not matched', style: 'none' },
};

const view: ViewOptions = { ...DEFAULT_VIEW };
// Pickers the user opened stay open when the table redraws after a choice
const openPickers = new Set<string>();
const rowKey = (l: PropertyListing) => `${l.source}:${l.listingId}`;
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
  stats.user_choice.textContent = String(counts.user_choice);
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
  badge.className = `badge badge-${BADGES[group].style}`;
  badge.textContent = BADGES[group].text;
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

  // On a best guess (or after a pick) let the user choose from the close homes
  const candidates = l.addressCandidates ?? [];
  if (candidates.length > 1 && (group === 'best_guess' || group === 'user_choice')) {
    td.append(candidatePicker(l));
  }

  return td;
}

function candidatePicker(l: PropertyListing): HTMLDetailsElement {
  const candidates = l.addressCandidates ?? [];
  const details = document.createElement('details');
  details.className = 'picker';
  details.open = openPickers.has(rowKey(l));
  details.addEventListener('toggle', () => {
    if (details.open) openPickers.add(rowKey(l));
    else openPickers.delete(rowKey(l));
  });

  const summary = document.createElement('summary');
  summary.textContent = l.addressConfidence === 'user_choice'
    ? `Change the home (${candidates.length} close homes)`
    : `Choose the right home (${candidates.length} close homes)`;
  details.append(summary);

  const hint = document.createElement('p');
  hint.className = 'picker-hint';
  hint.textContent = 'PropSnap cannot tell these homes apart. Compare the listing photos with Street View (Map), then pick the one that matches.';
  details.append(hint);

  const list = document.createElement('ul');
  for (const c of candidates) {
    const item = document.createElement('li');
    const isCurrent = c.fullAddress === l.fullAddress;
    if (isCurrent) item.className = 'current';

    const text = document.createElement('span');
    text.className = 'picker-address';
    const facts = [c.epcRating ? `EPC ${c.epcRating}` : null, c.floorAreaSqm ? `${c.floorAreaSqm} m²` : null, c.propertyType]
      .filter(Boolean)
      .join(' · ');
    text.textContent = facts ? `${c.fullAddress} (${facts})` : c.fullAddress;
    item.append(text);

    const map = document.createElement('a');
    map.className = 'btn btn-row';
    map.href = mapsLink(c.fullAddress, c.postcode);
    map.target = '_blank';
    map.rel = 'noopener noreferrer';
    map.textContent = 'Map';
    item.append(map);

    if (isCurrent) {
      const shown = document.createElement('span');
      shown.className = 'picker-current';
      shown.textContent = 'Shown now';
      item.append(shown);
    } else {
      const pick = document.createElement('button');
      pick.className = 'btn btn-row';
      pick.textContent = 'This one';
      pick.addEventListener('click', async () => {
        try {
          await chooseAddress(l.source, l.listingId, c.certificateNumber);
          setStatus(`Saved your choice: ${c.fullAddress}`);
        } catch (error: any) {
          setStatus(`Could not save your choice: ${error.message}`);
        }
      });
      item.append(pick);
    }

    list.append(item);
  }
  details.append(list);
  return details;
}

function actionsCell(l: PropertyListing): HTMLTableCellElement {
  const td = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';

  const details = document.createElement('a');
  details.className = 'btn btn-row';
  details.href = `./listing.html?key=${encodeURIComponent(rowKey(l))}`;
  details.textContent = 'Details';
  details.title = 'Deal calculator for this listing';
  wrap.append(details);

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
