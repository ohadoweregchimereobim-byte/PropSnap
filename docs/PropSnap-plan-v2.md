# PropSnap: Product and Build Plan (v2 — Updated 2 October 2026)

## Context

PropSnap is a Chrome extension plus web dashboard for UK property professionals (letting agents, deal sourcers, investors, serviced accommodation operators). The extension spots a listing page on Rightmove, Zoopla, OpenRent and similar, pulls out the key fields, and sends them to a backend. The dashboard is where captured properties get organised, compared and exported.

**Core data points (MVP):** full address, price, bedrooms, property type, agent contact (name + phone). Photos, description, EPC and so on are bonus for later.

Nothing gets built until you approve this. No code has been written.

**Repo note.** PropSnap should live in a new repo, separate from ShiftAlert.

---

## Competitor Research: PropertyEngine

Source: propertyengine.co.uk (features, pricing and help pages).

- Founded 2020, Bristol. Positioned as a deal-sourcing tool for investors.
- Their core is a searchable database of for-sale listings across England, Wales and Scotland, with instant email alerts (about 10 minutes from listing), filters for reduced/back-on-market/Article 4/HMO/probate/planning, comparables, and one-click deal packaging.
- They have a Chrome extension.
- **Pricing:** Basic £24.99/month, Pro £89.99/month (popular), Ultimate £199.99/month.
- **Full addresses:** Yes — available on Pro and Ultimate tiers. They cross-reference listing data with public data sources (likely Land Registry + EPC register) to resolve the full street address.
- **Landlord phone number:** No. They provide **agent phone numbers** only.
- **Landlord contact method:** "Direct to vendor letters" — they pull the registered owner's name and correspondence address from Land Registry and let users send physical mail. No phone number.

**Positioning against them:** PropertyEngine is a **search and alerts engine**. PropSnap is a **capture and organise tool**. Do not try to out-database them. Win on a faster, cleaner capture flow, better contact handling, address enrichment in the extension itself (not just CSV export), and lettings plus agent workflows.

---

## What Is Actually Available on Listing Pages (Verified)

From our analysis of a live Rightmove listing page source:

**Rightmove** stores property data in `window.__PAGE_MODEL` using a packed JSON format (index-based array, not plain JSON). Confirmed available fields:

| Field | Location in data | Example |
|---|---|---|
| Address (partial) | `propertyData.address.displayAddress` | "Massachusetts, Suffolk County, Boston, USA" |
| Price | `propertyData.prices.primaryPrice` | "£1,432,226" |
| Bedrooms | `propertyData.bedrooms` | 4 |
| Property type | `propertyData.propertySubType` | "Detached" |
| Agent name | `propertyData.customer.branchDisplayName` | "Hamptons, International USA" |
| Agent phone | `propertyData.contactInfo.telephoneNumbers.localNumber` | "020 3910 8418" |
| Transaction type | `propertyData.transactionType` | "BUY" |
| Listing ID | `propertyData.id` | "93305865" |
| Map coordinates | `propertyData.location` | lat/lng values |

**What is NOT on the page:**
- Full street address (house number is deliberately hidden)
- Landlord's phone number (only the agent's number exists)
- Landlord's name
- Landlord's email

Zoopla and OpenRent have not been verified yet (Phase 0 task).

---

## The Two Hard Fields: How We Solve Them

### 1. Full Address

**The problem:** Listing sites deliberately hide house numbers. They show area-level addresses like "Pontypool, Torfaen" instead of "14 Oak Street, Pontypool, NP4 6AB".

**Our approach (core feature, not a nice-to-have):**

Step 1 — Capture what the listing page gives us: partial address, postcode area, and map pin coordinates (lat/lng).

Step 2 — Cross-reference against free and paid public data sources:

