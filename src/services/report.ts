import type { PropertyListing } from '../adapters/types';
import { formatMoney, SITE_NAMES } from './format';
import { customCostTotals, sourcingFee, type BrrResult, type BuyToLetResult, type DealInputs, type FlipResult, type HmoResult } from './calculators';
import { headingColour, isBranded, type Branding } from './branding';
import { FLOOD_WORDS, type AreaChecks } from './area-checks';
import { daysOnMarket, describeChange, describePortalChanges, priceChange } from './price-history';
import { statusLabel, type Pipeline } from './pipeline';
import { FEW_SALES, FLIP_MIN_RISE_PCT, FLIP_MONTHS, median, saleAddress, TYPE_NAMES, type SoldPriceView } from './sold-prices';
import { bandForScore, describeEnergy, lowWithPotential } from './epc-energy';
import { timeline, type Activity } from './crm';

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

export interface ReportBrand {
  company: string;
  contact: string;
  logo: string | null;
  /** For the bar at the top */
  colour: string;
  /** For headings: the brand colour, or dark grey when it is too light to read */
  headingColour: string;
}

export interface Report {
  title: string;
  subtitle: string;
  sections: ReportSection[];
  footer: string;
  brand: ReportBrand | null;
}

/** Which deal calculators go in the report */
export interface Strategies {
  btl: boolean;
  brr: boolean;
  flip: boolean;
  hmo: boolean;
}

/** Buy-to-let always; BRR and flip once works or a new value are typed; HMO once rooms and a room rent are */
export function defaultStrategies(i: DealInputs): Strategies {
  const works = i.refurbCost > 0 || (i.valueAfterRefurb > 0 && i.valueAfterRefurb !== i.price);
  return { btl: true, brr: works, flip: works, hmo: i.hmoRooms > 0 && i.hmoRoomRent > 0 };
}

export interface ReportInput {
  listing: PropertyListing;
  /** The sold prices as filtered on the page; null when not loaded */
  sold: { view: SoldPriceView; where: string; filters: string } | null;
  deal: { inputs: DealInputs; btl: BuyToLetResult; brr: BrrResult; flip?: FlipResult; hmo?: HmoResult; show?: Strategies };
  pipeline: Pipeline | null;
  /** The user's labels and activity; shown with the notes */
  labels?: string[];
  activity?: Activity[];
  includeNotes: boolean;
  generatedAt: Date;
  branding?: Branding | null;
  /** The area checks shown on the page, and what each rights code means */
  area?: { checks: AreaChecks; rightsNames: Record<string, string>; wales: boolean } | null;
}

const SOLD_ROWS = 20;
const TIMELINE_ROWS = 15;

const pct = (n: number) => `${n.toFixed(2)}%`;
const date = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const monthYear = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

function compact(rows: Array<[string, string | null | undefined | false]>): Array<[string, string]> {
  return rows.filter((r): r is [string, string] => typeof r[1] === 'string' && r[1].trim() !== '');
}

/** "Since 6 Mar 2026 (232 days, Zoopla's date)" */
function onMarket(l: PropertyListing, today: Date): string | null {
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const days = daysOnMarket(l, ymd);
  return l.listedOn && days != null ? `Since ${date(`${l.listedOn}T12:00:00Z`)} (${days} day${days === 1 ? '' : 's'}, ${SITE_NAMES[l.source]}'s date)` : null;
}

function propertySection(l: PropertyListing, generatedAt: Date): ReportSection {
  const address = l.fullAddress
    ? `${l.fullAddress}${l.addressConfidence === 'best_guess' ? ' (best guess from the EPC register)' : ''}`
    : null;
  const price = l.price
    ? `${l.priceQualifier ? `${l.priceQualifier} ` : ''}${formatMoney(l.price)}${l.listingType === 'rent' ? ' a month' : ''}`
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
      ['EPC certificate', l.epcEnergy
        ? `${describeEnergy(l.epcEnergy)}, now to potential${l.epcEnergy.registrationDate ? ` (certificate ${date(l.epcEnergy.registrationDate)})` : ''}`
          + `${l.addressConfidence === 'best_guess' ? ', for the best-guess home' : ''}`
        : null],
      ['Tenure', l.tenure],
      ['Furnished', l.furnished],
      ['Deposit', l.deposit ? formatMoney(l.deposit) : null],
      ['Agent', [l.agentName, l.agentBranch].filter(Boolean).join(', ') || null],
      ['Agent phone', l.agentPhone],
      ['Listing', `${SITE_NAMES[l.source] ?? l.source}: ${l.url}`],
      ['On the market', onMarket(l, generatedAt)],
      ['Captured', date(l.capturedAt)],
    ]),
  };
}

