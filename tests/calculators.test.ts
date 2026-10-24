import { describe, expect, it } from 'vitest';
import {
  brr,
  buyToLet,
  cleanCustomCosts,
  dealInputsFor,
  flip,
  hmo,
  sourcingFee,
  DEFAULT_DEAL_INPUTS,
  monthlyMortgage,
  purchaseTax,
  taxRegionFromPostcode,
  type DealInputs,
} from '../src/services/calculators';

describe('Stamp Duty Land Tax (England)', () => {
  it('standard rates', () => {
    // 0% to £125k, 2% of £125k, 5% of £50k
    expect(purchaseTax(300_000, 'england', 'home_mover').total).toBe(5_000);
    expect(purchaseTax(125_000, 'england', 'home_mover').total).toBe(0);
    expect(purchaseTax(1_000_000, 'england', 'home_mover').total).toBe(2_500 + 33_750 + 7_500);
  });

  it('first-time buyer relief up to £500,000, none above', () => {
    expect(purchaseTax(300_000, 'england', 'first_time').total).toBe(0);
    expect(purchaseTax(400_000, 'england', 'first_time').total).toBe(5_000);
    expect(purchaseTax(550_000, 'england', 'first_time').total).toBe(17_500);
  });

  it('5% surcharge for an additional property', () => {
    // 5% of £125k + 7% of £125k + 10% of £50k
    expect(purchaseTax(300_000, 'england', 'additional').total).toBe(20_000);
    // Below £40,000 the surcharge does not apply
    expect(purchaseTax(39_000, 'england', 'additional').total).toBe(0);
  });
});

describe('Land Transaction Tax (Wales)', () => {
  it('main rates, also for first-time buyers', () => {
    expect(purchaseTax(300_000, 'wales', 'home_mover').total).toBe(4_500);
    expect(purchaseTax(300_000, 'wales', 'first_time').total).toBe(4_500);
    expect(purchaseTax(300_000, 'wales', 'first_time').note).toMatch(/no first-time buyer relief/);
  });

  it('higher rates for an additional property', () => {
    // 5% of £180k + 8.5% of £70k + 10% of £50k
    expect(purchaseTax(300_000, 'wales', 'additional').total).toBe(19_950);
  });
});

describe('taxRegionFromPostcode', () => {
  it('knows Welsh and English postcodes', () => {
    expect(taxRegionFromPostcode('CF14 9BP')).toEqual({ region: 'wales', sure: true });
    expect(taxRegionFromPostcode('SY23 1AA')).toEqual({ region: 'wales', sure: true });
    expect(taxRegionFromPostcode('CH7 1AA')).toEqual({ region: 'wales', sure: true });
    expect(taxRegionFromPostcode('BH25 6HB')).toEqual({ region: 'england', sure: true });
    expect(taxRegionFromPostcode('CH1 1AA')).toEqual({ region: 'england', sure: true });
  });

  it('is not sure for border districts or a missing postcode', () => {
    expect(taxRegionFromPostcode('HR2 7AA').sure).toBe(false);
    expect(taxRegionFromPostcode('SY10 7AA').sure).toBe(false);
    expect(taxRegionFromPostcode(null).sure).toBe(false);
  });
});

describe('monthlyMortgage', () => {
  it('repayment and interest only', () => {
    expect(monthlyMortgage(200_000, 5, 25, 'repayment')).toBeCloseTo(1_169.18, 2);
    expect(monthlyMortgage(200_000, 5, 25, 'interest_only')).toBeCloseTo(833.33, 2);
    expect(monthlyMortgage(0, 5, 25, 'repayment')).toBe(0);
  });

  it('uses the usual 25 years while the term box is empty, never £∞', () => {
    expect(monthlyMortgage(200_000, 5, 0, 'repayment')).toBeCloseTo(1_169.18, 2);
    expect(monthlyMortgage(200_000, 0, 0, 'repayment')).toBeCloseTo(666.67, 2);
  });
});