| Source | What it gives us | Cost |
|---|---|---|
| EPC Register API (domestic) | Full address of every property with an EPC certificate. Searchable by postcode. | Free (Open Data) |
| Land Registry Price Paid Data | Full address of every property sold since 1995. | Free (Open Data) |
| Land Registry Title Register | Owner name, correspondence address, tenure, title number. | £3 per title (HM Land Registry portal or API) |
| Council Tax Valuation | Full address and council tax band. | Free (VOA website) |

Step 3 — Match: use the listing's postcode + bedrooms + property type + coordinates to narrow down to likely addresses from these databases. Show a confidence label:
- **Exact** — single match, high certainty
- **Probable** — 2-3 candidates, best guess shown
- **Partial** — only area-level, user can correct manually

Step 4 — Let the user confirm or correct the address manually.

**This is the same approach PropertyEngine uses.** They charge £89.99/month for it on their Pro tier.

### 2. Landlord Contact

**The problem:** The landlord's phone number does not exist on any listing page. On Rightmove and Zoopla the contact is always the agent. On OpenRent the landlord is behind an enquiry wall.

**Our approach:**

- Capture and display the **agent's** contact details (name, phone, email) clearly labelled as "Agent".
- For landlord name: use Land Registry title data (£3 per lookup) to find the registered owner. Label as "Registered Owner" with a note that this is public record data.
- For landlord correspondence address: also from Land Registry. This enables "direct to vendor" letters, same as PropertyEngine.
- **No landlord phone number.** We do not attempt to find it. Nobody has this data, including PropertyEngine.
- Let users manually add a landlord's phone number when they get it through their own enquiry. PropSnap becomes the single place where all contact info lives.

### 3. Agent Business Social Media (Phase 2)

- Capture the agent's business LinkedIn, Facebook and Instagram pages where available on the listing page or agent profile page.
- **Landlord personal social media: excluded.** Systematically profiling private individuals from Land Registry records violates UK GDPR and would harm the product's credibility. This feature will not be built.

---

## My Recommendation (short version)

1. **Build capture first, perfectly, for 3 sites** (Rightmove, Zoopla, OpenRent). Add OnTheMarket and SpareRoom as site 4 and 5 after launch.
2. **One-click save is the product.** If saving takes more than 2 clicks or a few seconds, the rest does not matter.
3. **Address enrichment is a core feature, not phase 2.** This is what PropertyEngine charges £90/month for. Build it into the MVP using EPC and Land Registry data.
4. **Be honest about confidence.** Show a confidence indicator on resolved addresses rather than pretending every match is certain.
5. **Deterministic extraction, not AI, on the hot path.** Read the structured data the sites already embed in the page. Use an LLM only as a fallback or for tidying free text.
6. **Dashboard MVP = list, detail, compare, export.** Everything else is phase 2+.
7. **Stack:** WXT (Manifest V3, TypeScript, React, Tailwind) for the extension, Next.js on Vercel for the dashboard, Supabase for auth, Postgres and image storage.

---

## Part 1: The Chrome Extension (every screen)

### 1.1 Popup (the main UI, ~380px wide)

| # | State | What the user sees | Primary action |
|---|---|---|---|
| P1 | Signed out | Logo, one-line pitch, "Sign in" and "Create account" (opens dashboard) | Sign in |
| P2 | Home (not on a listing) | Recent captures (last 10), search box, counts per list, "Open dashboard" link, supported sites chips | Open dashboard |
| P3 | Listing detected | Preview card: address (with confidence badge), price, beds, type, agent contact. Each field editable inline. Missing fields highlighted amber. List picker, tags, notes box | **Save property** |
| P4 | Saved | Green confirmation, "View in dashboard", "Save another", undo | View |
| P5 | Already saved | "You saved this on 12/09/2026. Price changed from £1,200 to £1,150." | Update / Open |
| P6 | Partial extraction | Banner "We could not read: type". Manual entry fields | Save anyway |
| P7 | Unsupported site | "We do not support this site yet" plus "Request this site" link | Request |
| P8 | Limit reached | Plan usage bar and upgrade prompt | Upgrade |
| P9 | Error/offline | Plain message, retry, "queued locally, will sync" | Retry |

