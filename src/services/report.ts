import type { PropertyListing } from '../adapters/types';
import type { BrrResult, BuyToLetResult, DealInputs } from './calculators';
import { describeChange, priceChange } from './price-history';
import { statusLabel, type Pipeline } from './pipeline';
import { FEW_SALES, saleAddress, TYPE_NAMES, type SoldPriceView } from './sold-prices';

/**
 * The property report: what the listing page knows, laid out for print or
 * PDF. Pure, so the content is unit tested; the page turns it into HTML.
 */

export interface ReportTable {
  head: string[];
  /** Columns to right-align (numbers) */
  numeric: number[];
  rows: string[][];
}

export interface ReportSection {
  heading: string;
  rows?: Array<[label: string, value: string]>;
  table?: ReportTable;
  notes?: string[];
  /** Free text kept as the user wrote it (line breaks too) */
  text?: string;
}

export interface Report {
  title: string;
  subtitle: string;
  sections: ReportSection[];
  footer: string;
}

export interface ReportInput {
  listing: PropertyListing;
  /** The sold prices as filtered on the page; null when not loaded */
  sold: { view: SoldPriceView; where: string; filters: string } | null;
  deal: { inputs: DealInputs; btl: BuyToLetResult; brr: BrrResult };
  pipeline: Pipeline | null;
  includeNotes: boolean;
  generatedAt: Date;
}

const SITE_NAMES: Record<PropertyListing['source'], string> = { rightmove: 'Rightmove', zoopla: 'Zoopla', openrent: 'OpenRent' };
const SOLD_ROWS = 20;

