/**
 * PropSnap listing page (listing.html?key=source:listingId)
 *
 * One saved listing with the deal calculators. The numbers the user types
 * are saved per listing in the user-data store; only the ones that differ
 * from the listing's own figures are kept, so a new price still flows in.
 */
import type { PropertyListing } from '../../src/adapters/types';
import { getListings } from '../../src/services/storage';
import { getUserData, listingKey, saveDealInputs, savePipeline } from '../../src/services/user-data';
import { cleanPipeline, followUpState, localDate, STATUSES, type PipelineStatus } from '../../src/services/pipeline';
import { safeLink } from '../../src/services/dashboard-view';
import {
  brr,
  buyToLet,
  dealInputsFor,
  RATES_YEAR,
  type DealInputs,
} from '../../src/services/calculators';
import { fetchSoldPrices, type SoldPrice } from '../../src/services/land-registry';
import { describeChange, priceChange } from '../../src/services/price-history';
import { FEW_SALES, saleAddress, soldPriceArea, soldPriceView, typeChoices, TYPE_NAMES } from '../../src/services/sold-prices';

const LISTINGS_KEY = 'propsnap_listings';

const SITE_NAMES: Record<PropertyListing['source'], string> = {
  rightmove: 'Rightmove',
  zoopla: 'Zoopla',
  openrent: 'OpenRent',
};

const $ = (id: string) => document.getElementById(id)!;
const form = $('dealForm') as HTMLFormElement;
const fields = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]'));

const key = new URLSearchParams(location.search).get('key') ?? '';
let listing: PropertyListing | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pipelineTimer: ReturnType<typeof setTimeout> | undefined;
// False when the postcode is on the England and Wales border and the user has not picked a country
let regionSure = true;
// Sold prices for this listing; null until loaded
let sales: SoldPrice[] | null = null;
let soldRequest = 0;
// Most rows the sold-price table shows
const SOLD_ROWS = 50;

init();

async function init() {
  form.addEventListener('input', (event) => {
    if ((event.target as HTMLElement).dataset.field === 'region') regionSure = true;
    calculate();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  });
  form.addEventListener('submit', (event) => event.preventDefault());

  $('resetBtn').addEventListener('click', async () => {
    if (!listing) return;
    clearTimeout(saveTimer);
    try {
      await saveDealInputs(key, null);
      const fresh = dealInputsFor(listing);
      regionSure = fresh.regionSure;
      fillForm(fresh.inputs);
      setStatus('Back to the listing figures');
    } catch (error: any) {
      setStatus(`Could not reset: ${error.message}`);
    }
  });

  setUpPipeline();
  $('typeFilter').addEventListener('change', renderSold);
  $('sinceYears').addEventListener('change', renderSold);
  $('soldRefresh').addEventListener('click', loadSold);
  $('useMedian').addEventListener('click', () => {
    const value = Number(($('useMedian') as HTMLButtonElement).dataset.value);
    const input = form.querySelector<HTMLInputElement>('[data-field=valueAfterRefurb]');
    if (!input || !(value > 0)) return;
    input.value = String(Math.round(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setStatus('Value after the works set to the median sold price');
  });

  // A new capture or a delete in another tab changes the listing
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && LISTINGS_KEY in changes) loadListing(false);
  });

  await loadListing(true);
}

async function loadListing(firstLoad: boolean) {
  try {
    const found = (await getListings()).find((l) => listingKey(l) === key) ?? null;
    const before = listing;
    listing = found;
    showHeader();
    if (!listing) return;

    // Fill the form the first time, and when a new capture brings new
    // listing figures (the user's own numbers stay)
    if (firstLoad || before?.price !== listing.price || before?.postcode !== listing.postcode) {
      const prefill = dealInputsFor(listing, (await getUserData(key)).deal);
      regionSure = prefill.regionSure;
      fillForm(prefill.inputs);
    }

    // Search again when the address changes; filters keep their setting
    if (firstLoad) {
      setTypeFilter();
      fillPipeline(cleanPipeline((await getUserData(key)).pipeline));
    }
    if (firstLoad || before?.postcode !== listing.postcode || before?.fullAddress !== listing.fullAddress) {
      loadSold();
    } else {
      renderSold();
    }
  } catch (error: any) {
    setStatus(`Could not read the listing: ${error.message}`);
  }
}