Offline behaviour: captures are queued in `chrome.storage.local` and synced when back online. No silent failures.

### 1.2 In-page overlay (injected on listing pages)

- Small floating **"Save to PropSnap"** button, bottom-right, with a saved/not-saved state and a field-count badge.
- Shadow DOM so site CSS cannot break it.
- Phase 2: on **search results pages**, a save icon on each card, plus "Save all on this page".

### 1.3 Side panel (phase 2)

- Chrome side panel API. Shows your active list while you keep browsing, with quick compare of the current listing against saved ones ("this one is £150 cheaper than your average").

### 1.4 Options page

- Account and plan
- Default list and default tags
- Per-site on/off
- Which fields to capture (useful for GDPR-conscious teams, e.g. turn off landlord contact)
- Keyboard shortcut config
- Auto-save toggle (off by default)
- Privacy and data deletion

### 1.5 Other extension surfaces

- **Onboarding tab** on install: 3 steps (sign in, pin extension, try on a sample listing).
- **Right-click context menu:** "Save listing to PropSnap".
- **Keyboard shortcut:** Alt+S to save.
- **Toolbar badge:** green tick when the current page is already saved, number when a listing is detected.

### 1.6 Extension internals (not screens, but needed)

- Content script per site, with a **site adapter** pattern (`rightmove.ts`, `zoopla.ts`, `openrent.ts`) that all return the same `Capture` object.
- Service worker handles auth token, upload queue, dedupe check, badge state, and address enrichment API calls.
- Messaging: content script -> service worker -> API.

---

## Part 2: The Web Dashboard (every page)

### MVP pages

| Page | Purpose | Key content |
|---|---|---|
| Login / Sign up | Auth (email + Google) | Magic link or password |
| Install extension | First-run | Chrome Web Store link, detects if extension is installed |
| **Properties** | Main workspace | Table and card toggle; columns: address (with confidence badge), price, beds, type, source, agent, saved date. Search, filters (price range, beds, type, source, list, tags), sort, bulk select |
| **Property detail** | Everything on one property | All fields (editable), description, source link, price history, notes, tags, list membership. Contact block: agent details (copy/call/email buttons) + registered owner section (name, correspondence address from Land Registry) |
| **Compare** | Side by side, up to 4 properties | Rows: price, price per bedroom, beds, type, address, contact, key differences highlighted |
| **Lists** | Folders / shortlists | Create, rename, share, archive |
| **Export** | Get data out | CSV now, Google Sheets later; choose fields |
| **Settings** | Profile, defaults | Name, company, default list |
| **Billing** | Plans | Usage, upgrade, invoices (Stripe) |

### Phase 2 pages

- **Map view:** pins by price, uses lat/lng from the listing.
- **Contacts (agents and owners):** auto-deduplicated by phone/email, shows every property per contact. Strong differentiator for lettings pros.
- **Public share link** for a list (read-only, no contact details unless the owner opts in).
- **Duplicate and price-change inbox:** same property on 2 portals gets merged; price drops flagged.
- **Agent business social media:** LinkedIn, Facebook, Instagram pulled from agent profile pages.

### Phase 3 pages

- **Team workspace:** members, shared lists, roles, activity feed.
- **Integrations:** Google Sheets, Zapier/webhook, CRM push (e.g. Alto, Reapit; check demand first).
- **API keys.**
- **Direct to vendor letters:** generate and send physical letters to registered owners using Land Registry data.

### Public and internal

- Marketing landing page, pricing page, privacy policy, terms (Chrome Web Store requires a privacy policy).
- **Internal admin:** adapter health (extraction success rate per site and field), failed captures, enrichment success rate, user list.

---

## Part 3: Data Model

`Capture` (extension output) maps to a `properties` row:

