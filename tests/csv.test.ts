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
    expect(cell('Summary')).toBe('Call =agent');
    expect(row(listing())['Stage']).toBe('New');
  });

  it('includes the labels, hidden and the last call', () => {
    const csv = listingsToCsv([listing()], {
      'openrent:1': {
        labels: ['BRR', 'Needs work'],
        hidden: true,
        activity: [
          { id: 'a', at: '2026-10-18T09:00:00Z', kind: 'call', text: '', outcome: 'no_answer' },
          { id: 'b', at: '2026-10-20T09:00:00Z', kind: 'call', text: 'flexible on price', outcome: 'spoke' },
          { id: 'c', at: '2026-10-21T09:00:00Z', kind: 'note', text: 'later note' },
        ],
      },
    });
    const [headers, cells] = csv.split('\n').map((line) => line.split(','));
    const cell = (name: string) => cells![headers!.indexOf(name)];
    expect(cell('Labels')).toBe('BRR; Needs work');
    expect(cell('Hidden')).toBe('yes');
    expect(cell('Last Call')).toBe('2026-10-20 Spoke to the agent: flexible on price');
    expect(row(listing())['Last Call']).toBe('');
  });

  it("includes the site's listed date, days on the market and its price changes", () => {
    const csv = listingsToCsv([listing({ listedOn: '2026-03-06', portalPriceChanges: [{ date: '2026-04-07', direction: 'down' }, { date: '2026-08-28', direction: 'down' }] })], {}, '2026-10-24');
    const [headers, cells] = csv.split('\n').map((line) => line.split(','));
    const cell = (name: string) => cells![headers!.indexOf(name)];
    expect(cell('Listed On')).toBe('2026-03-06');
    expect(cell('Days On Market')).toBe('232');
    expect(cell('Site Price Changes')).toBe('2026-04-07 down; 2026-08-28 down');
    expect(row(listing())['Days On Market']).toBe('');
  });

  it('includes the area checks, blank when not checked', () => {
    const cells = row(listing({ area: { checkedAt: '2026-10-24T12:00:00Z', floodZone: 'FZ3', conservation: 'Cathedral Road', article4Count: 1, hmoArticle4: true, crimeTotal: 286, crimeMonth: '2026-08' } }));
    expect(cells['Flood Zone']).toBe('Zone 3');
    expect(cells['Conservation Area']).toBe('Cathedral Road');
    expect(cells['Article 4 Directions']).toBe('1');
    expect(cells['HMO Article 4']).toBe('yes');
    expect(cells['Street Crimes']).toBe('286 in 2026-08 (about 1 mile)');
    expect(cells['Area Checked']).toBe('2026-10-24');
    const clear = row(listing({ area: { checkedAt: '2026-10-24T12:00:00Z', floodZone: 'none', conservation: '', article4Count: 0, hmoArticle4: false, crimeTotal: null, crimeMonth: null } }));
    expect([clear['Flood Zone'], clear['Conservation Area'], clear['HMO Article 4'], clear['Street Crimes']]).toEqual(['No', 'No', 'no', '']);
    expect(row(listing())['Flood Zone']).toBe('');
  });

  it("includes the certificate's rating now and potential", () => {
    const cells = row(listing({ epcEnergy: { certificateNumber: 'c', currentBand: 'E', potentialBand: 'C', currentScore: 50, potentialScore: 72, registrationDate: null, improvements: [] } }));
    expect(cells['EPC Certificate Now']).toBe('E 50');
    expect(cells['EPC Potential']).toBe('C 72');
    expect(row(listing())['EPC Potential']).toBe('');
  });
});
