/**
 * PropSnap Dashboard
 *
 * A full-page view of every saved listing: search, filter, sort, open,
 * delete and export. Reads chrome.storage.local directly and redraws when
 * a new capture is saved, so it stays live while open.
 */
import type { PropertyListing } from '../../src/adapters/types';
import { chooseAddress, clearListings, deleteListing, getListings, LISTINGS_KEY, listingsToCsv } from '../../src/services/storage';
import { formatMoney, SITE_NAMES } from '../../src/services/format';
import { describeEnergy } from '../../src/services/epc-energy';
import { mapsLink } from '../../src/services/address-choice';
import { downloadCsv } from '../../src/services/csv-download';
import { daysOnMarket, describeChange, describeDays, describePortalChanges, latestPortalChange, priceChange } from '../../src/services/price-history';
import { followUpState, localDate, STATUSES, type PipelineStatus } from '../../src/services/pipeline';
import { getAgentNotes, getAllUserData, listingKey, setHidden, updatePipeline, USER_DATA_KEY, type UserDataMap } from '../../src/services/user-data';
import { AGENTS_KEY, allLabels, cleanActivity, cleanLabels, groupByAgent, lastCall, outcomeLabel, whenText, type AgentNotes } from '../../src/services/crm';
import {
  applyView,
  DEFAULT_VIEW,
  matchGroup,
  isHidden,
  labelsOf,
  pipelineOf,
  safeLink,
  summarise,
  type SortKey,
  type ViewOptions,
} from '../../src/services/dashboard-view';

const rowsEl = document.getElementById('rows')!;
const emptyEl = document.getElementById('empty')!;
const statusEl = document.getElementById('status')!;
const shownEl = document.getElementById('shownCount')!;
const searchInput = document.getElementById('search') as HTMLInputElement;
const sourceSelect = document.getElementById('sourceFilter') as HTMLSelectElement;
const matchSelect = document.getElementById('matchFilter') as HTMLSelectElement;
const priceSelect = document.getElementById('priceFilter') as HTMLSelectElement;
const statusSelect = document.getElementById('statusFilter') as HTMLSelectElement;
const labelSelect = document.getElementById('labelFilter') as HTMLSelectElement;
const hiddenSelect = document.getElementById('hiddenFilter') as HTMLSelectElement;
const daysSelect = document.getElementById('daysFilter') as HTMLSelectElement;
const groupBox = document.getElementById('groupByAgent') as HTMLInputElement;
const sortButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('th button[data-sort]'));

const stats = {
  total: document.getElementById('statTotal')!,
  exact: document.getElementById('statExact')!,
  user_choice: document.getElementById('statChosen')!,
  best_guess: document.getElementById('statGuess')!,
  none: document.getElementById('statNone')!,
  reduced: document.getElementById('statReduced')!,
  active: document.getElementById('statActive')!,
  due: document.getElementById('statDue')!,
};

const BADGES: Record<ReturnType<typeof matchGroup>, { text: string; style: string }> = {
  exact: { text: 'Exact', style: 'exact' },
  user_choice: { text: 'Your choice', style: 'chosen' },
  best_guess: { text: 'Best guess', style: 'guess' },
  none: { text: 'Not matched', style: 'none' },
};

const view: ViewOptions = { ...DEFAULT_VIEW };
// Homes ticked for the viewing planner; kept while the table redraws
const picked = new Set<string>();
const planBtn = document.getElementById('planBtn') as HTMLButtonElement;
// Pickers the user opened stay open when the table redraws after a choice
const openPickers = new Set<string>();
let listings: PropertyListing[] = [];
let userData: UserDataMap = {};
let agentNotes: AgentNotes = {};

init();

