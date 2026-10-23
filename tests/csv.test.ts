import { describe, expect, it } from 'vitest';
import type { PropertyListing } from '../src/adapters/types';
import { listingsToCsv } from '../src/services/storage';

function listing(extra: Partial<PropertyListing> = {}): PropertyListing {
  return {
    listingId: '1',
    source: 'openrent',
    url: 'https://example.test',
    displayAddress: 'Heol y Ŵyn Cardiff',
    postcode: 'CF14 0SN',
    postcodePartial: 'CF14',
    fullAddress: null,
    price: 1200,
    priceQualifier: null,
    currency: 'GBP',
    listingType: 'rent',
    bedrooms: 2,
    propertyType: 'Flat',
    agentName: null,
    agentPhone: null,
    agentBranch: null,
    latitude: 51.5,
    longitude: -3.18,
    tenure: null,
    furnished: 'Furnished',
    deposit: 1385,
    epcRating: null,
    capturedAt: '2026-10-18T00:00:00Z',
    ...extra,
  };
}

/** Header name → cell, for one listing (no quoted commas in these tests) */
function row(l: PropertyListing): Record<string, string> {
  const [headers, cells] = listingsToCsv([l]).split('\n').map((line) => line.split(','));
  return Object.fromEntries(headers!.map((h, i) => [h, cells![i]!]));
}

describe('listingsToCsv', () => {
  it('turns text that Excel would run as a formula into plain text', () => {
    const cells = row(listing({ agentName: '=HYPERLINK("http://bad.test")', agentBranch: '@SUM(A1)' }));
    expect(cells['Agent/Landlord']).toBe(`"'=HYPERLINK(""http://bad.test"")"`);
    expect(cells['Agent Branch']).toBe("'@SUM(A1)");
  });

  it('leaves negative numbers alone', () => {
    expect(row(listing())['Longitude']).toBe('-3.18');
  });

  it('includes the extra listing columns and the match detail', () => {
    const cells = row(listing({ priceQualifier: 'Offers over', tenure: 'Freehold', agentBranch: 'Cardiff Bay', enrichmentDetail: 'Exact: matched on house number' }));
    expect(cells['Price Qualifier']).toBe('Offers over');
    expect(cells['Tenure']).toBe('Freehold');
    expect(cells['Furnished']).toBe('Furnished');
    expect(cells['Deposit']).toBe('1385');
    expect(cells['Agent Branch']).toBe('Cardiff Bay');
    expect(cells['Match Detail']).toBe('Exact: matched on house number');
  });

  it('includes the first price, the change and the price history', () => {
    const cells = row(listing({
      listingType: 'sale',
      price: 290_000,
      priceHistory: [
        { price: 300_000, qualifier: null, seenAt: '2026-10-01T09:00:00Z' },
        { price: 290_000, qualifier: null, seenAt: '2026-10-12T09:00:00Z' },
      ],
    }));
    expect(cells['First Price Seen']).toBe('300000');
    expect(cells['Price Change']).toBe('-10000');
    expect(cells['Price History']).toBe('2026-10-01 300000; 2026-10-12 290000');
    expect(row(listing())['Price Change']).toBe('');
  });

  it('includes the stage, follow-up and notes', () => {
    const csv = listingsToCsv([listing()], {
      'openrent:1': { pipeline: { status: 'viewing', notes: 'Call =agent', followUp: '2026-10-30', updatedAt: '' } },
    });
    const [headers, cells] = csv.split('\n').map((line) => line.split(','));
    const cell = (name: string) => cells![headers!.indexOf(name)];
    expect(cell('Stage')).toBe('Viewing booked');
    expect(cell('Follow Up')).toBe('2026-10-30');
    expect(cell('Notes')).toBe('Call =agent');
    expect(row(listing())['Stage']).toBe('New');
  });
});
