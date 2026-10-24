/**
 * HM Land Registry Price Paid Data (England and Wales sales since 1995).
 *
 * Asked through the public SPARQL endpoint. No key is needed. The answer is the
 * W3C SPARQL JSON format: { results: { bindings: [ { name: { value } } ] } }.
 * Query building and parsing are pure and unit tested; only fetchSoldPrices
 * goes to the network.
 *
 * Licence: Open Government Licence v3.0. Pages that show this data must show
 * "Contains HM Land Registry data © Crown copyright and database right".
 */

import { readCache, writeCache } from './session-cache';

export const LAND_REGISTRY_ENDPOINT = 'https://landregistry.data.gov.uk/landregistry/query';

export type LrPropertyType = 'detached' | 'semi-detached' | 'terraced' | 'flat-maisonette' | 'other';

export interface SoldPrice {
  /** The transaction's own URI, unique per sale */
  id: string;
  price: number;
  /** YYYY-MM-DD */
  date: string;
  saon: string | null;  // Flat or unit, e.g. "FLAT 3"
  paon: string | null;  // House number or name, e.g. "12" or "ROSE COTTAGE"
  street: string | null;
  town: string | null;
  postcode: string | null;
  propertyType: LrPropertyType;
  tenure: 'freehold' | 'leasehold' | null;
  newBuild: boolean;
  /** False for "additional" sales: repossessions, sales to companies, and similar */
  standard: boolean;
}

const PREFIXES = `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>`;

const SELECT = 'SELECT ?transx ?amount ?date ?paon ?saon ?street ?town ?postcode ?propertyType ?estateType ?newBuild ?category';

const TRANSACTION = `?transx lrppi:propertyAddress ?addr ;
          lrppi:pricePaid ?amount ;
          lrppi:transactionDate ?date ;
          lrppi:propertyType ?propertyType .
  OPTIONAL { ?transx lrppi:estateType ?estateType }
  OPTIONAL { ?transx lrppi:newBuild ?newBuild }
  OPTIONAL { ?transx lrppi:transactionCategory ?category }
  OPTIONAL { ?addr lrcommon:paon ?paon }
  OPTIONAL { ?addr lrcommon:saon ?saon }
  OPTIONAL { ?addr lrcommon:town ?town }`;