async function init() {
  // Redraw once typing pauses, not on every key
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { view.search = searchInput.value; render(); }, 150);
  });
  sourceSelect.addEventListener('change', () => { view.source = sourceSelect.value as ViewOptions['source']; render(); });
  matchSelect.addEventListener('change', () => { view.match = matchSelect.value as ViewOptions['match']; render(); });
  priceSelect.addEventListener('change', () => { view.price = priceSelect.value as ViewOptions['price']; render(); });
  statusSelect.append(...STATUSES.map((s) => new Option(s.label, s.value)));
  statusSelect.addEventListener('change', () => { view.status = statusSelect.value as ViewOptions['status']; render(); });
  labelSelect.addEventListener('change', () => { view.label = labelSelect.value; render(); });
  hiddenSelect.addEventListener('change', () => { view.hidden = hiddenSelect.value as ViewOptions['hidden']; render(); });
  daysSelect.addEventListener('change', () => { view.minDays = Number(daysSelect.value) || 0; render(); });
  groupBox.addEventListener('change', render);

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
  planBtn.addEventListener('click', () => {
    // Ticked homes start a new plan; with none ticked, open the saved plan
    const keys = listings.map(listingKey).filter((k) => picked.has(k));
    location.href = keys.length ? `./planner.html?${new URLSearchParams({ keys: keys.join(',') })}` : './planner.html';
  });
  document.getElementById('clearBtn')!.addEventListener('click', handleClearAll);

  // A capture in another tab saves here too, so redraw when storage changes
  // The change carries the new value, so there is nothing to read back
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(LISTINGS_KEY in changes || USER_DATA_KEY in changes || AGENTS_KEY in changes)) return;
    if (AGENTS_KEY in changes) { getAgentNotes().then((notes) => { agentNotes = notes; render(); }); return; }
    if (LISTINGS_KEY in changes) listings = (changes[LISTINGS_KEY]!.newValue as PropertyListing[] | undefined) ?? [];
    if (USER_DATA_KEY in changes) userData = (changes[USER_DATA_KEY]!.newValue as UserDataMap | undefined) ?? {};
    render();
  });

  await reload();
}

async function reload() {
  try {
    [listings, userData, agentNotes] = await Promise.all([getListings(), getAllUserData(), getAgentNotes()]);
    render();
  } catch (error: any) {
    setStatus(`Could not read saved listings: ${error.message}`);
  }
}

