/**
 * Deal calculators: purchase tax, mortgage, buy-to-let and BRR.
 * Pure functions, so every figure is unit tested.
 *
 * Tax rates are for 2026/27. Check them against GOV.UK (SDLT) and the Welsh
 * Revenue Authority (LTT) each April and update the tables below.
 */

import type { PropertyListing } from '../adapters/types';

export type TaxRegion = 'england' | 'wales';
export type BuyerType = 'home_mover' | 'first_time' | 'additional';
export type MortgageType = 'interest_only' | 'repayment';

interface Band {
  upTo: number; // Infinity for the top band
  rate: number; // percent
}

export const RATES_YEAR = '2026/27';

// England (and Northern Ireland): Stamp Duty Land Tax
const SDLT_STANDARD: Band[] = [
  { upTo: 125_000, rate: 0 },
  { upTo: 250_000, rate: 2 },
  { upTo: 925_000, rate: 5 },
  { upTo: 1_500_000, rate: 10 },
  { upTo: Infinity, rate: 12 },
];
// First-time buyer relief, only when the price is £500,000 or less
const SDLT_FIRST_TIME: Band[] = [
  { upTo: 300_000, rate: 0 },
  { upTo: 500_000, rate: 5 },
];
const SDLT_FIRST_TIME_LIMIT = 500_000;
// Additional dwellings (buy-to-let, second homes): +5 points on every band
const SDLT_SURCHARGE = 5;
// The surcharge does not apply below £40,000
const SDLT_SURCHARGE_MIN_PRICE = 40_000;

// Wales: Land Transaction Tax. No first-time buyer relief.
const LTT_MAIN: Band[] = [
  { upTo: 225_000, rate: 0 },
  { upTo: 400_000, rate: 6 },
  { upTo: 750_000, rate: 7.5 },
  { upTo: 1_500_000, rate: 10 },
  { upTo: Infinity, rate: 12 },
];
// Higher rates (additional properties) are their own table
const LTT_HIGHER: Band[] = [
  { upTo: 180_000, rate: 5 },
  { upTo: 250_000, rate: 8.5 },
  { upTo: 400_000, rate: 10 },
  { upTo: 750_000, rate: 12.5 },
  { upTo: 1_500_000, rate: 15 },
  { upTo: Infinity, rate: 17 },
];
const LTT_HIGHER_MIN_PRICE = 40_000;

export interface TaxSlice {
  from: number;
  to: number;
  rate: number;
  tax: number;
}

export interface PurchaseTax {
  name: 'Stamp Duty Land Tax' | 'Land Transaction Tax';
  total: number;
  slices: TaxSlice[];
  /** Why a relief or surcharge did or did not apply, for the reader */
  note: string | null;
}

function applyBands(price: number, bands: Band[], extra = 0): { total: number; slices: TaxSlice[] } {
  const slices: TaxSlice[] = [];
  let from = 0;
  for (const band of bands) {
    if (price <= from) break;
    const to = Math.min(price, band.upTo);
    const rate = band.rate + extra;
    const tax = ((to - from) * rate) / 100;
    slices.push({ from, to, rate, tax });
    from = band.upTo;
  }
  const total = Math.floor(slices.reduce((sum, s) => sum + s.tax, 0));
  return { total, slices };
}

/** Purchase tax for the region the home is in */
export function purchaseTax(price: number, region: TaxRegion, buyer: BuyerType): PurchaseTax {
  if (!(price > 0)) return { name: region === 'wales' ? 'Land Transaction Tax' : 'Stamp Duty Land Tax', total: 0, slices: [], note: null };

  if (region === 'wales') {
    if (buyer === 'additional' && price >= LTT_HIGHER_MIN_PRICE) {
      return { name: 'Land Transaction Tax', ...applyBands(price, LTT_HIGHER), note: 'Higher rates for an additional property' };
    }
    return {
      name: 'Land Transaction Tax',
      ...applyBands(price, LTT_MAIN),
      note: buyer === 'first_time' ? 'Wales has no first-time buyer relief, so the main rates apply' : null,
    };
  }

  if (buyer === 'first_time') {
    if (price <= SDLT_FIRST_TIME_LIMIT) {
      return { name: 'Stamp Duty Land Tax', ...applyBands(price, SDLT_FIRST_TIME), note: 'First-time buyer relief' };
    }
    return {
      name: 'Stamp Duty Land Tax',
      ...applyBands(price, SDLT_STANDARD),
      note: 'No first-time buyer relief above £500,000, so the standard rates apply',
    };
  }
  if (buyer === 'additional' && price >= SDLT_SURCHARGE_MIN_PRICE) {
    return { name: 'Stamp Duty Land Tax', ...applyBands(price, SDLT_STANDARD, SDLT_SURCHARGE), note: '5% surcharge for an additional property' };
  }
  return { name: 'Stamp Duty Land Tax', ...applyBands(price, SDLT_STANDARD), note: null };
}

