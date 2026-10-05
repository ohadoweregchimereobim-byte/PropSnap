# PropSnap

Chrome extension (Manifest V3, WXT framework) that captures property listing data from UK property websites and enriches it with full street addresses via the EPC Register API.

## What it does

Users browse Rightmove, Zoopla, or OpenRent listings. They click "Capture" in the popup. The extension extracts listing data from the page, calls the EPC API to get the full street address (which listing sites hide), and saves everything locally with CSV export.

## Architecture

- **Content scripts** (`entrypoints/content/`) — inject into listing pages, extract data using site-specific adapters
- **Background service worker** (`entrypoints/background.ts`) — handles EPC API calls (cross-origin), storage, CSV export
- **Popup** (`entrypoints/popup/`) — UI for capture button, result display, settings, export

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

- Endpoint: `https://epc.opendatacommunities.org/api/v1/domestic/search`
- Auth: Bearer token (user enters in settings)
- Search by postcode, filter by address similarity scoring
- Returns: ADDRESS1, ADDRESS2, ADDRESS3, POSTCODE, CURRENT_ENERGY_RATING
- Key value: provides the **full street address** that listing sites redact

## Storage (`src/services/storage.ts`)

- Uses `chrome.storage.local`
- Deduplicates by `source:listingId`
- Settings: EPC API token, auto-enrich toggle
- CSV export of all saved listings

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