function showHeader() {
  const missing = !listing;
  $('missing').hidden = !missing;
  $('calculator').hidden = missing;
  $('sold').hidden = missing;
  $('pipeline').hidden = missing;
  if (!listing) {
    $('address').textContent = 'Listing not found';
    $('facts').textContent = '';
    $('listedAs').hidden = true;
    $('openListing').hidden = true;
    return;
  }

  const address = listing.fullAddress || listing.displayAddress || 'Saved listing';
  $('address').textContent = address;
  document.title = `${address} · PropSnap`;

  const listedAs = $('listedAs');
  listedAs.hidden = !(listing.fullAddress && listing.displayAddress);
  listedAs.textContent = `Listed as: ${listing.displayAddress}`;

  $('facts').textContent = [
    SITE_NAMES[listing.source] ?? listing.source,
    listing.price ? money(listing.price) + (listing.listingType === 'rent' ? ' a month' : '') : null,
    listing.priceQualifier,
    listing.bedrooms != null ? `${listing.bedrooms} bed` : null,
    listing.propertyType,
    listing.floorAreaSqm ? `${listing.floorAreaSqm} m²` : null,
    listing.epcRating ? `EPC ${listing.epcRating}` : null,
    listing.postcode || listing.postcodePartial,
  ].filter(Boolean).join(' · ');

  showPriceHistory(listing);

  const href = safeLink(listing.url);
  const open = $('openListing') as HTMLAnchorElement;
  open.hidden = !href;
  if (href) open.href = href;
}

function setUpPipeline() {
  $('pipelineStatus').replaceChildren(...STATUSES.map((s) => {
    const option = document.createElement('option');
    option.value = s.value;
    option.textContent = s.label;
    return option;
  }));
  const later = () => {
    showDue();
    clearTimeout(pipelineTimer);
    pipelineTimer = setTimeout(saveThePipeline, 500);
  };
  $('pipelineStatus').addEventListener('change', later);
  $('pipelineFollowUp').addEventListener('change', later);
  $('pipelineNotes').addEventListener('input', later);
  $('pipelineClearDate').addEventListener('click', () => {
    ($('pipelineFollowUp') as HTMLInputElement).value = '';
    later();
  });
}