/**
 * England or Wales from the postcode. Border districts can be either, so the
 * page lets the user change it; `sure` is false for those.
 */
export function taxRegionFromPostcode(postcode: string | null | undefined): { region: TaxRegion; sure: boolean } {
  const outcode = (postcode ?? '').trim().toUpperCase().split(/\s+/)[0] ?? '';
  const match = outcode.match(/^([A-Z]{1,2})(\d+)/);
  if (!match) return { region: 'england', sure: false };
  const area = match[1]!;
  const district = Number(match[2]);

  if (['CF', 'NP', 'SA', 'LL', 'LD'].includes(area)) return { region: 'wales', sure: true };
  // Flintshire and the Welsh side of Shropshire / Powys
  if (area === 'CH' && district >= 5 && district <= 8) return { region: 'wales', sure: true };
  if (area === 'SY' && district >= 15 && district <= 25) return { region: 'wales', sure: true };
  // Districts that cross the border
  if ((area === 'SY' && [10, 13, 14].includes(district)) || area === 'HR' || (area === 'CH' && district === 4)) {
    return { region: 'england', sure: false };
  }
  return { region: 'england', sure: true };
}

/** Monthly mortgage payment */
export function monthlyMortgage(loan: number, annualRatePct: number, years: number, type: MortgageType): number {
  if (!(loan > 0)) return 0;
  const r = annualRatePct / 100 / 12;
  if (type === 'interest_only' || r === 0) {
    return type === 'interest_only' ? loan * r : loan / (years * 12);
  }
  const n = years * 12;
  return (loan * r) / (1 - Math.pow(1 + r, -n));
}

export interface DealInputs {
  price: number;
  region: TaxRegion;
  buyer: BuyerType;
  /** Legal fees, survey and other buying costs, in £ */
  buyingCosts: number;
  depositPct: number;
  ratePct: number;
  termYears: number;
  mortgageType: MortgageType;
  rentMonthly: number;
  /** Letting / management fee, % of rent */
  managementPct: number;
  /** Repairs and empty months, % of rent */
  maintenancePct: number;
  /** Insurance, ground rent, service charge and anything else, £ per month */
  otherMonthly: number;
  /** BRR only */
  refurbCost: number;
  valueAfterRefurb: number;
  refinanceLtvPct: number;
}

export const DEFAULT_DEAL_INPUTS: Omit<DealInputs, 'price' | 'region' | 'rentMonthly' | 'valueAfterRefurb'> = {
  buyer: 'additional',
  buyingCosts: 1_500,
  depositPct: 25,
  ratePct: 5,
  termYears: 25,
  mortgageType: 'interest_only',
  managementPct: 10,
  maintenancePct: 8,
  otherMonthly: 0,
  refurbCost: 0,
  refinanceLtvPct: 75,
};

const NUMBER_FIELDS = [
  'price', 'buyingCosts', 'depositPct', 'ratePct', 'termYears', 'rentMonthly', 'managementPct',
  'maintenancePct', 'otherMonthly', 'refurbCost', 'valueAfterRefurb', 'refinanceLtvPct',
] as const;

/**
 * The calculator inputs for a listing: the user's saved numbers on top of
 * figures from the listing (price, or rent on a rent listing) and defaults.
 * `regionSure` is false when the postcode cannot say England or Wales.
 */
