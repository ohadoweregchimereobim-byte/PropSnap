# PropSnap — Phase 0 Spike Report

**Date:** 3 October 2026  
**Status:** All three sites verified. Green light to build.

---

## 1. Data Structure by Site

### Rightmove (verified from listing #93305865)

**Data source:** `window.__PAGE_MODEL` — a packed JSON array where element 0 is a schema map and remaining elements are values referenced by index.

| Field | How to extract | Example |
|-------|---------------|---------|
| Address | `display_address` (via index chain) | "Massachusetts, Suffolk County, Boston, USA" |
| Postcode | Partial only (area-level in address string) | — |
| Price | Index chain from `propertyData.prices` | £1,432,226 |
| Bedrooms | Direct index | 4 |
| Property type | Direct index | Detached |
| Agent name | Index chain from `customerInfo` | Hamptons, International USA |
| Agent phone | Index chain from `customerInfo` | 020 3910 8418 |
| Coordinates | `propertyData.location` | Available |
| Listing ID | URL path `/properties/{id}` | 93305865 |

**Extraction method:** Inject content script, eval `__PAGE_MODEL`, unpack using schema map at index 0.  
**Risk:** Packed JSON format can change without warning. Need a version check or fallback.

---

### Zoopla (verified from listing #72600377)

**Data source:** Two clean sources:
1. JSON-LD (`application/ld+json`) with `schema.org/RealEstateListing`
2. Analytics tracking data embedded in page markup

| Field | How to extract | Example |
|-------|---------------|---------|
| Address | `display_address` in analytics data | Westfield Park Drive, Woodford Green IG8 |
| Full postcode | `outcode` + `incode` | IG8 + 8FD = **IG8 8FD** |
| Price | JSON-LD `offers.price` | £325,000 |
| Bedrooms | `num_beds` | 2 |
| Property type | `property_type` | flat |
| Agent name | `branch_name` | John Thoma Bespoke Estate Agents |
| Agent phone | `redirectPhone` | 020 8033 3521 |
| Coordinates | `location.coordinates` | lat 51.6049, lng 0.054 |
| Listing ID | `listing_id` | 72600377 |
| Tenure | `tenure` | share_of_freehold |
| Has EPC | `has_epc` | false |
| Has floorplan | `has_floorplan` | true |

**Extraction method:** Parse JSON-LD from `<script type="application/ld+json">` tags + regex/parse the analytics tracking block.  
**Risk:** Lowest of the three. JSON-LD is a web standard; unlikely to change format.

---

### OpenRent (verified from listing #2994804)

**Data source:** Server-rendered HTML. No JSON-LD, no `__NEXT_DATA__`, no packed JSON. Data lives directly in HTML tables and semantic elements.

| Field | How to extract | Example |
|-------|---------------|---------|
| Address | Page title / meta description | Rochester Row, SW1P |
| Full postcode | Broadband comparison link (`postCode=` param) | **SW1P 1LQ** |
| Price (rent PCM) | HTML table row "Rent PCM" | £2,800.00 |
| Bedrooms | Page title ("1 Bed Flat") | 1 |
| Property type | URL slug + title | Flat |
| Landlord name | Profile section `<p>` tag | Serhiy K. |
| Landlord ID | Profile link `landlordID=` param | 9206477 |
| Member since | Profile section | July 2026 |
| Phone verified | Profile section (yes/no, not the actual number) | Yes |
| Response rate | Profile section | 100% |
| Coordinates | `lat` / `lng` attributes on map elements | 51.493572, -0.136922 |
| Listing ID | URL path + image CDN paths | 2994804 |
| Deposit | HTML table row | £2,800.00 |
| Furnished | HTML table row | Furnished |
| EPC status | HTML table row | EPC Not Required |

**Extraction method:** DOM scraping with `querySelector` on HTML tables and profile sections. Parse page title for bedrooms and property type.  
**Risk:** DOM structure can change with redesigns. Need resilient selectors (data attributes > class names). OpenRent is a private landlord platform — we get the landlord's first name + initial, NOT a phone number.

---

## 2. Full Postcode Availability

