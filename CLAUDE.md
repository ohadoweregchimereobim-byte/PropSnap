# PropSnap

Chrome extension (Manifest V3, WXT framework) that captures property listing data from UK property websites and enriches it with full street addresses via the EPC Register API.

## What it does

Users browse Rightmove, Zoopla, or OpenRent listings. They click "Capture" in the popup. The extension extracts listing data from the page, calls the EPC API to get the full street address (which listing sites hide), and saves everything locally with CSV export.

## Architecture

- **Content scripts** (`entrypoints/content/`) — inject into listing pages, extract data using site-specific adapters
- **Background service worker** (`entrypoints/background.ts`) — handles EPC API calls (cross-origin), storage, CSV export
- **Popup** (`entrypoints/popup/`) — UI for capture button, result display, settings, export
- **Dashboard** (`entrypoints/dashboard/`, built as `dashboard.html`) — full-page table of saved listings, opened from the popup's Dashboard button: search, site/match filters, sorting, open, delete, clear all, CSV export. Reads `chrome.storage.local` directly and redraws on `storage.onChanged`. Filter/sort logic is pure in `src/services/dashboard-view.ts` (tested)

## Site adapters (`src/adapters/`)

Each site exposes data differently:

### Rightmove (`rightmove.ts`)
- Data source: `window.__PAGE_MODEL` — packed JSON format (schema map at index 0, values by index)
- Content scripts can't access page JS vars, so we inject a `<script>` element and pass data back via CustomEvent (`__PROPSNAP_DATA__`)
- Only gives partial postcode from address string — needs EPC for full postcode

### Zoopla (`zoopla.ts`)
- Data source: JSON-LD (`<script type="application/ld+json">`) with `@type: "RealEstateListing"`
- Also regex-parses analytics tracking data from script tags for `branch_name`, `listing_id`, `outcode`, `incode`
- Gets full postcode by combining outcode + incode

### OpenRent (`openrent.ts`)
- Data source: Server-rendered HTML, DOM scraping via `querySelector`
- Parses page title for bedrooms/type/address
- Extracts full postcode from broadband comparison link (`/comparebroadband?postCode=SW1P%201LQ`)
- Reads HTML table rows for rent/deposit/furnished/EPC

## EPC API (`src/services/epc-api.ts`)

- Endpoint: `https://api.get-energy-performance-data.communities.gov.uk/api/domestic/search?postcode=...`
  (the old `epc.opendatacommunities.org` API was retired on 30 May 2026)
- Docs: https://get-energy-performance-data.communities.gov.uk/api-technical-documentation
- Auth: Bearer token (user enters in settings)
- Response: `{ data: [ { addressLine1-4, postTown, postcode, currentEnergyEfficiencyBand, registrationDate, uprn, certificateNumber } ] }`; 404 means no certificates
- Only searches with a **full** postcode; a half postcode (e.g. `CF14`) returns `no_postcode` instead of guessing
- Keeps the newest certificate per home, then ranks candidates in `src/services/epc-match.ts` (pure, unit tested in `tests/`):
  house/flat number (a clash rules a home out), floor area, flat vs house (a clash rules a home out), built form, habitable rooms vs bedrooms, address words, postcode
- Search results have no bedrooms/property type, so for the homes still close after the first pass (max 10) we fetch the full certificate (`GET /api/certificate?certificate_number=...`: `dwelling_type`, `habitable_room_count`, `total_floor_area`) and rank again. Newer (RdSAP 2026) certificates wrap values (`dwelling_type: { value: "Detached house" }`), give `property_type`/`built_form` as codes (0 House, 1 Bungalow, 2 Flat, 3 Maisonette / 1 Detached, 2 Semi-Detached, 3 End-Terrace, 4 Mid-Terrace) and repeat floor areas per floor; `readDetails` unwraps `value`, prefers words over codes, and takes the shallowest match (max depth 3) so one floor's area never counts as the home's. A 400/404/405 there turns the lookup off for the session. If some close homes got details and others did not (more than 10, or a failed lookup), the result can't be `exact`
- `addressConfidence`: `exact` when one home beats the rest by 2+ points with real evidence, else `best_guess`; `enrichmentDetail` says what it matched on
- On a `best_guess` the close homes are saved as `addressCandidates` (best guess first, max 15). The dashboard lets the user pick one (`src/services/address-choice.ts`), which sets `addressConfidence: 'user_choice'`; a new capture of the same listing with the same postcode keeps that pick unless it finds an `exact` match
- Listing floor area (`floorAreaSqm`) comes from Rightmove `sizings`, and on Zoopla from JSON-LD `floorSize`, else the page data's `floorArea` object or `sizeSqFeet`. Zoopla's `ingested.sizeSqft` is ignored: it is estimated from neighbouring homes
- When the site gives no size, `src/adapters/floor-area-text.ts` reads one from the description (all 3 sites) into `floorAreaFromText`. It is strict: the clause must say it is the whole home (or be the size alone), any room/garden/plot word rules it out, and sizes that disagree give null. The background uses it only when the "Find the size in the listing text" setting is on (default on); `floorAreaSource` records `listing` or `text`, and the match detail says "floor area from the description"
- Listing EPC band (`epcRating`) comes from Zoopla's `epcRating` field, Rightmove "EPC Rating: X" text in key features/description, and OpenRent's table row (`src/adapters/epc-band.ts`); a home with the same band gets +2. The listing's own rating is never replaced, and the certificate's rating is only borrowed on an exact match

## Storage (`src/services/storage.ts`)

- Uses `chrome.storage.local`
- Deduplicates by `source:listingId`
- Settings: EPC API token, auto-enrich toggle, floor area from description toggle
- CSV export of all saved listings, with the match detail saved per listing. Text cells starting with `= + - @` get a `'` so Excel won't run them; the popup adds a UTF-8 byte order mark

## Data flow

1. User opens a listing page → content script detects it, notifies background (badge turns green)
2. User clicks "Capture" in popup → popup sends `EXTRACT_LISTING` to content script
3. Content script runs the matching adapter → returns extracted data to popup
4. Popup sends `CAPTURE_AND_ENRICH` to background → background calls EPC API if enabled
5. Background saves enriched listing → returns to popup for display

## Tech stack

- WXT framework (Vite-based Chrome extension tooling)
- TypeScript
- Chrome Manifest V3
- No UI framework (vanilla DOM)

## Build

```
npm install
npm run build    # outputs to .output/chrome-mv3/
npm run dev      # dev mode with hot reload
```

Load the extension: Chrome → `chrome://extensions` → Enable Developer mode → Load unpacked → select `.output/chrome-mv3/`
