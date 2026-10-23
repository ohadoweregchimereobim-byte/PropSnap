/**
 * PropSnap listing page (listing.html?key=source:listingId)
 *
 * One saved listing with the deal calculators. The numbers the user types
 * are saved per listing in the user-data store; only the ones that differ
 * from the listing's own figures are kept, so a new price still flows in.
 */
import type { PropertyListing } from '../../src/adapters/types';
import { getListings } from '../../src/services/storage';
import { getUserData, listingKey, saveDealInputs } from '../../src/services/user-data';
import { safeLink } from '../../src/services/dashboard-view';
import {
  brr,
  buyToLet,
  dealInputsFor,
  RATES_YEAR,
  type DealInputs,
} from '../../src/services/calculators';

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
// False when the postcode is on the England and Wales border and the user has not picked a country
let regionSure = true;

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
  } catch (error: any) {
    setStatus(`Could not read the listing: ${error.message}`);
  }
}

function showHeader() {
  const missing = !listing;
  $('missing').hidden = !missing;
  $('calculator').hidden = missing;
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

  const href = safeLink(listing.url);
  const open = $('openListing') as HTMLAnchorElement;
  open.hidden = !href;
  if (href) open.href = href;
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