| Site | Postcode in listing | How to get full postcode |
|------|--------------------|-----------------------|
| Rightmove | Partial (area only) | EPC API lookup by coordinates + partial address |
| Zoopla | **Full** (`outcode` + `incode`) | Directly from page data |
| OpenRent | **Full** (broadband link leaks it) | Parse `postCode=` URL parameter |

**Bottom line:** Zoopla and OpenRent give us the full postcode for free. Rightmove is the only one that needs EPC cross-referencing to get it.

---

## 3. EPC Register API

**Endpoint:** `https://epc.opendatacommunities.org/api/v1/domestic/search`  
**Auth:** Free registration, email + API key, HTTP Basic auth  
**Search params:** `postcode`, `address`  
**Response fields include:** `ADDRESS1`, `ADDRESS2`, `ADDRESS3`, `POSTCODE` (93+ total fields)  
**Cost:** Free  
**Rate limits:** Not documented, but reasonable use expected  
**Status:** The old `epc.opendatacommunities.org` domain redirects to a new GOV.UK service, but the API endpoints are still referenced in active open-source projects (last updated 2025-2026). Registration required before we can test live.

**Proven approach:** An existing Apify tool ("Rightmove EPC Full Address Finder") already does this exact cross-referencing — confirming the method works.

**Action needed:** Register for an API key at `get-energy-performance-data.communities.gov.uk` and run a test query.

---

## 4. Extraction Strategy Summary

```
Rightmove  →  window.__PAGE_MODEL (packed JSON)  →  unpack via schema map
Zoopla     →  JSON-LD + analytics tracking block  →  parse JSON + regex
OpenRent   →  server-rendered HTML tables          →  DOM querySelector
```

All three sites deliver data client-side (no server-side API calls needed from the extension). Content scripts can extract everything.

---

## 5. Address Enrichment Pipeline

```
Listing page data (partial address + postcode + coordinates)
    │
    ├─ Zoopla / OpenRent: full postcode already available
    │
    └─ Rightmove: partial postcode only
            │
            ▼
    EPC API search by postcode
            │
            ▼
    Match on: bedrooms + property type + coordinates proximity
            │
            ▼
    Full street address (ADDRESS1 = house number + street)
```

---

## 6. Legal Quick Check

**Rightmove ToS:** Prohibits automated scraping/crawling. However, a Chrome extension that reads data already loaded in the user's browser tab (as the user views it) operates in a grey area — it's reading the user's own browser DOM, not hitting Rightmove's servers. PropertyEngine and similar tools have operated this way for years. Risk: moderate. Mitigation: don't hit their servers directly, don't redistribute raw data at scale.

**Zoopla ToS:** Similar restrictions to Rightmove. Same grey area applies.

**OpenRent ToS:** More permissive platform (aimed at private landlords), but same principle — read the DOM the user already loaded.

**EPC Register:** Public data, explicitly provided via a free API for developers. No legal concerns.

**GDPR:** Landlord names visible on OpenRent are already publicly displayed by the landlords themselves. Agent names and phone numbers are business contact data. No personal data processing beyond what's already public.

---

## 7. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Rightmove changes packed JSON format | High | Version detection, fallback selectors, alerts on extraction failure |
| EPC API deprecated or moved | Medium | Already redirecting to new domain — register on new service, keep old as fallback |
| Site redesign breaks DOM selectors (OpenRent) | Medium | Use data attributes where possible, test suite per site, alert on failure rate |
| Legal challenge from property portals | Low-Medium | Extension reads user's own DOM, doesn't scrape servers. Same model as PropertyEngine. |
| Rate limiting on EPC API | Low | Cache results, batch lookups, respect rate limits |
| OpenRent doesn't expose landlord phone | N/A | Known limitation — we get landlord name + ID only. Phone is verified but hidden. |

---

## 8. Verdict

**Green light.** All three sites expose enough data for our core use case. The extraction methods are clear, the EPC API is free and available, and the approach is proven by existing tools in the market.

**Next step:** Start building Phase 1 — the Chrome extension with site adapters for Rightmove, Zoopla, and OpenRent.

**One action item before code:** Register for an EPC API key at `get-energy-performance-data.communities.gov.uk`.
