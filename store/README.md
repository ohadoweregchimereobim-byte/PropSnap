# Putting PropSnap on the Chrome Web Store (unlisted)

"Unlisted" means PropSnap is on the store, but only people with the link can find it. They install it in one click. It updates on its own, and they don't need Developer mode.

Everything to paste is below. The images are in this folder.

---

## Part 1: Set up your developer account (once)

1. **Turn on 2-Step Verification** for the Google account you will use: https://myaccount.google.com/security. The store will not let you publish without it.
2. Open the **Chrome Web Store Developer Dashboard**: https://chrome.google.com/webstore/devconsole
3. Accept the developer agreement and pay the **one-off registration fee** (US$5 when this was written; the dashboard shows the current amount).
4. Go to **Account** and fill in:
   - **Publisher name:** what people see as the maker, e.g. your name or "PropSnap".
   - **Contact email:** verify it. Use an address you are happy for users to see.
   - **Trader or non-trader:** an EU rule makes every publisher choose. This is your own decision. Roughly:
     - You give PropSnap away free and it is not part of a business you run: **non-trader**.
     - You charge for it, or publish it as part of your business: **trader**. Your name, address, phone and email are then shown on the listing.

## Part 2: Make the upload file

On your computer, in the project folder:

```
git pull
npm ci
npm run zip
```

This makes `.output/propsnap-<version>-chrome.zip`. Upload that file. Don't upload the whole project.

## Part 3: Create the item

1. In the dashboard, click **New item** and upload the zip.
2. The dashboard opens PropSnap's draft. Fill in the tabs below.

### Tab: Store listing

| Field | What to put |
|---|---|
| Description | Paste the text under **Store description** below |
| Category | Productivity, then **Workflow & Planning** (or **Tools** if that is not offered) |
| Language | English (United Kingdom) |
| Store icon | `public/icons/icon-128.png` |
| Screenshots | The five files in `store/screenshots/` (1280 × 800), in number order |
| Small promo tile | `store/promo-small-440x280.png` |
| Marquee promo tile | Leave empty (only for featured items) |
| Official URL | Leave empty |
| Homepage URL | https://github.com/ohadoweregchimereobim-byte/PropSnap |
| Support URL | https://github.com/ohadoweregchimereobim-byte/PropSnap/issues |

The short summary under the name comes from the extension itself: "Save UK property listings with the full address, sold prices, area checks and deal numbers."

#### Store description

```
PropSnap helps you research UK residential property while you browse Rightmove, Zoopla and OpenRent.

Open a listing, click Capture, and PropSnap saves it with the full street address. Listing sites hide the house number; PropSnap matches the home on the government EPC register and says how sure the match is. When it is not sure, you pick the right home from a short list.

FOR EACH HOME
• Full address, with how it was matched
• Price history: every price PropSnap has seen, plus the price drops and days on the market the site shows
• Energy rating now and its potential, with the improvements from the certificate
• Sold prices nearby from HM Land Registry, the median, and homes flipped nearby
• Area checks: flood zone, conservation area, Article 4 directions (including HMO) and street crime
• Deal calculator: stamp duty (England) or Land Transaction Tax (Wales), mortgage, buy-to-let, buy-refurbish-refinance, flip and HMO, with your own costs

TO RUN YOUR DEALS
• Dashboard of every saved home with search, filters and sorting
• Stages from New to Bought, follow-up dates, a summary, labels and a timeline of notes and calls
• Agent view with one note per agent
• Viewing planner: best order, Google Maps route and a calendar file
• Property report saved as PDF, with your own logo and colours
• Letters to owners, for homes with a confirmed address
• CSV export, and Back up / Restore to move to another computer

YOUR DATA STAYS WITH YOU
Everything is kept in your own Chrome. There is no PropSnap server, no account, no adverts and no tracking. Public data comes straight from government and open services (EPC register, HM Land Registry, Environment Agency, Natural Resources Wales, planning.data.gov.uk, police.uk, postcodes.io).

The address lookup needs a free EPC API key from get-energy-performance-data.communities.gov.uk (Settings, in the PropSnap popup).

Figures are estimates to help your research. They are not financial, tax or legal advice.

PropSnap is not made by or connected with Rightmove, Zoopla or OpenRent.
```