const deal = (extra: Partial<DealInputs>): DealInputs => ({
  ...DEFAULT_DEAL_INPUTS,
  price: 415_000,
  region: 'england',
  rentMonthly: 1_800,
  valueAfterRefurb: 0,
  ...extra,
});

describe('buyToLet', () => {
  it('works out yields, cashflow and return on cash', () => {
    const r = buyToLet(deal({ managementPct: 10, maintenancePct: 5, buyingCosts: 1_500 }));
    expect(r.grossYieldPct).toBeCloseTo(5.2, 1);
    expect(r.deposit).toBe(103_750);
    expect(r.loan).toBe(311_250);
    expect(r.mortgageMonthly).toBeCloseTo(1_296.875, 3);
    expect(r.runningCostsMonthly).toBe(270);
    expect(r.cashflowMonthly).toBeCloseTo(233.125, 3);
    // Additional-property SDLT on £415,000: 6,250 + 8,750 + 16,500
    expect(r.tax.total).toBe(31_500);
    expect(r.cashInvested).toBe(103_750 + 31_500 + 1_500);
    expect(r.returnOnCashPct).toBeCloseTo(((233.125 * 12) / 136_750) * 100, 4);
  });
});

describe('brr', () => {
  it('works out the money left in after the refinance', () => {
    const r = brr(deal({
      price: 150_000,
      depositPct: 25,
      buyingCosts: 0,
      buyer: 'home_mover',
      refurbCost: 30_000,
      valueAfterRefurb: 220_000,
      refinanceLtvPct: 75,
      rentMonthly: 1_200,
      managementPct: 0,
      maintenancePct: 0,
    }));
    // Deposit 37,500 + SDLT 500 + refurb 30,000
    expect(r.cashIn).toBe(68_000);
    expect(r.firstLoan).toBe(112_500);
    expect(r.refinanceLoan).toBe(165_000);
    expect(r.cashReleased).toBe(52_500);
    expect(r.moneyLeftIn).toBe(15_500);
    expect(r.mortgageMonthly).toBeCloseTo(687.5, 2);
    expect(r.cashflowMonthly).toBeCloseTo(512.5, 2);
  });

  it('has no return figure when all the money comes out', () => {
    const r = brr(deal({ price: 100_000, buyer: 'home_mover', buyingCosts: 0, refurbCost: 0, valueAfterRefurb: 200_000 }));
    expect(r.moneyLeftIn).toBeLessThanOrEqual(0);
    expect(r.returnOnMoneyLeftPct).toBeNull();
  });
});

describe('dealInputsFor', () => {
  const sale = { price: 250_000, listingType: 'sale' as const, postcode: 'CF14 9BP', postcodePartial: 'CF14' };

  it('fills the price, value and region from a sale listing', () => {
    const { inputs, regionSure } = dealInputsFor(sale);
    expect(inputs.price).toBe(250_000);
    expect(inputs.valueAfterRefurb).toBe(250_000);
    expect(inputs.rentMonthly).toBe(0);
    expect(inputs.region).toBe('wales');
    expect(regionSure).toBe(true);
  });

  it('fills the rent from a rent listing', () => {
    const { inputs } = dealInputsFor({ price: 1_350, listingType: 'rent', postcode: null, postcodePartial: 'BS1' });
    expect(inputs.price).toBe(0);
    expect(inputs.rentMonthly).toBe(1_350);
    expect(inputs.region).toBe('england');
  });

  it("keeps the user's saved numbers and ignores bad ones", () => {
    const { inputs, regionSure } = dealInputsFor(
      { ...sale, postcode: null, postcodePartial: 'HR2' },
      { price: 240_000, rentMonthly: 1_100, ratePct: Number.NaN, depositPct: -5, region: 'wales', buyer: 'cash' as never },
    );
    expect(inputs.price).toBe(240_000);
    expect(inputs.rentMonthly).toBe(1_100);
    expect(inputs.ratePct).toBe(DEFAULT_DEAL_INPUTS.ratePct);
    expect(inputs.depositPct).toBe(DEFAULT_DEAL_INPUTS.depositPct);
    expect(inputs.buyer).toBe(DEFAULT_DEAL_INPUTS.buyer);
    expect(inputs.region).toBe('wales');
    // The user chose the region, so the border warning goes away
    expect(regionSure).toBe(true);
  });
});

