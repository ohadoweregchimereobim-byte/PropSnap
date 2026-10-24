# PropSnap privacy policy

Last updated: 24 October 2026

PropSnap is a Chrome extension for researching UK residential property listings. This policy explains what it reads, what it sends and where your data is kept.

## In short

- Everything you save stays in your own Chrome, on your own computer.
- PropSnap has no server of its own. The developer never receives your listings, notes or settings.
- There are no adverts, no analytics and no tracking.
- No data is ever sold.

## What PropSnap reads

**Listing pages.** On Rightmove, Zoopla and OpenRent listing pages, PropSnap notes that you are on a listing page and lights its icon. It reads the listing's details only when you click **Capture**. Those details are the price, address as shown, bedrooms, type, size, agent, energy rating and the dates the site shows. It does not read any other website.

**What you type.** This covers your deal figures, stage, summary, notes, calls, labels, follow-up dates, agent notes, viewing plans, letter wording, and report branding (company name, contact details, colour and logo).

**Your EPC API key.** You enter this in Settings. It is used only to sign your requests to the government EPC register.

## What PropSnap sends, and to whom

To find a home's full address and check its area, PropSnap sends details **of the home** (not of you) to these public services:

| Service | What is sent | Why |
|---|---|---|
| EPC register (Ministry of Housing, Communities and Local Government), `api.get-energy-performance-data.communities.gov.uk` | The home's postcode and certificate numbers, with your EPC API key | To find the full address and the energy certificate |
| HM Land Registry, `landregistry.data.gov.uk` | The postcode and street name | To show sold prices nearby |
| postcodes.io, `api.postcodes.io` | The postcode | To find the postcode's map position when the listing gives none |
| Environment Agency, `environment.data.gov.uk` | A small area around the home's map position | Flood zones (England) |
| Natural Resources Wales and Welsh Government, `datamap.gov.wales` | The home's map position | Flood zones and conservation areas (Wales) |
| planning.data.gov.uk | The home's map position | Conservation areas and Article 4 directions (England) |
| data.police.uk | The home's map position | Street crime nearby |

These requests go straight from your Chrome to each service. Each service has its own privacy policy. PropSnap sends nothing about you, your notes or your other saved homes.

**Google Maps.** When you click a map or route link, Google Maps opens in a new tab with the addresses of the homes in that route. This only happens when you click.

## Where your data is kept

- **Saved homes, notes and settings** are kept in Chrome's extension storage on your computer (`chrome.storage.local`). They stay there until you delete them, clear all, or remove PropSnap.
- **Answers from the services above** are kept for a short time (one day to 30 days) in Chrome's session storage, so the same thing is not asked for twice. Chrome empties this when it closes.
- **Back up** saves a file to your Downloads folder. Your EPC API key is never put in that file. Where the file goes after that is up to you.
- **Exports, reports and letters** (CSV, PDF, print) are made on your computer and saved or printed by you.

## Sharing

PropSnap does not sell, rent or share your data. It does not use your data for advertising, credit checks or anything other than the features described above. Data goes to the public services listed above only to make those features work.

## Your choices

- Delete one saved home, or click **Clear all** on the dashboard, to remove your data.
- Turn off the EPC lookup in Settings, or leave the key empty, and no request goes to the EPC register.
- Removing PropSnap from Chrome deletes everything it stored.

## Letters to owners

If you use PropSnap to write to homeowners, you decide who to write to and what to say. You are responsible for following UK data protection law when you do. PropSnap only prints letters. It does not send them.

## Children

PropSnap is not meant for children.

## Changes

If this policy changes, the new version will be posted here with a new date.

## Contact

Questions or concerns: open an issue at https://github.com/ohadoweregchimereobim-byte/PropSnap/issues