- `id`, `user_id`, `workspace_id`
- `source` (rightmove | zoopla | openrent | ...), `source_listing_id`, `source_url`
- `address_display` (as shown on listing), `address_full` (resolved), `address_confidence` (exact | probable | partial), `postcode`, `lat`, `lng`
- `price`, `price_period` (pcm | pw | sale), `deposit`
- `bedrooms`, `bathrooms`, `property_type` (flat, terraced, semi, detached, HMO, studio, room...), `furnished`, `available_from`
- `description`, `features[]`, `epc_rating`
- `agent_name`, `agent_phone`, `agent_email`, `agent_company`
- `owner_name` (from Land Registry), `owner_correspondence_address`, `owner_lookup_date`
- `landlord_phone` (manually added by user), `landlord_email` (manually added by user)
- `status`, `notes`, `tags[]`, `list_ids[]`
- `captured_at`, `last_seen_at`, `price_history[]`
- `raw_snapshot` (optional, short-lived, for debugging extraction)

Dedupe key: `(source, source_listing_id)` first, then fuzzy match on postcode + beds + price for cross-portal matches.

---

## Part 4: Extraction Strategy per Site

Approach for every site: try the structured data first, DOM as fallback, LLM last.

| Site | Likely best source | Watch-outs |
|---|---|---|
| Rightmove | `window.__PAGE_MODEL` (packed JSON) — verified | Address is area-level only. Contact is the agent branch. Data uses index-based encoding that needs a resolver function |
| Zoopla | `__NEXT_DATA__` (Next.js hydration data) — not yet verified | Same address limitation. Layout changes often |
| OpenRent | DOM plus structured metadata — not yet verified | Landlord details mostly behind login or enquiry |
| OnTheMarket (phase 2) | Embedded JSON | Similar to Rightmove |
| SpareRoom (phase 2) | DOM | Rooms, so type and bedrooms semantics differ |

**Week-1 spike** is to save real HTML for 10 listings per site and confirm exactly what each embeds.

---

## Part 5: Address Enrichment Pipeline

This runs server-side after a capture is saved:

1. Take the listing's postcode (or postcode area from coordinates via reverse geocoding).
2. Query EPC Register API for all certificates at that postcode.
3. Filter by property type and bedrooms to get candidate addresses.
4. If coordinates are available, calculate distance from each candidate. Closest match within 50m with matching beds/type = "exact" confidence.
5. If no EPC match, check Land Registry Price Paid Data for recent sales at that postcode with matching attributes.
6. Store the best match with its confidence level.
7. On-demand (paid feature): full Land Registry title lookup (£3) to get registered owner name and correspondence address.

Enrichment runs asynchronously. The user sees the listing immediately with whatever address the page provided, and the enriched address appears within seconds.

---

## Part 6: Risks (the honest ones)

1. **Address enrichment accuracy.** Not every property has an EPC. New builds may not be in Land Registry yet. Flats in converted houses are hard to match. Always show confidence levels and let the user correct.
2. **Land Registry costs.** At £3 per title, owner lookups need to be a paid feature or capped on free plans. Budget: 100 lookups/month on Pro = £300/month cost.
3. **Terms of service.** Portal ToS generally restrict scraping. Reading the page the user is already viewing in their own browser is lower risk than server-side crawling, but it is not risk-free. Get a legal view before launch and keep captures user-initiated (no background crawling).
4. **GDPR / UK data protection.** Owner names and correspondence addresses from Land Registry are personal data. Need a privacy policy, lawful basis (legitimate interest for property professionals), deletion on request, probably ICO registration, and a clear "what we collect" screen. Chrome Web Store Limited Use policy applies.
5. **Markup breakage.** Sites change their HTML without warning. Mitigation: adapter health dashboard, fixtures-based tests, fast patch release path.
6. **Photos.** Copying and storing portal photos has copyright implications. MVP: store URLs and thumbnails only, decide on full storage after legal review.

---