describe('sourcing fee and custom costs', () => {
  it('adds them to the cash put in and the running costs', () => {
    const plain = buyToLet(deal({}));
    const r = buyToLet(deal({
      sourcingFee: 2,
      sourcingFeeType: 'pct',
      customCosts: [{ name: 'Gas safety check', amount: 90, when: 'once' }, { name: 'Landlord insurance', amount: 30, when: 'monthly' }],
    }));
    expect(sourcingFee({ sourcingFee: 2, sourcingFeeType: 'pct', price: 415_000 })).toBe(8_300);
    expect(sourcingFee({ sourcingFee: 3_000, sourcingFeeType: 'fixed', price: 415_000 })).toBe(3_000);
    expect(r.cashInvested).toBe(plain.cashInvested + 8_300 + 90);
    expect(r.runningCostsMonthly).toBe(plain.runningCostsMonthly + 30);
    expect(brr(deal({ sourcingFee: 3_000 })).cashIn).toBe(brr(deal({})).cashIn + 3_000);
  });

  it('checks saved custom costs', () => {
    expect(cleanCustomCosts([
      { name: '  Gas   safety ', amount: 90, when: 'once' },
      { name: 'Insurance', amount: 30, when: 'monthly' },
      { name: '', amount: 10, when: 'once' },
      { name: 'Free', amount: 0, when: 'once' },
      { name: 'Odd', amount: 5, when: 'weekly' },
      'junk',
    ])).toEqual([
      { name: 'Gas safety', amount: 90, when: 'once' },
      { name: 'Insurance', amount: 30, when: 'monthly' },
      { name: 'Odd', amount: 5, when: 'once' },
    ]);
    expect(cleanCustomCosts(Array.from({ length: 15 }, (_, n) => ({ name: `c${n}`, amount: 1, when: 'once' })))).toHaveLength(10);
  });

  it('keeps saved fee type and costs in dealInputsFor', () => {
    const { inputs } = dealInputsFor(
      { price: 250_000, listingType: 'sale', postcode: 'CF14 9BP', postcodePartial: 'CF14' },
      { sourcingFeeType: 'pct', sourcingFee: 2, customCosts: [{ name: 'Survey', amount: 600, when: 'once' }] },
    );
    expect(inputs.sourcingFeeType).toBe('pct');
    expect(inputs.sourcingFee).toBe(2);
    expect(inputs.customCosts).toEqual([{ name: 'Survey', amount: 600, when: 'once' }]);
    expect(dealInputsFor({ price: 1, listingType: 'sale', postcode: null, postcodePartial: null }, { sourcingFeeType: 'x' as never }).inputs.sourcingFeeType).toBe('fixed');
  });

  it('turns an "Other costs" figure saved before 0.4.1 into a named monthly cost', () => {
    const listing = { price: 250_000, listingType: 'sale' as const, postcode: 'CF14 9BP', postcodePartial: 'CF14' };
    const { inputs } = dealInputsFor(listing, { otherMonthly: 45, customCosts: [{ name: 'Survey', amount: 600, when: 'once' }] } as never);
    expect(inputs.customCosts).toEqual([{ name: 'Survey', amount: 600, when: 'once' }, { name: 'Other costs', amount: 45, when: 'monthly' }]);
    expect('otherMonthly' in inputs).toBe(false);
    // The same running costs as before
    expect(buyToLet({ ...inputs, rentMonthly: 1_000 }).runningCostsMonthly).toBe(180 + 45);
    expect(dealInputsFor(listing, { otherMonthly: 0 } as never).inputs.customCosts).toEqual([]);
  });
});