function render() {
  const context = { userData, today: localDate(new Date()) };
  const counts = summarise(listings, context);
  stats.total.textContent = String(counts.total);
  stats.exact.textContent = String(counts.exact);
  stats.user_choice.textContent = String(counts.user_choice);
  stats.best_guess.textContent = String(counts.best_guess);
  stats.none.textContent = String(counts.none);
  stats.reduced.textContent = String(counts.reduced);
  stats.active.textContent = String(counts.active);
  stats.due.textContent = String(counts.due);

  for (const button of sortButtons) {
    if (button.dataset.sort === view.sortKey) {
      button.setAttribute('aria-sort', view.sortDir === 'asc' ? 'ascending' : 'descending');
    } else {
      button.removeAttribute('aria-sort');
    }
  }

  // Forget ticks on homes that are gone
  const known = new Set(listings.map(listingKey));
  for (const k of [...picked]) if (!known.has(k)) picked.delete(k);
  updatePlanButton();

  updateLabelFilter();
  hiddenSelect.options[0]!.textContent = counts.hidden ? `Leave out hidden homes (${counts.hidden})` : 'Leave out hidden homes';

  const shown = applyView(listings, view, context);
  if (groupBox.checked) {
    // One header row per agent, then that agent's listings in the chosen order
    const groups = groupByAgent(shown, (l) => cleanActivity(userData[listingKey(l)]?.activity), agentNotes);
    rowsEl.replaceChildren(...groups.flatMap((g) => [agentRow(g), ...g.listings.map(renderRow)]));
  } else {
    rowsEl.replaceChildren(...shown.map(renderRow));
  }
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
    pickCell(l),
    capturedCell(l),
    cell(SITE_NAMES[l.source] ?? l.source),
    addressCell(l),
    cell(l.postcode || l.postcodePartial || '—', 'nowrap'),
    priceCell(l),
    cell(l.bedrooms?.toString() ?? '—', 'num'),
    cell(l.propertyType || '—'),
    epcCell(l),
    cell(l.agentName || '—'),
    stageCell(l),
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

function updatePlanButton() {
  planBtn.textContent = picked.size ? `Plan viewings (${picked.size})` : 'Viewing planner';
  planBtn.title = picked.size ? 'Plan a viewing day with the ticked homes' : 'Tick homes to plan a viewing day, or open the saved plan';
}

function pickCell(l: PropertyListing): HTMLTableCellElement {
  const td = document.createElement('td');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = picked.has(listingKey(l));
  box.setAttribute('aria-label', `Pick ${l.fullAddress || l.displayAddress} for viewings`);
  box.addEventListener('change', () => {
    if (box.checked) picked.add(listingKey(l));
    else picked.delete(listingKey(l));
    updatePlanButton();
  });
  td.append(box);
  return td;
}

/** The listing's EPC band, with the certificate's potential under it when known */
function epcCell(l: PropertyListing): HTMLTableCellElement {
  const e = l.epcEnergy;
  const td = cell(l.epcRating || e?.currentBand || '—');
  if (e?.potentialBand && e.currentBand && e.potentialBand !== e.currentBand) {
    const up = document.createElement('div');
    up.className = 'epc-up';
    up.textContent = `could be ${e.potentialBand}`;
    up.title = `Certificate: ${describeEnergy(e)}, now to potential`;
    td.append(up);
  }
  return td;
}

/** When it was captured, and how long the site says it has been on the market */
function capturedCell(l: PropertyListing): HTMLTableCellElement {
  const td = cell(formatDate(l.capturedAt), 'nowrap');
  const days = daysOnMarket(l, localDate(new Date()));
  if (days != null) {
    const line = document.createElement('div');
    line.className = 'on-market';
    line.textContent = describeDays(days);
    line.title = `${SITE_NAMES[l.source]} first listed it on ${new Date(`${l.listedOn}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    td.append(line);
  }
  return td;
}

/** The price, with how it moved since the first capture, else the latest change the site shows */
function priceCell(l: PropertyListing): HTMLTableCellElement {
  const td = cell(formatPrice(l), 'num nowrap');
  const change = priceChange(l);
  const tag = document.createElement('div');
  if (change) {
    tag.className = `price-move price-${change.direction}`;
    tag.textContent = describeChange(change);
    tag.title = `First seen at ${formatMoney(change.first.price!)} on ${formatDate(change.first.seenAt)}; `
      + `${change.moves} change${change.moves === 1 ? '' : 's'}, the last seen on ${formatDate(change.lastMoveAt!)}`;
    td.append(tag);
  } else if (latestPortalChange(l)) {
    // The site's own change: a date, no amount
    tag.className = `price-move price-${latestPortalChange(l)!.startsWith('Reduced') ? 'reduced' : 'increased'}`;
    tag.textContent = latestPortalChange(l)!;
    tag.title = `${describePortalChanges(l)}. The site does not show the amounts.`;
    td.append(tag);
  }
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
  details.open = openPickers.has(listingKey(l));
  details.addEventListener('toggle', () => {
    if (details.open) openPickers.add(listingKey(l));
    else openPickers.delete(listingKey(l));
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

/** Every label in use, offered in the filter; the picked one stays picked */
function updateLabelFilter() {
  const labels = allLabels(listings.map((l) => labelsOf(l, userData)));
  const used = new Set(listings.flatMap((l) => labelsOf(l, userData)).map((l) => l.toLowerCase()));
  const wanted = ['all', ...labels.filter((l) => used.has(l.toLowerCase()))];
  const current = [...labelSelect.options].map((o) => o.value);
  if (wanted.join('\n') !== current.join('\n')) {
    labelSelect.replaceChildren(new Option('All labels', 'all'), ...wanted.slice(1).map((l) => new Option(l, l)));
  }
  if (!wanted.includes(view.label)) view.label = 'all';
  labelSelect.value = view.label;
}

/** The header row of one agent's group */
function agentRow(g: ReturnType<typeof groupByAgent>[number]): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'agent-row';
  const td = document.createElement('td');
  td.colSpan = 12;
  const name = document.createElement('strong');
  name.textContent = `${g.name}${g.branch ? `, ${g.branch}` : ''}`;
  td.append(name);
  const facts = [
    g.phone,
    `${g.listings.length} listing${g.listings.length === 1 ? '' : 's'}`,
    g.lastCall ? `last call ${whenText(g.lastCall.at, new Date())} (${outcomeLabel(g.lastCall.outcome).toLowerCase()})` : g.key ? 'no calls logged' : null,
  ].filter(Boolean).join(' · ');
  td.append(` · ${facts}`);
  if (g.note) {
    const note = document.createElement('div');
    note.className = 'agent-note';
    note.textContent = g.note;
    td.append(note);
  }
  tr.append(td);
  return tr;
}

const DUE_TEXT = { overdue: 'overdue', today: 'today', soon: '', later: '' };

/** The stage (changed here in place), the follow-up date and the start of the notes */
function stageCell(l: PropertyListing): HTMLTableCellElement {
  const td = document.createElement('td');
  const pipeline = pipelineOf(l, userData);

  const select = document.createElement('select');
  select.className = 'stage-select';
  select.setAttribute('aria-label', 'Stage');
  select.append(...STATUSES.map((s) => new Option(s.label, s.value)));
  select.value = pipeline?.status ?? 'new';
  select.addEventListener('change', async () => {
    try {
      // Only the stage: notes typed on the listing page meanwhile are kept
      await updatePipeline(listingKey(l), { status: select.value as PipelineStatus });
    } catch (error: any) {
      setStatus(`Could not save the stage: ${error.message}`);
    }
  });
  td.append(select);

  const state = followUpState(pipeline, localDate(new Date()));
  if (pipeline?.followUp && state) {
    const due = document.createElement('div');
    due.className = `follow-up follow-up-${state}`;
    const date = new Date(`${pipeline.followUp}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    due.textContent = `Follow up ${date}${DUE_TEXT[state] ? ` (${DUE_TEXT[state]})` : ''}`;
    td.append(due);
  }

  const labels = cleanLabels(userData[listingKey(l)]?.labels);
  if (labels.length) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.append(...labels.map((label) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = label;
      return chip;
    }));
    td.append(chips);
  }

  const call = lastCall(cleanActivity(userData[listingKey(l)]?.activity));
  if (call) {
    const called = document.createElement('div');
    called.className = 'last-call';
    called.textContent = `Called ${whenText(call.at, new Date())}`;
    called.title = outcomeLabel(call.outcome) + (call.text ? `: ${call.text}` : '');
    td.append(called);
  }

  const notes = pipeline?.notes.trim();
  if (notes) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = notes.length > 60 ? `${notes.slice(0, 60)}…` : notes;
    note.title = notes;
    td.append(note);
  }
  return td;
}

function actionsCell(l: PropertyListing): HTMLTableCellElement {
  const td = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';

  const details = document.createElement('a');
  details.className = 'btn btn-row';
  details.href = `./listing.html?key=${encodeURIComponent(listingKey(l))}`;
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

  const hidden = isHidden(l, userData);
  const hide = document.createElement('button');
  hide.className = 'btn btn-row';
  hide.textContent = hidden ? 'Unhide' : 'Hide';
  hide.title = hidden ? 'Show this home in the list again' : 'Leave this home out of the list (nothing is deleted)';
  hide.addEventListener('click', async () => {
    try {
      await setHidden(listingKey(l), !hidden);
      setStatus(hidden ? 'Shown again' : 'Hidden. Choose "Show hidden homes too" to see it.');
    } catch (error: any) {
      setStatus(`Could not save: ${error.message}`);
    }
  });
  wrap.append(hide);

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
  downloadCsv(listingsToCsv(listings, userData));
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
  const formatted = formatMoney(l.price);
  return l.listingType === 'rent' ? `${formatted} pcm` : formatted;
}

function setStatus(message: string) {
  statusEl.textContent = message;
}