function fillPipeline(p: ReturnType<typeof cleanPipeline>) {
  ($('pipelineStatus') as HTMLSelectElement).value = p?.status ?? 'new';
  ($('pipelineFollowUp') as HTMLInputElement).value = p?.followUp ?? '';
  ($('pipelineNotes') as HTMLTextAreaElement).value = p?.notes ?? '';
  $('pipelineSaved').textContent = p?.updatedAt ? `Last saved ${new Date(p.updatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  showDue();
}

function readPipeline() {
  return {
    status: ($('pipelineStatus') as HTMLSelectElement).value as PipelineStatus,
    followUp: ($('pipelineFollowUp') as HTMLInputElement).value || null,
    notes: ($('pipelineNotes') as HTMLTextAreaElement).value,
  };
}

const DUE_TEXT = { overdue: 'Follow-up overdue', today: 'Follow up today', soon: 'Follow-up this week', later: '' };

function showDue() {
  const state = followUpState(cleanPipeline({ ...readPipeline(), updatedAt: '' }), localDate(new Date()));
  const due = $('pipelineDue');
  due.hidden = !state || state === 'later';
  due.className = `due due-${state}`;
  due.textContent = state ? DUE_TEXT[state] : '';
}

async function saveThePipeline() {
  try {
    await savePipeline(key, readPipeline());
    $('pipelineSaved').textContent = 'Saved';
  } catch (error: any) {
    $('pipelineSaved').textContent = `Could not save: ${error.message}`;
  }
}

/** How the price moved between captures; hidden until it has */
function showPriceHistory(l: PropertyListing) {
  const change = priceChange(l);
  $('priceHistory').hidden = !change;
  if (!change) return;

  const line = $('priceChangeLine');
  line.className = `price-change price-${change.direction}`;
  line.textContent = `${describeChange(change)} since ${shortDate(change.first.seenAt)}, from ${money(change.first.price!)}`;

  const suffix = l.listingType === 'rent' ? ' a month' : '';
  const points = l.priceHistory ?? [];
  $('priceHistoryRows').replaceChildren(...points.map((p, i) => {
    const tr = document.createElement('tr');
    const before = points.slice(0, i).reverse().find((q) => q.price);
    const step = p.price && before?.price ? p.price - before.price : 0;
    const cells = [
      shortDate(p.seenAt),
      p.price ? `${money(p.price)}${suffix}` : 'No price',
      p.qualifier ?? '',
      step ? `${step > 0 ? '+' : '−'}${money(Math.abs(step))}` : '',
    ];
    cells.forEach((text, n) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (n === 1 || n === 3) td.className = 'num';
      if (n === 3 && step) td.classList.add(step < 0 ? 'price-reduced' : 'price-increased');
      tr.append(td);
    });
    return tr;
  }));
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fillForm(inputs: DealInputs) {
  for (const el of fields) {
    el.value = String(inputs[el.dataset.field as keyof DealInputs]);
  }
  calculate();
}

function readForm(): DealInputs {
  const inputs = {} as Record<string, string | number>;
  for (const el of fields) {
    const field = el.dataset.field!;
    if (el instanceof HTMLInputElement) {
      const value = el.valueAsNumber;
      inputs[field] = Number.isFinite(value) && value > 0 ? value : 0;
    } else {
      inputs[field] = el.value;
    }
  }
  return inputs as unknown as DealInputs;
}

async function save() {
  if (!listing) return;
  const current = readForm();
  const fromListing = dealInputsFor(listing);
  // Keep only what the user changed
  const changed: Partial<DealInputs> = {};
  for (const field of Object.keys(current) as (keyof DealInputs)[]) {
    if (current[field] !== fromListing.inputs[field]) (changed as Record<string, unknown>)[field] = current[field];
  }
  // On a border postcode, a country the user confirmed is kept even when it matches the guess
  if (!fromListing.regionSure && regionSure) changed.region = current.region;
  try {
    await saveDealInputs(key, Object.keys(changed).length > 0 ? changed : null);
    setStatus('Saved');
  } catch (error: any) {
    setStatus(`Could not save: ${error.message}`);
  }
}

function calculate() {
  if (!listing) return;
  const inputs = readForm();
  $('regionHint').hidden = regionSure;

  // With no price the figures mean nothing, so ask for one instead
  const hasPrice = inputs.price > 0;
  $('needPrice').hidden = hasPrice;
  for (const card of document.querySelectorAll<HTMLElement>('.results .card')) card.hidden = !hasPrice;
  for (const hint of document.querySelectorAll<HTMLElement>('.need-rent')) hint.hidden = inputs.rentMonthly > 0;
  if (!hasPrice) return;

  const btl = buyToLet(inputs);
  const tax = btl.tax;
  $('taxName').textContent = tax.name;
  $('taxTotal').textContent = money(tax.total);
  $('taxSlices').replaceChildren(...tax.slices.map((s) => {
    const tr = document.createElement('tr');
    const band = document.createElement('td');
    band.textContent = `${money(s.from)} to ${money(s.to)}`;
    const rate = document.createElement('td');
    rate.className = 'num';
    rate.textContent = `${s.rate}%`;
    const amount = document.createElement('td');
    amount.className = 'num';
    amount.textContent = money(s.tax);
    tr.append(band, rate, amount);
    return tr;
  }));
  $('taxNote').hidden = !tax.note;
  $('taxNote').textContent = tax.note ?? '';
  $('taxYear').textContent = `${RATES_YEAR} rates. Check ${inputs.region === 'wales' ? 'the Welsh Revenue Authority' : 'GOV.UK'} before you buy.`;

  rows($('btlRows'), [
    ['Gross yield', pct(btl.grossYieldPct)],
    ['Net yield (before mortgage)', pct(btl.netYieldPct)],
    ['Deposit', money(btl.deposit)],
    ['Mortgage', money(btl.loan)],
    ['Mortgage payment', `${money(btl.mortgageMonthly)} a month`],
    ['Running costs', `${money(btl.runningCostsMonthly)} a month`],
    ['Cashflow', `${money(btl.cashflowMonthly)} a month`, btl.cashflowMonthly < 0],
    ['Cash you put in', money(btl.cashInvested), false, 'Deposit, tax, legal fees and survey'],
    ['Return on your cash', btl.returnOnCashPct == null ? '—' : pct(btl.returnOnCashPct), (btl.returnOnCashPct ?? 0) < 0],
  ]);

  // No value after the works typed yet: take the purchase price
  const deal = brr({ ...inputs, valueAfterRefurb: inputs.valueAfterRefurb || inputs.price });
  rows($('brrRows'), [
    ['Cash you put in', money(deal.cashIn), false, 'Deposit, tax, legal fees, survey and the works'],
    ['New mortgage', money(deal.refinanceLoan)],
    ['Cash you take back out', money(deal.cashReleased), deal.cashReleased < 0, 'New mortgage minus the first mortgage'],
    ['Money left in the deal', deal.moneyLeftIn <= 0 ? `None (${money(-deal.moneyLeftIn)} more out than in)` : money(deal.moneyLeftIn)],
    ['Mortgage payment', `${money(deal.mortgageMonthly)} a month`],
    ['Cashflow', `${money(deal.cashflowMonthly)} a month`, deal.cashflowMonthly < 0],
    ['Return on money left in', deal.returnOnMoneyLeftPct == null ? 'No money left in' : pct(deal.returnOnMoneyLeftPct), (deal.returnOnMoneyLeftPct ?? 0) < 0],
  ]);
}

function setTypeFilter() {
  if (!listing) return;
  // The closest match comes first and is picked
  $('typeFilter').replaceChildren(...typeChoices(listing.propertyType).map((choice) => {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    return option;
  }));
}

async function loadSold() {
  if (!listing) return;
  const request = ++soldRequest;
  const area = soldPriceArea(listing);
  sales = null;

  const where = [
    area.postcode ? `in ${area.postcode}` : null,
    area.street && area.outcode ? `on ${titleCase(area.street)} (${area.outcode})` : null,
  ].filter(Boolean);
  $('soldWhere').textContent = where.length ? `Sales ${where.join(' and ')}.` : '';

  if (where.length === 0) {
    showSoldStatus('PropSnap needs the full postcode or the street name to find sold prices, and this listing has neither.');
    return;
  }

  showSoldStatus('Asking HM Land Registry…');
  try {
    const found = await fetchSoldPrices(area);
    if (request !== soldRequest) return;
    sales = found;
    renderSold();
  } catch (error: any) {
    if (request !== soldRequest) return;
    showSoldStatus(`Could not get sold prices from HM Land Registry: ${error.message}. Click Refresh to try again.`);
  }
}

function showSoldStatus(message: string) {
  $('soldStatus').textContent = message;
  $('soldStatus').hidden = false;
  $('soldBody').hidden = true;
}

function renderSold() {
  if (!listing || !sales) return;
  if (sales.length === 0) {
    showSoldStatus('HM Land Registry has no sales here. New streets, and homes not sold since 1995, have none.');
    return;
  }

  const choice = ($('typeFilter') as HTMLSelectElement).value;
  const years = ($('sinceYears') as HTMLSelectElement).value;
  const view = soldPriceView(sales, listing, {
    types: typeChoices(listing.propertyType).find((c) => c.value === choice)?.types ?? null,
    sinceYears: years ? Number(years) : null,
    today: new Date(),
  });

  $('soldStatus').hidden = true;
  $('soldBody').hidden = false;

  $('soldMedian').textContent = view.median == null ? '—' : money(view.median);
  $('soldRange').textContent = view.low == null ? '—' : view.low === view.high ? money(view.low) : `${money(view.low)} to ${money(view.high!)}`;
  $('soldCount').textContent = String(view.comparables.length);
  const used = view.comparables.filter((s) => s.standard).length;
  $('soldCountLabel').textContent = used === view.comparables.length ? 'Sales' : `Sales (${used} used in the figures)`;

  // A median from one or two sales is not worth much; say so
  const few = $('fewSales');
  few.hidden = used === 0 || used >= FEW_SALES;
  few.textContent = `Only ${used} sale${used === 1 ? '' : 's'} in the figures, so this is weak evidence. Try more years${choice === 'all' ? '' : ' or a wider type'}.`;
  const asking = $('soldAsking');
  asking.textContent = view.askingVsMedianPct == null
    ? '—'
    : `${view.askingVsMedianPct > 0 ? '+' : ''}${view.askingVsMedianPct.toFixed(1)}%`;
  asking.title = view.askingVsMedianPct == null ? 'Shown for sale listings with a price' : 'Above zero: asking more than the median';

  const useMedian = $('useMedian') as HTMLButtonElement;
  useMedian.hidden = view.median == null;
  useMedian.dataset.value = String(view.median ?? '');

  $('thisHome').hidden = view.thisHome.length === 0;
  $('thisHomeList').replaceChildren(...view.thisHome.map((s) => {
    const li = document.createElement('li');
    li.textContent = `${money(s.price)} in ${monthYear(s.date)}${s.standard ? '' : ' (not a standard sale)'}`;
    return li;
  }));
  $('thisHomeNote').hidden = listing.addressConfidence !== 'best_guess';

  const shown = view.comparables.slice(0, SOLD_ROWS);
  const postcode = soldPriceArea(listing).postcode;
  $('soldRows').replaceChildren(...shown.map((s) => soldRow(s, postcode)));
  const more = $('soldMore');
  more.hidden = view.comparables.length <= SOLD_ROWS;
  more.textContent = `Showing the newest ${SOLD_ROWS} of ${view.comparables.length} sales. The figures above use all of them.`;
  if (view.comparables.length === 0) {
    $('soldRows').replaceChildren(emptyRow('No sales match these filters. Try more years or all types.'));
  }
}

function soldRow(s: SoldPrice, postcode: string | null): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const notes: string[] = [];
  if (postcode && s.postcode === postcode) notes.push('Same postcode');
  if (s.newBuild) notes.push('New build');
  if (!s.standard) notes.push('Not a standard sale');

  const cells = [
    [monthYear(s.date), 'nowrap'],
    [`${saleAddress(s)}${s.postcode ? ` ${s.postcode}` : ''}`, ''],
    [TYPE_NAMES[s.propertyType], ''],
    [s.tenure ? s.tenure.charAt(0).toUpperCase() + s.tenure.slice(1) : '—', ''],
    [money(s.price), 'num nowrap'],
  ] as const;
  for (const [value, className] of cells) {
    const td = document.createElement('td');
    td.textContent = value;
    if (className) td.className = className;
    tr.append(td);
  }

  const noteCell = document.createElement('td');
  for (const note of notes) {
    const badge = document.createElement('span');
    badge.className = note === 'Not a standard sale' ? 'tag tag-warn' : 'tag';
    badge.textContent = note;
    if (note === 'Not a standard sale') badge.title = 'For example a repossession or a sale to a company. Not used in the figures.';
    noteCell.append(badge);
  }
  tr.append(noteCell);
  return tr;
}

function emptyRow(message: string): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 6;
  td.className = 'muted';
  td.textContent = message;
  tr.append(td);
  return tr;
}

function monthYear(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

type Row = [label: string, value: string, bad?: boolean, help?: string];

function rows(list: HTMLElement, items: Row[]) {
  list.replaceChildren(...items.flatMap(([label, value, bad, help]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    if (help) dt.title = help;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (bad) dd.className = 'bad';
    return [dt, dd];
  }));
}

function money(value: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(Math.round(value));
}

function pct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function setStatus(message: string) {
  $('status').textContent = message;
}