### Tab: Privacy

**Single purpose**

```
PropSnap helps the user research UK residential property listings: it saves the listing the user is looking at, finds its full address and adds public data (energy rating, sold prices, area checks) and the user's own deal figures and notes.
```

**Permission justification** (one box each)

| Permission | Justification to paste |
|---|---|
| `storage` | Saves the user's captured listings, notes, deal figures and settings on their own computer. |
| `unlimitedStorage` | A user's saved listings, timelines and the logo for their reports can grow past Chrome's 10 MB storage limit. Without it, saving would start to fail. |
| `activeTab` | When the user clicks the PropSnap icon, the popup reads the address of the tab they are on, to tell whether it is a listing page it can capture. |
| Host permissions | Rightmove, Zoopla and OpenRent (www.rightmove.co.uk, www.zoopla.co.uk, www.openrent.com, www.openrent.co.uk): the content script runs on their listing pages and reads the listing's details only when the user clicks Capture. The rest are public data services, called only for the home the user saved: the EPC register (api.get-energy-performance-data.communities.gov.uk) for the full address and energy certificate; HM Land Registry (landregistry.data.gov.uk) for sold prices; postcodes.io for a postcode's map position; the Environment Agency (environment.data.gov.uk) and DataMapWales (datamap.gov.wales) for flood zones and Welsh conservation areas; planning.data.gov.uk for conservation areas and Article 4 directions in England; data.police.uk for street crime. |

**Are you using remote code?** No. (Everything PropSnap runs is in the zip.)

**Data usage: what does PropSnap collect?** Tick these:

- **Website content**: it reads the listing details on the page when the user clicks Capture, and sends the home's postcode or map position to the public services above.
- **Authentication information**: it keeps the user's EPC API key on their computer and sends it only to the EPC register.

Leave the others unticked. PropSnap does not collect personal details about the user, health, finance or payment, personal messages, the user's own location, web history or user activity. The map positions it sends are of the home, not of the user.

**Certify** all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**

```
https://github.com/ohadoweregchimereobim-byte/PropSnap/blob/main/PRIVACY.md
```

### Tab: Distribution

| Field | Choice |
|---|---|
| Payments | Free |
| Visibility | **Unlisted** |
| Regions | United Kingdom (or All regions) |

### Tab: Test instructions (if the dashboard shows it)

```
No login is needed. Open any Rightmove, Zoopla or OpenRent listing (for example a Rightmove page under /properties/), click the PropSnap icon, then Capture. The saved home opens from Dashboard > Details, with sold prices, area checks and the calculator.
The full-address lookup needs a free EPC API key from https://get-energy-performance-data.communities.gov.uk (Settings in the popup). Everything else works without one.
```

## Part 4: Submit

1. Click **Submit for review**. You can choose to publish as soon as it passes, or to publish by hand later.
2. A first review usually takes a few days. It can take longer, and the store emails you either way.
3. If it is rejected, the email says why. Send it to Claude and we fix it and send it again.

## Part 5: After it is approved

1. In the dashboard, open PropSnap and copy its store link. It looks like `https://chromewebstore.google.com/detail/propsnap/<id>`.
2. Send the link to the people who should have it. They click **Add to Chrome**.

**Moving from the zip version to the store version.** Chrome treats the store version as a different extension, so do this once for each computer (yours and your landlord's):

1. In the old (zip) PropSnap, open the dashboard and click **Back up**.
2. Install the store version from the link.
3. In the store version's dashboard, click **Restore**, pick the backup file, then **Add**.
4. Check that the homes are there. Then remove the old one in `chrome://extensions` (Remove on the PropSnap marked as unpacked). Don't keep both: they would both run on listing pages.
5. Enter the EPC API key again in Settings. A backup never holds it.

## Part 6: Sending an update

1. Make sure the version number went up (each PR does this).
2. Run `npm run zip`.
3. In the dashboard, open PropSnap, go to **Package**, click **Upload new package**, then **Submit for review**.
4. Once it passes, Chrome updates everyone on its own within a few hours.

If a new web service or permission is added later, update `PRIVACY.md` and the permission justification above in the same PR. The store checks that they match.