describe('flip', () => {
  const flipDeal = (extra: Partial<DealInputs> = {}) => deal({
    price: 150_000, buyer: 'home_mover', buyingCosts: 1_500, refurbCost: 30_000, valueAfterRefurb: 220_000,
    flipMonths: 6, holdingMonthly: 300, sellingFeePct: 1.5, saleLegalFees: 1_200,
    bridgingPct: 75, bridgingRatePct: 1, bridgingFeesPct: 2, ...extra,
  });

  it('works out the profit with a bridging loan', () => {
    const r = flip(flipDeal());
    expect(r.tax.total).toBe(500);
    expect(r.loan).toBe(112_500);
    // 6 months at 1% a month rolled up, plus 2% fees
    expect(r.financeCost).toBe(6_750 + 2_250);
    expect(r.holdingCost).toBe(1_800);
    expect(r.sellingCost).toBe(3_300 + 1_200);
    expect(r.totalCost).toBe(182_000 + 9_000 + 1_800 + 4_500);
    expect(r.profit).toBe(22_700);
    expect(r.cashNeeded).toBe(182_000 - 112_500 + 2_250 + 1_800);
    expect(r.profitOnCostPct).toBeCloseTo((22_700 / 197_300) * 100, 6);
    expect(r.returnOnCashPct).toBeCloseTo((22_700 / 73_550) * 100, 6);
    expect(r.profitMonthly).toBeCloseTo(22_700 / 6, 6);
  });

  it('buys with cash when there is no bridging loan, and counts monthly custom costs while held', () => {
    const r = flip(flipDeal({ bridgingPct: 0, customCosts: [{ name: 'Alarm', amount: 50, when: 'monthly' }] }));
    expect(r.financeCost).toBe(0);
    expect(r.holdingCost).toBe((300 + 50) * 6);
    expect(r.cashNeeded).toBe(182_000 + 2_100);
  });

  it('sells at the price paid when no value after the works is typed', () => {
    expect(flip(flipDeal({ valueAfterRefurb: 0 })).salePrice).toBe(150_000);
  });
});

describe('hmo', () => {
  it('works out the room rents, bills, licence and cashflow', () => {
    const r = hmo(deal({
      price: 200_000, buyer: 'home_mover', depositPct: 25, ratePct: 6, mortgageType: 'interest_only', buyingCosts: 1_500,
      refurbCost: 20_000, hmoRooms: 5, hmoRoomRent: 550, hmoManagementPct: 12, maintenancePct: 8,
      hmoBillsMonthly: 500, customCosts: [{ name: 'Insurance', amount: 100, when: 'monthly' }], hmoLicenceCost: 1_200, hmoLicenceYears: 5,
    }));
    expect(r.rentMonthly).toBe(2_750);
    expect(r.licenceMonthly).toBe(20);
    expect(r.runningCostsMonthly).toBe(550 + 500 + 100 + 20);
    expect(r.mortgageMonthly).toBe(750);
    expect(r.cashflowMonthly).toBe(830);
    expect(r.cashflowPerRoom).toBe(166);
    expect(r.cashInvested).toBe(50_000 + 1_500 + 1_500 + 20_000);
    expect(r.grossYieldPct).toBeCloseTo(16.5, 6);
    expect(r.netYieldPct).toBeCloseTo((1_580 * 12 / 200_000) * 100, 6);
    expect(r.returnOnCashPct).toBeCloseTo((830 * 12 / 73_000) * 100, 6);
  });

  it('has no per-room figure without rooms', () => {
    expect(hmo(deal({ hmoRooms: 0 })).cashflowPerRoom).toBeNull();
  });
});
