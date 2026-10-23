import { describe, expect, it } from 'vitest';
import {
  formatPostcode,
  mergeSales,
  parseSoldPrices,
  postcodeQuery,
  streetQuery,
  type SoldPrice,
} from '../src/services/land-registry';
import { isSameHome, lrTypeFor, median, saleAddress, soldPriceArea, soldPriceView, typeChoices } from '../src/services/sold-prices';

const LR = 'http://landregistry.data.gov.uk/def/common/';
const PPI = 'http://landregistry.data.gov.uk/def/ppi/';

// The W3C SPARQL JSON shape the Land Registry endpoint answers with
const answer = {
  head: { vars: ['transx', 'amount', 'date'] },
  results: {
    bindings: [
      {
        transx: { type: 'uri', value: 'http://landregistry.data.gov.uk/data/ppi/transaction/AAA/current' },
        amount: { type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#integer', value: '215000' },
        date: { type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#date', value: '2021-06-30' },
        paon: { type: 'literal', value: '144' },
        street: { type: 'literal', value: 'TWEEDSMUIR ROAD' },
        town: { type: 'literal', value: 'CARDIFF' },
        postcode: { type: 'literal', value: 'CF24 2RF' },
        propertyType: { type: 'uri', value: `${LR}terraced` },
        estateType: { type: 'uri', value: `${LR}freehold` },
        newBuild: { type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#boolean', value: 'false' },
        category: { type: 'uri', value: `${PPI}standardPricePaidTransaction` },
      },
      {
        transx: { type: 'uri', value: 'http://landregistry.data.gov.uk/data/ppi/transaction/BBB/current' },
        amount: { value: '120000' },
        date: { value: '2023-02-01' },
        saon: { value: 'FLAT 3' },
        paon: { value: 'DOVERCOURT HOUSE' },
        street: { value: 'FERRY COURT' },
        town: { value: 'CARDIFF' },
        postcode: { value: 'CF11 0AS' },
        propertyType: { value: `${LR}flat-maisonette` },
        estateType: { value: `${LR}leasehold` },
        newBuild: { value: 'true' },
        category: { value: `${PPI}additionalPricePaidTransaction` },
      },
      { amount: { value: 'oops' }, date: { value: '2020-01-01' } },
    ],
  },
};

describe('Land Registry queries', () => {
  it('formats full postcodes and refuses anything else', () => {
    expect(formatPostcode('cf242rf')).toBe('CF24 2RF');
    expect(formatPostcode(' SW1P 1LQ ')).toBe('SW1P 1LQ');
    expect(formatPostcode('CF24')).toBeNull();
    expect(formatPostcode(null)).toBeNull();
  });

  it('builds a postcode query', () => {
    const q = postcodeQuery('cf24 2rf')!;
    expect(q).toContain('VALUES ?postcode { "CF24 2RF"^^xsd:string }');
    expect(q).toContain('lrppi:pricePaid ?amount');
    expect(postcodeQuery('CF24')).toBeNull();
  });

  it('builds a street query limited to the postcode district', () => {
    const q = streetQuery('Tweedsmuir Road', 'cf24')!;
    expect(q).toContain('VALUES ?street { "TWEEDSMUIR ROAD"^^xsd:string }');
    expect(q).toContain('STRSTARTS(?postcode, "CF24 "^^xsd:string)');
  });

  it('never sends text that could change the query', () => {
    expect(streetQuery('X" } DROP {', 'CF24')).toBeNull();
    expect(streetQuery('Main Road', 'CF24" }')).toBeNull();
    expect(postcodeQuery('CF24 2RF" }')).toBeNull();
  });
});

describe('parseSoldPrices', () => {
  it('reads the SPARQL JSON answer', () => {
    const sales = parseSoldPrices(answer);
    expect(sales).toHaveLength(2);
    expect(sales[0]).toEqual({
      id: 'http://landregistry.data.gov.uk/data/ppi/transaction/AAA/current',
      price: 215000,
      date: '2021-06-30',
      saon: null,
      paon: '144',
      street: 'TWEEDSMUIR ROAD',
      town: 'CARDIFF',
      postcode: 'CF24 2RF',
      propertyType: 'terraced',
      tenure: 'freehold',
      newBuild: false,
      standard: true,
    });
    expect(sales[1]).toMatchObject({ propertyType: 'flat-maisonette', tenure: 'leasehold', newBuild: true, standard: false });
  });

  it('copes with an empty or odd answer', () => {
    expect(parseSoldPrices({ results: { bindings: [] } })).toEqual([]);
    expect(parseSoldPrices(null)).toEqual([]);
    expect(parseSoldPrices({ error: 'x' })).toEqual([]);
  });

  it('merges two answers without repeats, newest first', () => {
    const [a, b] = parseSoldPrices(answer);
    expect(mergeSales([a!], [b!, a!]).map((s) => s.date)).toEqual(['2023-02-01', '2021-06-30']);
  });
});

describe('soldPriceArea', () => {
  it('uses the full postcode and the street from the full address', () => {
    expect(soldPriceArea({ postcode: 'CF24 2RF', postcodePartial: 'CF24', fullAddress: '144 Tweedsmuir Road, CARDIFF', displayAddress: 'Tweedsmuir Road, Cardiff' }))
      .toEqual({ postcode: 'CF24 2RF', street: 'TWEEDSMUIR ROAD', outcode: 'CF24' });
  });

  it('skips building names and finds the street', () => {
    expect(soldPriceArea({ postcode: 'CF11 0AS', postcodePartial: 'CF11', fullAddress: 'Flat 3, Dovercourt House, Ferry Court, CARDIFF', displayAddress: 'Ferry Court, Cardiff' }).street)
      .toBe('FERRY COURT');
  });

  it('falls back to the display address and the half postcode', () => {
    expect(soldPriceArea({ postcode: null, postcodePartial: 'BH24', fullAddress: null, displayAddress: 'Mockbeggar Lane, Ringwood BH24' }))
      .toEqual({ postcode: null, street: 'MOCKBEGGAR LANE', outcode: 'BH24' });
  });

  it('knows Welsh street names and spells out abbreviations', () => {
    expect(soldPriceArea({ postcode: null, postcodePartial: 'CF14', fullAddress: null, displayAddress: 'Heol Hir, Cardiff' }).street).toBe('HEOL HIR');
    expect(soldPriceArea({ postcode: null, postcodePartial: 'CF14', fullAddress: '2 High St, CARDIFF', displayAddress: '' }).street).toBe('HIGH STREET');
  });

  it('gives no street when the address has none', () => {
    expect(soldPriceArea({ postcode: null, postcodePartial: 'CF14', fullAddress: null, displayAddress: 'Cardiff' }).street).toBeNull();
  });
});

describe('lrTypeFor', () => {
  it('maps listing types to Land Registry types', () => {
    expect(lrTypeFor('Flat')).toBe('flat-maisonette');
    expect(lrTypeFor('Apartment')).toBe('flat-maisonette');
    expect(lrTypeFor('Semi-Detached')).toBe('semi-detached');
    expect(lrTypeFor('End of Terrace')).toBe('terraced');
    expect(lrTypeFor('Detached house')).toBe('detached');
    expect(lrTypeFor('Bungalow')).toBeNull();
    expect(lrTypeFor(null)).toBeNull();
  });
});

const sale = (extra: Partial<SoldPrice>): SoldPrice => ({
  id: Math.random().toString(),
  price: 200_000,
  date: '2024-01-01',
  saon: null,
  paon: '12',
  street: 'HIGH STREET',
  town: 'CARDIFF',
  postcode: 'CF14 1AA',
  propertyType: 'terraced',
  tenure: 'freehold',
  newBuild: false,
  standard: true,
  ...extra,
});

describe('isSameHome', () => {
  it('matches the same number and street', () => {
    expect(isSameHome(sale({}), '12 High Street, CARDIFF')).toBe(true);
    expect(isSameHome(sale({}), '112 High Street, CARDIFF')).toBe(false);
    expect(isSameHome(sale({ street: 'LOW STREET' }), '12 High Street, CARDIFF')).toBe(false);
    expect(isSameHome(sale({}), null)).toBe(false);
  });

  it('matches flats by flat number', () => {
    const flat = sale({ saon: 'FLAT 3', paon: 'DOVERCOURT HOUSE', street: 'FERRY COURT' });
    expect(isSameHome(flat, 'Flat 3, Dovercourt House, Ferry Court, CARDIFF')).toBe(true);
    expect(isSameHome(flat, 'Flat 13, Dovercourt House, Ferry Court, CARDIFF')).toBe(false);
    // A sale of the whole building is not the sale of one flat in it
    expect(isSameHome(sale({ paon: 'DOVERCOURT HOUSE', street: 'FERRY COURT' }), 'Flat 3, Dovercourt House, Ferry Court, CARDIFF')).toBe(false);
  });
});

describe('soldPriceView', () => {
  const today = new Date('2026-10-23T00:00:00Z');
  const listing = { fullAddress: '12 High Street, CARDIFF', price: 260_000, listingType: 'sale' as const };
  const sales = [
    sale({ id: 'own-2019', date: '2019-05-01', price: 150_000 }),
    sale({ id: 'a', paon: '14', date: '2025-03-01', price: 240_000 }),
    sale({ id: 'b', paon: '16', date: '2024-03-01', price: 200_000 }),
    sale({ id: 'c', paon: '18', date: '2023-03-01', price: 260_000, standard: false }),
    sale({ id: 'd', paon: '20', date: '2015-03-01', price: 100_000 }),
    sale({ id: 'e', paon: '22', date: '2025-06-01', price: 400_000, propertyType: 'detached' }),
  ];

  it("splits this home's history from the comparables and works out the median", () => {
    const view = soldPriceView(sales, listing, { types: ['terraced'], sinceYears: 5, today });
    expect(view.thisHome.map((s) => s.id)).toEqual(['own-2019']);
    expect(view.comparables.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    // Repossessions and company sales (c) are listed but left out of the figures
    expect(view.median).toBe(220_000);
    expect(view.low).toBe(200_000);
    expect(view.high).toBe(240_000);
    expect(view.askingVsMedianPct).toBeCloseTo(18.18, 2);
  });

  it('can show every type and every year', () => {
    const view = soldPriceView(sales, listing, { types: null, sinceYears: null, today });
    expect(view.comparables).toHaveLength(5);
  });

  it('has no asking-price comparison for a rent listing', () => {
    expect(soldPriceView(sales, { ...listing, listingType: 'rent', price: 1_200 }, { types: null, sinceYears: null, today }).askingVsMedianPct).toBeNull();
  });

  it('median of an even and an empty list', () => {
    expect(median([1, 3, 2, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('saleAddress', () => {
  it('writes the address in normal case', () => {
    expect(saleAddress(sale({ saon: 'FLAT 3', paon: '12A' }))).toBe('Flat 3, 12A High Street, Cardiff');
  });

  it('keeps a building name apart from the street', () => {
    expect(saleAddress(sale({ saon: '15', paon: 'SYCAMORE COURT', street: 'WOOLASTON AVENUE' })))
      .toBe('15 Sycamore Court, Woolaston Avenue, Cardiff');
    expect(saleAddress(sale({ saon: 'FLAT 3', paon: 'DOVERCOURT HOUSE', street: 'FERRY COURT' })))
      .toBe('Flat 3, Dovercourt House, Ferry Court, Cardiff');
    expect(saleAddress(sale({ paon: 'ROSE COTTAGE', street: 'MILL LANE' }))).toBe('Rose Cottage, Mill Lane, Cardiff');
  });
});

describe('typeChoices', () => {
  const values = (type: string | null) => typeChoices(type).map((c) => c.label);

  it('offers the same type, then all houses, then all types', () => {
    expect(values('Terraced')).toEqual(['Terraced only', 'All houses', 'All types']);
    expect(values('Semi-Detached')).toEqual(['Semi-detached only', 'All houses', 'All types']);
  });

  it('has no "All houses" for a flat, and no "only" when the form is not known', () => {
    expect(values('Flat')).toEqual(['Flats only', 'All types']);
    expect(values('Bungalow')).toEqual(['All houses', 'All types']);
    expect(values(null)).toEqual(['All types']);
  });

  it('"All houses" leaves the flats out', () => {
    const houses = typeChoices('Terraced')[1]!;
    const view = soldPriceView(
      [sale({ id: 't' }), sale({ id: 's', propertyType: 'semi-detached' }), sale({ id: 'f', propertyType: 'flat-maisonette' })],
      { fullAddress: null, price: null, listingType: 'sale' },
      { types: houses.types, sinceYears: null, today: new Date('2026-10-23T00:00:00Z') },
    );
    expect(view.comparables.map((s) => s.id)).toEqual(['t', 's']);
  });
});