export function dealInputsFor(
  listing: Pick<PropertyListing, 'price' | 'listingType' | 'postcode' | 'postcodePartial'>,
  saved?: Partial<DealInputs> | null,
): { inputs: DealInputs; regionSure: boolean } {
  const isRent = listing.listingType === 'rent';
  const listed = listing.price && listing.price > 0 ? listing.price : 0;
  const { region, sure } = taxRegionFromPostcode(listing.postcode || listing.postcodePartial);

  const inputs: DealInputs = {
    ...DEFAULT_DEAL_INPUTS,
    price: isRent ? 0 : listed,
    region,
    rentMonthly: isRent ? listed : 0,
    valueAfterRefurb: isRent ? 0 : listed,
  };

  // Saved data lives in storage, so keep only values of the right kind
  if (saved) {
    for (const field of NUMBER_FIELDS) {
      const value = saved[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) inputs[field] = value;
    }
    if (saved.region === 'england' || saved.region === 'wales') inputs.region = saved.region;
    if (saved.buyer === 'home_mover' || saved.buyer === 'first_time' || saved.buyer === 'additional') inputs.buyer = saved.buyer;
    if (saved.mortgageType === 'interest_only' || saved.mortgageType === 'repayment') inputs.mortgageType = saved.mortgageType;
  }

  return { inputs, regionSure: sure || saved?.region === 'england' || saved?.region === 'wales' };
}

function runningCosts(i: DealInputs): number {
  return (i.rentMonthly * (i.managementPct + i.maintenancePct)) / 100 + i.otherMonthly;
}

export interface BuyToLetResult {
  tax: PurchaseTax;
  deposit: number;
  loan: number;
  mortgageMonthly: number;
  runningCostsMonthly: number;
  /** Deposit + tax + buying costs */
  cashInvested: number;
  /** Rent per year ÷ price */
  grossYieldPct: number;
  /** (Rent − running costs) per year ÷ price, before the mortgage */
  netYieldPct: number;
  cashflowMonthly: number;
  /** Cashflow per year ÷ cash invested */
  returnOnCashPct: number | null;
}

export function buyToLet(i: DealInputs): BuyToLetResult {
  const tax = purchaseTax(i.price, i.region, i.buyer);
  const deposit = (i.price * i.depositPct) / 100;
  const loan = Math.max(0, i.price - deposit);
  const mortgageMonthly = monthlyMortgage(loan, i.ratePct, i.termYears, i.mortgageType);
  const runningCostsMonthly = runningCosts(i);
  const cashInvested = deposit + tax.total + i.buyingCosts;
  const cashflowMonthly = i.rentMonthly - runningCostsMonthly - mortgageMonthly;

  return {
    tax,
    deposit,
    loan,
    mortgageMonthly,
    runningCostsMonthly,
    cashInvested,
    grossYieldPct: i.price > 0 ? ((i.rentMonthly * 12) / i.price) * 100 : 0,
    netYieldPct: i.price > 0 ? (((i.rentMonthly - runningCostsMonthly) * 12) / i.price) * 100 : 0,
    cashflowMonthly,
    returnOnCashPct: cashInvested > 0 ? ((cashflowMonthly * 12) / cashInvested) * 100 : null,
  };
}

export interface BrrResult {
  tax: PurchaseTax;
  /** Everything paid before the refinance: deposit, tax, buying costs, refurb */
  cashIn: number;
  firstLoan: number;
  refinanceLoan: number;
  /** New loan minus the first loan, returned to the investor */
  cashReleased: number;
  /** Own money still in the deal after the refinance (0 or less = all out) */
  moneyLeftIn: number;
  mortgageMonthly: number;
  cashflowMonthly: number;
  /** Cashflow per year ÷ money left in; null when no money is left in */
  returnOnMoneyLeftPct: number | null;
}

/**
 * Buy, refurbish, refinance: buy with the deposit and loan above, pay for the
 * works in cash, then remortgage at the new value and repay the first loan.
 */
export function brr(i: DealInputs): BrrResult {
  const tax = purchaseTax(i.price, i.region, i.buyer);
  const deposit = (i.price * i.depositPct) / 100;
  const firstLoan = Math.max(0, i.price - deposit);
  const cashIn = deposit + tax.total + i.buyingCosts + i.refurbCost;
  const refinanceLoan = (i.valueAfterRefurb * i.refinanceLtvPct) / 100;
  const cashReleased = refinanceLoan - firstLoan;
  const moneyLeftIn = cashIn - cashReleased;
  const mortgageMonthly = monthlyMortgage(refinanceLoan, i.ratePct, i.termYears, i.mortgageType);
  const cashflowMonthly = i.rentMonthly - runningCosts(i) - mortgageMonthly;

  return {
    tax,
    cashIn,
    firstLoan,
    refinanceLoan,
    cashReleased,
    moneyLeftIn,
    mortgageMonthly,
    cashflowMonthly,
    returnOnMoneyLeftPct: moneyLeftIn > 0 ? ((cashflowMonthly * 12) / moneyLeftIn) * 100 : null,
  };
}