function priceSection(l: PropertyListing): ReportSection | null {
  const change = priceChange(l);
  const portal = describePortalChanges(l);
  if (!change && !portal) return null;
  const points = l.priceHistory ?? [];
  return {
    heading: 'Price history',
    notes: [
      change ? `${describeChange(change)} since ${date(change.first.seenAt)}, from ${formatMoney(change.first.price!)}.` : null,
      portal ? `${portal} (the site does not show the amounts).` : null,
    ].filter((n): n is string => n !== null),
    table: change ? {
      head: ['Seen', 'Price', ''],
      numeric: [1],
      rows: points.map((p) => [date(p.seenAt), p.price ? formatMoney(p.price) : 'No price', p.qualifier ?? '']),
    } : undefined,
  };
}

function soldSection(sold: NonNullable<ReportInput['sold']>, l: PropertyListing): ReportSection {
  const { view } = sold;
  const used = view.comparables.filter((s) => s.standard).length;
  const notes = [sold.where, `Filters: ${sold.filters}.`];
  if (used > 0 && used < FEW_SALES) notes.push(`Only ${used} sale${used === 1 ? '' : 's'} in the figures, so this is weak evidence.`);
  if (view.thisHome.length) {
    notes.push(`This home sold before: ${view.thisHome.map((s) => `${formatMoney(s.price)} in ${monthYear(s.date)}`).join('; ')}`
      + `${l.addressConfidence === 'best_guess' ? ' (based on the best-guess address)' : ''}.`);
  }
  if (view.comparables.length > SOLD_ROWS) notes.push(`The table shows the newest ${SOLD_ROWS} of ${view.comparables.length} sales; the figures use all of them.`);
  if (view.comparables.some((s) => !s.standard)) notes.push('Prices marked * are not standard sales (for example repossessions or sales to companies) and are left out of the figures.');
  notes.push('Contains HM Land Registry data © Crown copyright and database right, licensed under the Open Government Licence v3.0.');

  return {
    heading: 'Sold prices nearby',
    rows: compact([
      ['Median sold price', view.median != null ? formatMoney(view.median) : '—'],
      ['Lowest to highest', view.low != null ? (view.low === view.high ? formatMoney(view.low) : `${formatMoney(view.low)} to ${formatMoney(view.high!)}`) : '—'],
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
          `${formatMoney(s.price)}${s.standard ? '' : ' *'}`,
        ]),
      }
      : undefined,
    notes,
  };
}

function costLines(i: DealInputs): Array<[string, string | null]> {
  const fee = sourcingFee(i);
  const once = i.customCosts.filter((c) => c.when === 'once');
  const monthly = i.customCosts.filter((c) => c.when === 'monthly');
  const list = (costs: typeof once) => costs.map((c) => `${c.name} ${formatMoney(c.amount)}`).join(', ');
  return [
    ['Sourcing fee', fee > 0 ? `${formatMoney(fee)}${i.sourcingFeeType === 'pct' ? ` (${i.sourcingFee}% of the price)` : ''}` : null],
    ['Other one-off costs', once.length ? list(once) : null],
    ['Other monthly costs', monthly.length ? `${list(monthly)} (${formatMoney(customCostTotals(i.customCosts).monthly)} a month)` : null],
  ];
}