const FULL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/;
const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/;
// Land Registry streets are upper case words; anything else is not sent
const STREET = /^[A-Z0-9][A-Z0-9 '&.,-]{1,60}$/;

/** "cf14 9bp" / "CF149BP" → "CF14 9BP"; null when it is not a full postcode */
export function formatPostcode(postcode: string | null | undefined): string | null {
  const compact = (postcode ?? '').toUpperCase().replace(/\s+/g, '');
  const formatted = compact.length > 3 ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : compact;
  return FULL_POSTCODE.test(formatted) ? formatted : null;
}

function literal(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"^^xsd:string`;
}

/** Every sale in one full postcode, newest first */
export function postcodeQuery(postcode: string, limit = 200): string | null {
  const pc = formatPostcode(postcode);
  if (!pc) return null;
  return `${PREFIXES}
${SELECT}
WHERE {
  VALUES ?postcode { ${literal(pc)} }
  ?addr lrcommon:postcode ?postcode .
  OPTIONAL { ?addr lrcommon:street ?street }
  ${TRANSACTION}
}
ORDER BY DESC(?date)
LIMIT ${limit}`;
}

/** Every sale on one street within a postcode district (e.g. "TWEEDSMUIR ROAD" in "CF24"), newest first */
export function streetQuery(street: string, outcode: string, limit = 300): string | null {
  const s = street.trim().toUpperCase().replace(/\s+/g, ' ');
  const out = outcode.trim().toUpperCase();
  if (!STREET.test(s) || !OUTCODE.test(out)) return null;
  return `${PREFIXES}
${SELECT}
WHERE {
  VALUES ?street { ${literal(s)} }
  ?addr lrcommon:street ?street ;
        lrcommon:postcode ?postcode .
  FILTER(STRSTARTS(?postcode, ${literal(`${out} `)}))
  ${TRANSACTION}
}
ORDER BY DESC(?date)
LIMIT ${limit}`;
}

type Binding = Record<string, { value?: string } | undefined>;

const TYPES: Record<string, LrPropertyType> = {
  detached: 'detached',
  'semi-detached': 'semi-detached',
  terraced: 'terraced',
  'flat-maisonette': 'flat-maisonette',
  'other-property-type': 'other',
};

/** Last part of a URI: ".../def/common/semi-detached" → "semi-detached" */
function tail(uri: string | undefined): string {
  return (uri ?? '').split(/[/#]/).pop()?.toLowerCase() ?? '';
}

function text(b: Binding, name: string): string | null {
  const value = b[name]?.value?.trim();
  return value ? value : null;
}

/** Turn SPARQL JSON into sales. Rows without a price or date are dropped. */
export function parseSoldPrices(json: unknown): SoldPrice[] {
  const bindings = (json as { results?: { bindings?: Binding[] } } | null)?.results?.bindings;
  if (!Array.isArray(bindings)) return [];

  const sales: SoldPrice[] = [];
  for (const b of bindings) {
    const price = Number(text(b, 'amount'));
    const date = text(b, 'date')?.slice(0, 10) ?? '';
    if (!(price > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const estate = tail(text(b, 'estateType') ?? undefined);
    const newBuild = text(b, 'newBuild');
    const category = tail(text(b, 'category') ?? undefined);
    sales.push({
      id: text(b, 'transx') ?? `${date}|${price}|${text(b, 'saon')}|${text(b, 'paon')}|${text(b, 'street')}|${text(b, 'postcode')}`,
      price,
      date,
      saon: text(b, 'saon'),
      paon: text(b, 'paon'),
      street: text(b, 'street'),
      town: text(b, 'town'),
      postcode: text(b, 'postcode'),
      propertyType: TYPES[tail(text(b, 'propertyType') ?? undefined)] ?? 'other',
      tenure: estate === 'freehold' || estate === 'leasehold' ? estate : null,
      newBuild: newBuild === 'true' || newBuild === '1',
      // Category B ("additional price paid") covers repossessions, buy-to-let
      // company purchases and transfers; anything not plainly B counts as standard
      standard: !/additional|category-b|^b$/.test(category),
    });
  }
  return sales;
}

/** Sales from several queries, each once, newest first */
export function mergeSales(...lists: SoldPrice[][]): SoldPrice[] {
  const byId = new Map<string, SoldPrice>();
  for (const sale of lists.flat()) if (!byId.has(sale.id)) byId.set(sale.id, sale);
  return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date) || b.price - a.price);
}

async function runQuery(query: string, signal: AbortSignal): Promise<SoldPrice[]> {
  const response = await fetch(LAND_REGISTRY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
    },
    body: new URLSearchParams({ query }).toString(),
    signal,
  });
  if (!response.ok) throw new Error(`Land Registry answered ${response.status}`);
  return parseSoldPrices(await response.json());
}

/**
 * Sales in the full postcode and on the same street in the postcode district.
 * Either part can be missing; with neither there is nothing to ask.
 */
export async function fetchSoldPrices(
  where: { postcode: string | null; street: string | null; outcode: string | null },
  timeoutMs = 25_000,
): Promise<SoldPrice[]> {
  const queries = [
    where.postcode ? postcodeQuery(where.postcode) : null,
    where.street && where.outcode ? streetQuery(where.street, where.outcode) : null,
  ].filter((q): q is string => q !== null);
  if (queries.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const results = await Promise.allSettled(queries.map((q) => runQuery(q, controller.signal)));
    const ok = results.filter((r): r is PromiseFulfilledResult<SoldPrice[]> => r.status === 'fulfilled');
    if (ok.length === 0) {
      const reason = (results[0] as PromiseRejectedResult).reason;
      throw controller.signal.aborted ? new Error('Land Registry did not answer in time') : reason;
    }
    return mergeSales(...ok.map((r) => r.value));
  } finally {
    clearTimeout(timer);
  }
}

/** Land Registry adds sales once a month, so a day-old answer is as good as a new one */
const SOLD_CACHE_MS = 24 * 60 * 60_000;

type SoldArea = { postcode: string | null; street: string | null; outcode: string | null };

/**
 * fetchSoldPrices, with the answer kept for a day so opening the same listing
 * again is instant. `fresh` asks Land Registry again (the Refresh button).
 * `at` says when the sales were fetched.
 */
export async function fetchSoldPricesCached(
  where: SoldArea,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<{ sales: SoldPrice[]; at: number }> {
  // The same area however it is spelled
  const tidy = (v: string | null) => (v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  const key = `sold:${formatPostcode(where.postcode) ?? ''}|${tidy(where.street)}|${tidy(where.outcode)}`;
  if (!fresh) {
    const kept = await readCache<SoldPrice[]>(key);
    if (kept) return { sales: kept.value, at: kept.at };
  }
  const sales = await fetchSoldPrices(where);
  await writeCache(key, sales, SOLD_CACHE_MS);
  return { sales, at: Date.now() };
}