const money = (n: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(Math.round(n));
const pct = (n: number) => `${n.toFixed(2)}%`;
const date = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const monthYear = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

function compact(rows: Array<[string, string | null | undefined | false]>): Array<[string, string]> {
  return rows.filter((r): r is [string, string] => typeof r[1] === 'string' && r[1].trim() !== '');
}

function propertySection(l: PropertyListing): ReportSection {
  const address = l.fullAddress
    ? `${l.fullAddress}${l.addressConfidence === 'best_guess' ? ' (best guess from the EPC register)' : ''}`
    : null;
  const price = l.price
    ? `${l.priceQualifier ? `${l.priceQualifier} ` : ''}${money(l.price)}${l.listingType === 'rent' ? ' a month' : ''}`
    : null;
  return {
    heading: 'Property',
    rows: compact([
      ['Address', address ?? l.displayAddress],
      ['Listed as', l.fullAddress ? l.displayAddress : null],
      ['Postcode', l.postcode || l.postcodePartial],
      [l.listingType === 'rent' ? 'Rent' : 'Asking price', price],
      ['Bedrooms', l.bedrooms != null ? String(l.bedrooms) : null],
      ['Type', l.propertyType],
      ['Floor area', l.floorAreaSqm ? `${l.floorAreaSqm} m²${l.floorAreaSource === 'text' ? ' (from the description)' : ''}` : null],
      ['EPC rating', l.epcRating],
      ['Tenure', l.tenure],
      ['Furnished', l.furnished],
      ['Deposit', l.deposit ? money(l.deposit) : null],
      ['Agent', [l.agentName, l.agentBranch].filter(Boolean).join(', ') || null],
      ['Agent phone', l.agentPhone],
      ['Listing', `${SITE_NAMES[l.source] ?? l.source}: ${l.url}`],
      ['Captured', date(l.capturedAt)],
    ]),
  };
}

function priceSection(l: PropertyListing): ReportSection | null {
  const change = priceChange(l);
  if (!change) return null;
  const points = l.priceHistory ?? [];
  return {
    heading: 'Price history',
    notes: [`${describeChange(change)} since ${date(change.first.seenAt)}, from ${money(change.first.price!)}.`],
    table: {
      head: ['Seen', 'Price', ''],
      numeric: [1],
      rows: points.map((p) => [date(p.seenAt), p.price ? money(p.price) : 'No price', p.qualifier ?? '']),
    },
  };
}

function soldSection(sold: NonNullable<ReportInput['sold']>, l: PropertyListing): ReportSection {
  const { view } = sold;
  const used = view.comparables.filter((s) => s.standard).length;
  const notes = [sold.where, `Filters: ${sold.filters}.`];
  if (used > 0 && used < FEW_SALES) notes.push(`Only ${used} sale${used === 1 ? '' : 's'} in the figures, so this is weak evidence.`);
  if (view.thisHome.length) {
    notes.push(`This home sold before: ${view.thisHome.map((s) => `${money(s.price)} in ${monthYear(s.date)}`).join('; ')}`
      + `${l.addressConfidence === 'best_guess' ? ' (based on the best-guess address)' : ''}.`);
  }
  if (view.comparables.length > SOLD_ROWS) notes.push(`The table shows the newest ${SOLD_ROWS} of ${view.comparables.length} sales; the figures use all of them.`);
  if (view.comparables.some((s) => !s.standard)) notes.push('Prices marked * are not standard sales (for example repossessions or sales to companies) and are left out of the figures.');
  notes.push('Contains HM Land Registry data © Crown copyright and database right, licensed under the Open Government Licence v3.0.');

  return {
    heading: 'Sold prices nearby',
    rows: compact([
      ['Median sold price', view.median != null ? money(view.median) : '—'],
      ['Lowest to highest', view.low != null ? (view.low === view.high ? money(view.low) : `${money(view.low)} to ${money(view.high!)}`) : '—'],
      ['Sales', used === view.comparables.length ? String(used) : `${view.comparables.length} (${used} used in the figures)`],
      ['Asking price against the median', view.askingVsMedianPct != null ? `${view.askingVsMedianPct > 0 ? '+' : ''}${view.askingVsMedianPct.toFixed(1)}%` : null],
    ]),
    table: view.comparables.length
      ? {
        head: ['Sold', 'Address', 'Type', 'Price'],
        numeric: [3],
        rows: view.comparables.slice(0, SOLD_ROWS).map((s) => [
          monthYear(s.date),
          `${saleAddress(s)}${s.postcode ? ` ${s.postcode}` : ''}`,
          TYPE_NAMES[s.propertyType],
          `${money(s.price)}${s.standard ? '' : ' *'}`,
        ]),
      }
      : undefined,
    notes,
  };
}

function dealSections({ inputs, btl, brr }: ReportInput['deal']): ReportSection[] {
  if (!(inputs.price > 0)) return [];
  const mortgage = `${inputs.depositPct}% deposit, ${inputs.ratePct}% a year, ${inputs.mortgageType === 'interest_only' ? 'interest only' : `repayment over ${inputs.termYears} years`}`;
  const sections: ReportSection[] = [{
    heading: 'Purchase and buy-to-let',
    rows: compact([
      ['Price used', money(inputs.price)],
      [btl.tax.name, `${money(btl.tax.total)}${btl.tax.note ? ` (${btl.tax.note})` : ''}`],
      ['Legal fees and survey', money(inputs.buyingCosts)],
      ['Mortgage', `${money(btl.loan)}: ${mortgage}`],
      ['Mortgage payment', `${money(btl.mortgageMonthly)} a month`],
      ['Rent', inputs.rentMonthly > 0 ? `${money(inputs.rentMonthly)} a month` : 'Not entered'],
      ['Running costs', inputs.rentMonthly > 0 ? `${money(btl.runningCostsMonthly)} a month (agent ${inputs.managementPct}%, repairs and empty months ${inputs.maintenancePct}%, other ${money(inputs.otherMonthly)})` : null],
      ['Gross yield', inputs.rentMonthly > 0 ? pct(btl.grossYieldPct) : null],
      ['Net yield (before mortgage)', inputs.rentMonthly > 0 ? pct(btl.netYieldPct) : null],
      ['Cashflow', inputs.rentMonthly > 0 ? `${money(btl.cashflowMonthly)} a month` : null],
      ['Cash put in', money(btl.cashInvested)],
      ['Return on cash', inputs.rentMonthly > 0 && btl.returnOnCashPct != null ? pct(btl.returnOnCashPct) : null],
    ]),
  }];

  // Only when the user has planned works or a new value
  if (inputs.refurbCost > 0 || (inputs.valueAfterRefurb > 0 && inputs.valueAfterRefurb !== inputs.price)) {
    sections.push({
      heading: 'Buy, refurbish, refinance',
      rows: compact([
        ['Refurbishment', money(inputs.refurbCost)],
        ['Value after the works', money(inputs.valueAfterRefurb || inputs.price)],
        ['Cash put in', money(brr.cashIn)],
        ['New mortgage', `${money(brr.refinanceLoan)} (${inputs.refinanceLtvPct}% of the new value)`],
        ['Cash taken back out', money(brr.cashReleased)],
        ['Money left in the deal', brr.moneyLeftIn <= 0 ? 'None' : money(brr.moneyLeftIn)],
        ['Cashflow', inputs.rentMonthly > 0 ? `${money(brr.cashflowMonthly)} a month` : null],
        ['Return on money left in', inputs.rentMonthly > 0 && brr.returnOnMoneyLeftPct != null ? pct(brr.returnOnMoneyLeftPct) : null],
      ]),
    });
  }
  return sections;
}

export function buildReport(input: ReportInput): Report {
  const l = input.listing;
  const sections: ReportSection[] = [propertySection(l)];

  const prices = priceSection(l);
  if (prices) sections.push(prices);
  if (input.sold) sections.push(soldSection(input.sold, l));
  sections.push(...dealSections(input.deal));

  if (input.includeNotes && input.pipeline) {
    sections.push({
      heading: 'Deal notes',
      rows: compact([
        ['Stage', statusLabel(input.pipeline.status)],
        ['Follow up', input.pipeline.followUp ? date(`${input.pipeline.followUp}T12:00:00Z`) : null],
      ]),
      text: input.pipeline.notes.trim() || undefined,
    });
  }

  const facts = [
    l.bedrooms != null ? `${l.bedrooms} bed` : null,
    l.propertyType,
    l.price ? `${money(l.price)}${l.listingType === 'rent' ? ' a month' : ''}` : null,
  ].filter(Boolean).join(' · ');

  return {
    title: l.fullAddress || l.displayAddress || 'Property report',
    subtitle: facts,
    sections,
    footer: `Property report made with PropSnap on ${date(input.generatedAt.toISOString())}. `
      + 'Figures are estimates from the listing, public records and your own numbers. Not financial or tax advice.',
  };
}