function dealSections({ inputs, btl, brr, flip, hmo, show = defaultStrategies(inputs) }: ReportInput['deal']): ReportSection[] {
  if (!(inputs.price > 0)) return [];
  const mortgage = `${inputs.depositPct}% deposit, ${inputs.ratePct}% a year, ${inputs.mortgageType === 'interest_only' ? 'interest only' : `repayment over ${inputs.termYears} years`}`;
  const purchase: Array<[string, string | null]> = [
    ['Price used', formatMoney(inputs.price)],
    [btl.tax.name, `${formatMoney(btl.tax.total)}${btl.tax.note ? ` (${btl.tax.note})` : ''}`],
    ['Legal fees and survey', formatMoney(inputs.buyingCosts)],
    ...costLines(inputs),
  ];
  const sections: ReportSection[] = [];

  if (show.btl) {
    sections.push({
      heading: 'Purchase and buy-to-let',
      rows: compact([
        ...purchase,
        ['Mortgage', `${formatMoney(btl.loan)}: ${mortgage}`],
        ['Mortgage payment', `${formatMoney(btl.mortgageMonthly)} a month`],
        ['Rent', inputs.rentMonthly > 0 ? `${formatMoney(inputs.rentMonthly)} a month` : 'Not entered'],
        ['Running costs', inputs.rentMonthly > 0 ? `${formatMoney(btl.runningCostsMonthly)} a month (agent ${inputs.managementPct}%, repairs and empty months ${inputs.maintenancePct}%${customCostTotals(inputs.customCosts).monthly > 0 ? ', your monthly costs' : ''})` : null],
        ['Gross yield', inputs.rentMonthly > 0 ? pct(btl.grossYieldPct) : null],
        ['Net yield (before mortgage)', inputs.rentMonthly > 0 ? pct(btl.netYieldPct) : null],
        ['Cashflow', inputs.rentMonthly > 0 ? `${formatMoney(btl.cashflowMonthly)} a month` : null],
        ['Cash put in', formatMoney(btl.cashInvested)],
        ['Return on cash', inputs.rentMonthly > 0 && btl.returnOnCashPct != null ? pct(btl.returnOnCashPct) : null],
      ]),
    });
  } else {
    sections.push({ heading: 'Purchase', rows: compact(purchase) });
  }

  if (show.brr) {
    sections.push({
      heading: 'Buy, refurbish, refinance',
      rows: compact([
        ['Refurbishment', formatMoney(inputs.refurbCost)],
        ['Value after the works', formatMoney(inputs.valueAfterRefurb || inputs.price)],
        ['Cash put in', formatMoney(brr.cashIn)],
        ['New mortgage', `${formatMoney(brr.refinanceLoan)} (${inputs.refinanceLtvPct}% of the new value)`],
        ['Cash taken back out', formatMoney(brr.cashReleased)],
        ['Money left in the deal', brr.moneyLeftIn <= 0 ? 'None' : formatMoney(brr.moneyLeftIn)],
        ['Cashflow', inputs.rentMonthly > 0 ? `${formatMoney(brr.cashflowMonthly)} a month` : null],
        ['Return on money left in', inputs.rentMonthly > 0 && brr.returnOnMoneyLeftPct != null ? pct(brr.returnOnMoneyLeftPct) : null],
      ]),
    });
  }

  if (show.flip && flip) {
    sections.push({
      heading: 'Flip (buy, do up and sell)',
      rows: compact([
        ['Works', formatMoney(inputs.refurbCost)],
        ['Sale price', formatMoney(flip.salePrice)],
        ['Months held', String(inputs.flipMonths)],
        ['Bridging loan', flip.loan > 0
          ? `${formatMoney(flip.loan)} (${inputs.bridgingPct}% of the price, ${inputs.bridgingRatePct}% a month, fees ${inputs.bridgingFeesPct}%)`
          : 'None, bought with cash'],
        ['Finance costs', flip.loan > 0 ? formatMoney(flip.financeCost) : null],
        ['Holding costs', formatMoney(flip.holdingCost)],
        ['Selling costs', `${formatMoney(flip.sellingCost)} (agent ${inputs.sellingFeePct}%, legal ${formatMoney(inputs.saleLegalFees)})`],
        ['Total cost', formatMoney(flip.totalCost)],
        ['Profit before tax', formatMoney(flip.profit)],
        ['Profit on cost', flip.profitOnCostPct != null ? pct(flip.profitOnCostPct) : null],
        ['Cash needed', formatMoney(flip.cashNeeded)],
        ['Return on cash', flip.returnOnCashPct != null ? pct(flip.returnOnCashPct) : null],
      ]),
    });
  }

  if (show.hmo && hmo && inputs.hmoRooms > 0) {
    sections.push({
      heading: 'HMO (let by the room)',
      rows: compact([
        ['Rooms', `${inputs.hmoRooms} at ${formatMoney(inputs.hmoRoomRent)} a month`],
        ['Rent', `${formatMoney(hmo.rentMonthly)} a month`],
        ['Bills', `${formatMoney(hmo.billsMonthly)} a month`],
        ['Licence', inputs.hmoLicenceCost > 0 ? `${formatMoney(inputs.hmoLicenceCost)} for ${inputs.hmoLicenceYears} years (${formatMoney(hmo.licenceMonthly)} a month)` : null],
        ['Running costs', `${formatMoney(hmo.runningCostsMonthly)} a month (management ${inputs.hmoManagementPct}%, repairs and empty rooms ${inputs.maintenancePct}%, bills${inputs.hmoLicenceCost > 0 ? ', licence' : ''}${customCostTotals(inputs.customCosts).monthly > 0 ? ', your monthly costs' : ''})`],
        ['Mortgage payment', `${formatMoney(hmo.mortgageMonthly)} a month (${mortgage})`],
        ['Conversion works', inputs.refurbCost > 0 ? formatMoney(inputs.refurbCost) : null],
        ['Gross yield', pct(hmo.grossYieldPct)],
        ['Net yield (before mortgage)', pct(hmo.netYieldPct)],
        ['Cashflow', `${formatMoney(hmo.cashflowMonthly)} a month${hmo.cashflowPerRoom != null ? ` (${formatMoney(hmo.cashflowPerRoom)} a room)` : ''}`],
        ['Cash put in', formatMoney(hmo.cashInvested)],
        ['Return on cash', hmo.returnOnCashPct != null ? pct(hmo.returnOnCashPct) : null],
      ]),
    });
  }
  return sections;
}