## Part 7: Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Extension framework | WXT (Vite based, MV3) | Good DX, TypeScript, hot reload, builds for Chrome and Firefox |
| Extension UI | React + Tailwind | Same skills as the dashboard |
| Dashboard | Next.js (App Router) on Vercel | Fast to ship, SSR for share links |
| Backend and DB | Supabase (Postgres, Auth, Storage, Row Level Security) | Auth, DB and file storage in one, cheap to start |
| Address enrichment | EPC API (free), Land Registry APIs (£3/title) | Public data, same approach as PropertyEngine |
| Extension auth | Sign in on the dashboard, pass session to extension via `externally_connectable` messaging | Avoids building a separate login UI in the popup |
| Payments | Stripe | Standard |
| Monitoring | Sentry (extension plus dashboard) | Catches adapter failures |
| Validation | Zod schemas shared between extension and API | One `Capture` type end to end |

---

## Part 8: Phases

| Phase | Scope | Rough time |
|---|---|---|
| 0. Spike | Save fixtures from 3 sites, confirm what fields exist, verify EPC API access, check competitor's extension, legal sanity check | 1 week |
| 1. MVP | Extension (popup P1-P9, overlay, 3 adapters), address enrichment pipeline (EPC + coordinates), auth, save to backend, Properties page, Detail page, Lists, CSV export | 5 to 7 weeks |
| 2. Compare and polish | Compare page, dedupe and price history, side panel, OnTheMarket + SpareRoom, Land Registry owner lookup (paid), agent social media, billing | 3 to 4 weeks |
| 3. Intelligence | Map view, Contacts page, share links, direct to vendor letters | 4 weeks |
| 4. Teams and integrations | Workspaces, Sheets/Zapier/CRM, API | Later, driven by customer demand |

Estimates assume one developer working full time. Treat them as planning numbers, not promises.

---

## Part 9: Pricing Hypothesis (to test, not decide)

- **Free:** 10 captures per month, 1 list, CSV export, address enrichment (EPC only, no owner lookup).
- **Pro (£19-29/month):** Unlimited captures, compare, full address enrichment, 50 Land Registry owner lookups/month, Sheets export.
- **Team (per seat):** Shared lists, contacts, integrations, unlimited owner lookups.

Positioned below PropertyEngine's Pro at £89.99/month. Our advantage: extension-first capture flow, not just a database search.

---

## Part 10: Verification (for when we build)

- **Adapter unit tests** run against saved HTML fixtures per site. Each field has an expected value. This is the main safety net.
- **Enrichment tests** against known properties where we can verify the full address.
- **Playwright** loads the built extension in Chromium, opens a fixture page, clicks Save, asserts the payload.
- **Manual QA checklist** on live listings for each site, including edge cases: new-build with no house number, rooms to rent, price on application, sold/let agreed, listing withdrawn.
- **End-to-end:** capture on Rightmove -> appears in dashboard within 5 seconds -> enriched address appears -> edit address -> add to list -> compare against a second property -> export CSV.
- **Offline test:** disable network, save, re-enable, confirm sync.

---

## Decisions I need from you before building

1. **New repo?** I recommend a fresh `propsnap` repo, separate from ShiftAlert.
2. **Who is the first customer?** Letting agents, deal sourcers or investors? This changes which fields and pages come first.
3. **Lettings, sales, or both** in the MVP?
4. **Photos:** store them or just link? Depends on legal risk appetite.
5. **Solo build or team?** Affects the phase timings.
6. **Do you want me to spike first (Phase 0)** once you approve, so we ground the plan in real page data before committing to the MVP scope?

---

## Changelog

- **v1 (30 Sep 2026):** Initial plan.
- **v2 (2 Oct 2026):** Added verified Rightmove data structure analysis. Promoted address enrichment from phase 3 to core MVP feature. Added EPC Register and Land Registry as data sources for full address resolution and owner lookup. Clarified that landlord phone numbers are not available anywhere (including PropertyEngine). Added PropertyEngine pricing and feature comparison. Added agent business social media as phase 2 feature. Excluded landlord personal social media lookup (GDPR risk). Updated data model with owner fields and separate agent/landlord contact fields. Added enrichment pipeline section. Updated pricing to position below PropertyEngine.
