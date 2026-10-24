import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { getAdapterForUrl } from '../src/adapters';
import { zooplaLabel } from '../src/adapters/zoopla';

/**
 * Each site adapter run against a small page built the way that site builds
 * its listing pages. When a site changes its page, saving the real page and
 * putting it in here shows exactly which field went missing.
 */

/** Put `html` in place as the page at `url` */
function openPage(url: string, html: string) {
  const { document } = parseHTML(html);
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', { location: new URL(url) });
}

afterEach(() => vi.unstubAllGlobals());

async function capture(url: string, html: string) {
  openPage(url, html);
  const adapter = getAdapterForUrl(url);
  if (!adapter) throw new Error(`No adapter for ${url}`);
  return adapter.extract();
}

/**
 * Rightmove's packed page model: a flat array where every object value and
 * array item is the index of another entry, and entry 0 is the root.
 */
function pack(root: unknown): unknown[] {
  const out: unknown[] = [];
  const add = (value: unknown): number => {
    const index = out.length;
    out.push(null);
    if (Array.isArray(value)) out[index] = value.map(add);
    else if (value && typeof value === 'object') {
      out[index] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, add(v)]));
    } else out[index] = value;
    return index;
  };
  add(root);
  return out;
}

describe('Rightmove', () => {
  const propertyData = {
    id: '160123456',
    address: { displayAddress: 'Tweedsmuir Road, Cardiff, CF24', outcode: 'CF24', incode: '2QH' },
    prices: { primaryPrice: '£295,000', displayPriceQualifier: 'Offers in Excess of' },
    transactionType: 'BUY',
    bedrooms: 3,
    propertySubType: 'Terraced',
    sizings: [{ unit: 'sqft', minimumSize: 1023, maximumSize: 1023 }, { unit: 'sqm', minimumSize: 95, maximumSize: 95 }],
    keyFeatures: ['Three bedrooms', 'EPC Rating: D', 'No onward chain'],
    text: { pageTitle: '3 bedroom terraced house for sale', description: 'A bay fronted family home close to Roath Park.' },
    location: { latitude: 51.4983, longitude: -3.1621 },
    customer: { companyName: 'Jeffrey Ross', branchDisplayName: 'Jeffrey Ross, Cathays' },
    contactInfo: { telephoneNumbers: { localNumber: '029 2000 0000' } },
    tenure: { tenureType: 'FREEHOLD' },
    listingHistory: { listingUpdateReason: 'Reduced on 12/10/2026' },
  };
  // Where a saved Rightmove page keeps the date the listing was added
  const analyticsInfo = { analyticsProperty: { added: '20260918' } };
  const page = (model: unknown) => `<!doctype html><html><head><title>Rightmove</title></head><body>
    <script>window.__PAGE_MODEL = ${JSON.stringify({ data: JSON.stringify(model) })};</script>
  </body></html>`;
  const url = 'https://www.rightmove.co.uk/properties/160123456#/';

  it('reads the listing from the packed page model', async () => {
    const listing = await capture(url, page(pack({ propertyData, analyticsInfo })));
    expect(listing).toMatchObject({
      listedOn: '2026-09-18',
      portalPriceChanges: [{ date: '2026-10-12', direction: 'down' }],
      source: 'rightmove',
      listingId: '160123456',
      displayAddress: 'Tweedsmuir Road, Cardiff, CF24',
      postcode: 'CF24 2QH',
      postcodePartial: 'CF24',
      price: 295_000,
      priceQualifier: 'Offers in Excess of',
      listingType: 'sale',
      bedrooms: 3,
      propertyType: 'Terraced',
      floorAreaSqm: 95,
      epcRating: 'D',
      agentName: 'Jeffrey Ross',
      agentBranch: 'Jeffrey Ross, Cathays',
      agentPhone: '029 2000 0000',
      latitude: 51.4983,
      longitude: -3.1621,
      tenure: 'FREEHOLD',
      fullAddress: null,
    });
  });

  it('says so when the page model is missing, instead of saving an empty listing', async () => {
    vi.useFakeTimers();
    try {
      const result = capture(url, '<!doctype html><html><body><p>Nothing here</p></body></html>');
      const expectation = expect(result).rejects.toThrow('Could not read Rightmove page data');
      // The page-script fallback gives up after 3 seconds
      await vi.advanceTimersByTimeAsync(3000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a page left over from another listing', () => {
  it('is refused instead of saving one home under another\'s number', async () => {
    const zooplaPage = `<html><head><script>{"listing_id":"67000001","display_address":"Old Road, Cardiff CF11"}</script></head><body></body></html>`;
    await expect(capture('https://www.zoopla.co.uk/for-sale/details/67012345/', zooplaPage)).rejects.toThrow(/Reload the page/);

    const model = { data: JSON.stringify(pack({ propertyData: { id: '160000001', address: { displayAddress: 'Old Road' } } })) };
    const rightmovePage = `<html><body><script>window.__PAGE_MODEL = ${JSON.stringify(model)};</script></body></html>`;
    await expect(capture('https://www.rightmove.co.uk/properties/160123456', rightmovePage)).rejects.toThrow(/Reload the page/);
  });
});

describe('Zoopla', () => {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    name: '2 bed flat for sale in Ferry Court, Cardiff CF11',
    description: 'A second floor apartment with a balcony over the bay.',
    offers: { '@type': 'Offer', price: 185000, priceCurrency: 'GBP' },
    floorSize: { '@type': 'QuantitativeValue', value: 63, unitCode: 'MTK' },
  };
  // Zoopla's page data, as a Next.js flight string with escaped quotes
  const pageData = JSON.stringify({
    listing_id: '67012345', display_address: 'Ferry Court, Cardiff CF11', outcode: 'CF11', incode: '0AS',
    price: 185000, price_qualifier: 'guide_price', num_beds: 2, property_type: 'flat',
    branch_name: 'Moginie James', tenure: 'leasehold', epcRating: 'C',
    latitude: 51.4655, longitude: -3.1733, redirectPhone: '029 2111 1111',
    // As on a saved Zoopla page: first published, and dated price changes without amounts
    publishedOn: '2026-03-06T16:13:52',
    priceHistory: { priceChanges: [{ isPriceDrop: true, priceChangeDate: '2026-04-07T09:56:04' }, { isPriceDrop: true, priceChangeDate: '2026-08-28T14:37:57' }] },
  }).replace(/"/g, '\\"');
  const page = `<!doctype html><html><head>
    <meta name="description" content="2 bed flat for sale in Ferry Court">
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  </head><body><script>self.__next_f.push([1,"${pageData}"])</script></body></html>`;

  it('reads the listing from JSON-LD and the page data', async () => {
    const listing = await capture('https://www.zoopla.co.uk/for-sale/details/67012345/', page);
    expect(listing).toMatchObject({
      source: 'zoopla',
      listingId: '67012345',
      displayAddress: 'Ferry Court, Cardiff CF11',
      postcode: 'CF11 0AS',
      postcodePartial: 'CF11',
      price: 185_000,
      listingType: 'sale',
      bedrooms: 2,
      propertyType: 'Flat',
      priceQualifier: 'Guide price',
      tenure: 'Leasehold',
      floorAreaSqm: 63,
      epcRating: 'C',
      agentName: 'Moginie James',
      agentPhone: '029 2111 1111',
      latitude: 51.4655,
      longitude: -3.1733,
      listedOn: '2026-03-06',
      portalPriceChanges: [{ date: '2026-04-07', direction: 'down' }, { date: '2026-08-28', direction: 'down' }],
    });
  });

  it('knows a rental from the address', async () => {
    const listing = await capture('https://www.zoopla.co.uk/to-rent/details/67012345/', page);
    expect(listing.listingType).toBe('rent');
  });
});

describe('Zoopla codes', () => {
  it('shows the codes from a saved Zoopla page as words', () => {
    expect(zooplaLabel('offers_over')).toBe('Offers over');
    expect(zooplaLabel('share_of_freehold')).toBe('Share of freehold');
    expect(zooplaLabel('flat')).toBe('Flat');
    expect(zooplaLabel('semi_detached_house')).toBe('Semi-detached house');
    expect(zooplaLabel('end_terrace_house')).toBe('End terrace house');
    expect(zooplaLabel('poa')).toBe('POA');
    expect(zooplaLabel('Guide price')).toBe('Guide price');
    expect(zooplaLabel('')).toBeNull();
    expect(zooplaLabel(undefined)).toBeNull();
  });
});

describe('OpenRent', () => {
  const page = `<!doctype html><html><head>
    <title>London - 1 Bed Flat, Rochester Row, SW1P - To Rent Now for £2,800.00 p/m</title>
  </head><body>
    <div id="map" data-lat="51.4943" data-lng="-0.1356"></div>
    <a href="/comparebroadband?postCode=SW1P%201LQ">Compare broadband</a>
    <table>
      <tr><td>Rent PCM</td><td>£2,800.00</td></tr>
      <tr><td>Deposit</td><td>£3,230.77</td></tr>
      <tr><td>Furnishing</td><td>Furnished</td></tr>
      <tr><td>EPC Rating</td><td>C (72)</td></tr>
    </table>
    <div class="landlord-profile"><p>Jane D.</p></div>
    <div id="descriptionText"><p>A bright one bedroom flat.</p><p>Total floor area 48 sq m.</p></div>
  </body></html>`;

  it('reads the listing from the page', async () => {
    const listing = await capture('https://www.openrent.co.uk/property-to-rent/london/1-bed-flat-rochester-row-sw1p/2345678', page);
    expect(listing).toMatchObject({
      source: 'openrent',
      listingId: '2345678',
      displayAddress: 'Rochester Row, SW1P',
      postcode: 'SW1P 1LQ',
      postcodePartial: 'SW1P',
      price: 2800,
      listingType: 'rent',
      bedrooms: 1,
      propertyType: 'Flat',
      deposit: 3230.77,
      furnished: 'Furnished',
      epcRating: 'C',
      agentName: 'Jane D.',
      latitude: 51.4943,
      longitude: -0.1356,
      floorAreaFromText: 48,
    });
  });
});

describe('which pages are listings', () => {
  it('matches listing pages only', () => {
    expect(getAdapterForUrl('https://www.rightmove.co.uk/properties/160123456')?.site).toBe('rightmove');
    expect(getAdapterForUrl('https://www.zoopla.co.uk/to-rent/details/67012345/')?.site).toBe('zoopla');
    expect(getAdapterForUrl('https://www.openrent.com/property-to-rent/cardiff/2-bed-flat/2345678')?.site).toBe('openrent');
    expect(getAdapterForUrl('https://www.rightmove.co.uk/property-for-sale/find.html?locationIdentifier=REGION')).toBeNull();
    expect(getAdapterForUrl('https://www.zoopla.co.uk/for-sale/property/cardiff/')).toBeNull();
    expect(getAdapterForUrl('https://example.com/properties/1')).toBeNull();
  });
});