function energySection(l: PropertyListing): ReportSection | null {
  const e = l.epcEnergy;
  if (!e || e.improvements.length === 0) return null;
  return {
    heading: 'Energy improvements',
    notes: [
      ...(lowWithPotential(e) ? ['Low rating with high potential: priced for its rating today, and lettable once improved.'] : []),
      'From the home\'s EPC certificate. Costs and savings are the assessor\'s typical figures from when the certificate was made.',
    ],
    table: {
      head: ['Improvement', 'Typical cost', 'Saving a year', 'Rating after'],
      numeric: [2, 3],
      rows: e.improvements.map((i) => [
        i.name,
        i.cost ?? '—',
        i.saving != null ? formatMoney(i.saving) : '—',
        i.ratingAfter != null ? `${i.ratingAfter} (${bandForScore(i.ratingAfter)})` : '—',
      ]),
    },
  };
}

function flipSection(sold: NonNullable<ReportInput['sold']>): ReportSection | null {
  const flips = sold.view.flips;
  if (flips.length === 0) return null;
  return {
    heading: 'Flipped nearby',
    notes: [
      `${flips.length} home${flips.length === 1 ? ' was' : 's were'} resold within ${FLIP_MONTHS / 12} years for ${FLIP_MIN_RISE_PCT}% or more `
        + `(filters: ${sold.filters}). Median rise ${median(flips.map((f) => f.risePct))!.toFixed(0)}%.`,
    ],
    table: {
      head: ['Address', 'Bought', 'Sold', 'Rise'],
      numeric: [3],
      rows: flips.slice(0, SOLD_ROWS).map((f) => [
        `${saleAddress(f.sold)}${f.sold.postcode ? ` ${f.sold.postcode}` : ''}`,
        `${formatMoney(f.bought.price)}, ${monthYear(f.bought.date)}`,
        `${formatMoney(f.sold.price)}, ${monthYear(f.sold.date)}`,
        `+${formatMoney(f.rise)} (${f.risePct.toFixed(0)}%)`,
      ]),
    },
  };
}

function notesSection(input: ReportInput): ReportSection | null {
  const p = input.pipeline;
  const labels = input.labels ?? [];
  const items = timeline(input.activity ?? [], input.listing.priceHistory, { on: input.listing.listedOn, site: SITE_NAMES[input.listing.source] });
  // The capture and price lines are in the report already; only the user's own entries count
  const hasActivity = items.some((i) => i.id);
  if (!p && labels.length === 0 && !hasActivity) return null;

  const section: ReportSection = {
    heading: 'Deal notes',
    rows: compact([
      ['Stage', p ? statusLabel(p.status) : null],
      ['Follow up', p?.followUp ? date(`${p.followUp}T12:00:00Z`) : null],
      ['Labels', labels.join(', ')],
    ]),
    text: p?.notes.trim() || undefined,
  };
  if (hasActivity) {
    const shown = items.slice(0, TIMELINE_ROWS);
    section.table = {
      head: ['Date', 'What', 'Details'],
      numeric: [],
      rows: shown.map((i) => [date(i.at), i.title, i.text]),
    };
    if (items.length > shown.length) section.notes = [`The newest ${shown.length} of ${items.length} timeline entries.`];
  }
  return section;
}

function areaSection({ checks: a, rightsNames, wales }: NonNullable<ReportInput['area']>): ReportSection {
  const a4 = a.article4;
  const monthName = (ym: string) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const notes = [
    a.point.source === 'listing' ? 'Checked at the map position the listing gives.' : 'Checked at the centre of the postcode.',
    'National planning data does not yet hold every council\'s conservation areas and Article 4 directions: check with the council.',
    'Sources: Environment Agency, Natural Resources Wales, planning.data.gov.uk, DataMapWales, data.police.uk. Contains public sector information licensed under the Open Government Licence v3.0.',
  ];
  if (a.failed.length) notes.unshift(`Could not check ${a.failed.join(', ')}.`);
  return {
    heading: 'Area checks',
    rows: compact([
      ['Flood risk', a.flood ? `${FLOOD_WORDS[a.flood.zone]}${a.flood.by ? ` (${a.flood.by})` : ''}` : 'Could not check'],
      ['Conservation area', a.conservation ? (a.conservation.length ? a.conservation.map((c) => c.name).join(', ') : 'None found') : 'Could not check'],
      ['Article 4', !a4 ? 'Could not check'
        : a4.length === 0 ? (wales ? 'No national Article 4 map for Wales: ask the council about HMOs' : 'None found')
        : a4.map((d) => `${d.name}${d.rights.length ? ` (removes ${d.rights.map((r) => rightsNames[r] ?? `class ${r}`).join('; ')})` : ''}`).join('. ')],
      ['HMO Article 4', a4 && a4.some((d) => d.hmo) ? 'Yes: a small HMO needs planning permission here' : null],
      ['Street crime', a.crime
        ? `${a.crime.total} within about a mile in ${monthName(a.crime.month)}${a.crime.byCategory.length ? ` (most: ${a.crime.byCategory.slice(0, 3).map((c) => `${c.label} ${c.count}`).join(', ')})` : ''}`
        : 'Could not check'],
    ]),
    notes,
  };
}

export function buildReport(input: ReportInput): Report {
  const l = input.listing;
  const sections: ReportSection[] = [propertySection(l, input.generatedAt)];

  const energy = energySection(l);
  if (energy) sections.push(energy);
  if (input.area) sections.push(areaSection(input.area));
  const prices = priceSection(l);
  if (prices) sections.push(prices);
  if (input.sold) {
    sections.push(soldSection(input.sold, l));
    const flips = flipSection(input.sold);
    if (flips) sections.push(flips);
  }
  sections.push(...dealSections(input.deal));

  if (input.includeNotes) {
    const notes = notesSection(input);
    if (notes) sections.push(notes);
  }

  const facts = [
    l.bedrooms != null ? `${l.bedrooms} bed` : null,
    l.propertyType,
    l.price ? `${formatMoney(l.price)}${l.listingType === 'rent' ? ' a month' : ''}` : null,
  ].filter(Boolean).join(' · ');

  const b = input.branding;
  const brand: ReportBrand | null = b && isBranded(b)
    ? { company: b.company, contact: b.contact, logo: b.logo, colour: b.colour, headingColour: headingColour(b.colour) }
    : null;

  return {
    title: l.fullAddress || l.displayAddress || 'Property report',
    subtitle: facts,
    sections,
    brand,
    footer: `${brand?.company ? `Prepared by ${brand.company}` : 'Property report made with PropSnap'} on ${date(input.generatedAt.toISOString())}. `
      + 'Figures are estimates from the listing, public records and your own numbers. Not financial or tax advice.',
  };
}
