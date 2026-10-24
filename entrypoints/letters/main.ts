/**
 * PropSnap letters (letters.html?keys=a,b from the dashboard or a listing's
 * Details page): one printable letter per picked home, to "The Owner".
 * The letter text is saved; the homes come from the address each time.
 */

import type { PropertyListing } from '../../src/adapters/types';
import { getListings, LISTINGS_KEY } from '../../src/services/storage';
import { SITE_NAMES } from '../../src/services/format';
import { getAllUserData, listingKey, logLetters, USER_DATA_KEY, type UserDataMap } from '../../src/services/user-data';
import { cleanActivity, cleanLabels } from '../../src/services/crm';
import { BRANDING_KEY, cleanBranding, getBranding, isBranded, type Branding } from '../../src/services/branding';
import {
  cleanLetterSettings,
  DEFAULT_TEMPLATES,
  getLetterSettings,
  LETTERS_KEY,
  letterFor,
  saveLetterSettings,
  type Letter,
  type LetterSettings,
} from '../../src/services/letters';

const $ = (id: string) => document.getElementById(id)!;
const keys = (new URLSearchParams(location.search).get('keys') ?? '').split(',').filter(Boolean);

let listings: PropertyListing[] = [];
let userData: UserDataMap = {};
let branding: Branding = cleanBranding(null);
let settings: LetterSettings = cleanLetterSettings(null);
/** Homes the user unticked */
const leftOut = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

init();

async function init() {
  [listings, userData, branding, settings] = await Promise.all([getListings(), getAllUserData(), getBranding(), getLetterSettings()]);
  fillControls();
  render();

  $('template').addEventListener('change', () => {
    settings = { ...settings, templateId: ($('template') as HTMLSelectElement).value };
    fillControls();
    changed();
  });
  for (const id of ['templateName', 'templateBody', 'senderName', 'signOff']) $(id).addEventListener('input', () => { readControls(); changed(); });
  $('resetTemplate').addEventListener('click', () => {
    const original = DEFAULT_TEMPLATES.find((t) => t.id === settings.templateId);
    if (!original) return;
    settings = { ...settings, templates: settings.templates.map((t) => (t.id === original.id ? original : t)) };
    fillControls();
    changed();
  });
  $('printBtn').addEventListener('click', () => window.print());
  $('markSent').addEventListener('click', markSent);

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (LISTINGS_KEY in changes) listings = await getListings();
    if (USER_DATA_KEY in changes) userData = (changes[USER_DATA_KEY]!.newValue as UserDataMap | undefined) ?? {};
    if (BRANDING_KEY in changes) branding = cleanBranding(changes[BRANDING_KEY]!.newValue);
    if (LETTERS_KEY in changes && !saveTimer) { settings = cleanLetterSettings(changes[LETTERS_KEY]!.newValue); fillControls(); }
    render();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer) { clearTimeout(saveTimer); save(); }
  });
}

const template = () => settings.templates.find((t) => t.id === settings.templateId) ?? settings.templates[0]!;

function fillControls() {
  const select = $('template') as HTMLSelectElement;
  select.replaceChildren(...settings.templates.map((t) => new Option(t.name, t.id)));
  select.value = settings.templateId;
  ($('templateName') as HTMLInputElement).value = template().name;
  ($('templateBody') as HTMLTextAreaElement).value = template().body;
  ($('senderName') as HTMLInputElement).value = settings.senderName;
  ($('signOff') as HTMLInputElement).value = settings.signOff;
  const original = DEFAULT_TEMPLATES.find((t) => t.id === settings.templateId);
  $('resetTemplate').hidden = !original;
}

function readControls() {
  const name = ($('templateName') as HTMLInputElement).value;
  const body = ($('templateBody') as HTMLTextAreaElement).value;
  settings = {
    ...settings,
    templates: settings.templates.map((t) => (t.id === settings.templateId ? { ...t, name, body } : t)),
    senderName: ($('senderName') as HTMLInputElement).value,
    signOff: ($('signOff') as HTMLInputElement).value,
  };
  // The drop-down shows the new name as it is typed
  const option = ($('template') as HTMLSelectElement).selectedOptions[0];
  if (option) option.textContent = name || 'Letter';
}

function changed() {
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}

async function save() {
  saveTimer = undefined;
  try {
    await saveLetterSettings(settings);
    $('saved').textContent = 'Saved';
  } catch (error: any) {
    $('saved').textContent = `Could not save: ${error.message}`;
  }
}

function lettersNow(): Array<{ listing: PropertyListing; letter: Letter }> {
  const byKey = new Map(listings.map((l) => [listingKey(l), l]));
  return keys
    .map((k) => byKey.get(k))
    .filter((l): l is PropertyListing => !!l)
    .map((listing) => ({ listing, letter: letterFor(listing, cleanLabels(userData[listingKey(listing)]?.labels), settings, branding, new Date()) }));
}

function render() {
  $('brandSummary').textContent = isBranded(branding)
    ? `Letterhead: ${[branding.company, branding.contact.replace(/\n/g, ', ')].filter(Boolean).join(' · ')}${branding.logo ? ', with your logo' : ''}.`
    : 'No letterhead yet: add your company name and contact details under Report options on any listing\'s Details page, so owners know who wrote.';

  const all = lettersNow();
  $('empty').hidden = all.length > 0;
  $('homesBox').hidden = all.length === 0;

  $('homes').replaceChildren(...all.map(({ listing, letter }) => {
    const li = document.createElement('li');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.disabled = !letter.ok;
    box.checked = letter.ok && !leftOut.has(letter.key);
    box.setAttribute('aria-label', 'Write to this home');
    box.addEventListener('change', () => {
      if (box.checked) leftOut.delete(letter.key);
      else leftOut.add(letter.key);
      render();
    });
    const what = document.createElement('div');
    const title = document.createElement('a');
    title.href = `./listing.html?key=${encodeURIComponent(letter.key)}`;
    title.textContent = listing.fullAddress || listing.displayAddress;
    const note = document.createElement('div');
    note.className = letter.ok ? 'hint' : 'skip';
    const last = cleanActivity(userData[letter.key]?.activity).filter((a) => a.kind === 'letter').at(-1);
    note.textContent = letter.ok
      ? `${SITE_NAMES[listing.source]}${last ? ` · last letter ${new Date(last.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}`
      : `Left out: ${letter.why}`;
    what.append(title, note);
    li.append(box, what);
    return li;
  }));

  const ready = all.filter(({ letter }) => letter.ok && !leftOut.has(letter.key));
  $('printBtn').textContent = `Print letters (${ready.length})`;
  ($('printBtn') as HTMLButtonElement).disabled = ready.length === 0;
  ($('markSent') as HTMLButtonElement).disabled = ready.length === 0;
  $('letters').replaceChildren(...ready.map(({ letter }) => page(letter as Extract<Letter, { ok: true }>)));
}

/** One letter, as one printed page */
function page(letter: Extract<Letter, { ok: true }>): HTMLElement {
  const el = (tag: string, text?: string, className?: string) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const article = el('article', undefined, 'letter');
  article.style.setProperty('--brand', branding.colour);

  const head = el('header', undefined, 'letter-head');
  if (branding.logo) {
    const img = document.createElement('img');
    img.src = branding.logo;
    img.alt = branding.company || 'Logo';
    head.append(img);
  }
  const from = el('div', undefined, 'letter-from');
  if (branding.company) from.append(el('strong', branding.company));
  if (branding.contact) from.append(el('div', branding.contact, 'letter-contact'));
  head.append(from);

  const to = el('address', undefined, 'letter-to');
  for (const line of letter.recipient) to.append(el('div', line));

  article.append(
    head,
    to,
    el('p', letter.date, 'letter-date'),
    el('div', letter.body, 'letter-body'),
    el('p', letter.signOff, 'letter-signoff'),
    el('p', letter.senderName || branding.company, 'letter-name'),
  );
  return article;
}

async function markSent() {
  const ready = lettersNow().filter(({ letter }) => letter.ok && !leftOut.has(letter.key)).map(({ letter }) => letter.key);
  if (!ready.length || !confirm(`Add "Letter sent: ${template().name}" to the timeline of ${ready.length} home${ready.length === 1 ? '' : 's'}?`)) return;
  try {
    await logLetters(ready, template().name);
    $('saved').textContent = `Logged on ${ready.length} home${ready.length === 1 ? '' : 's'}`;
  } catch (error: any) {
    $('saved').textContent = `Could not log: ${error.message}`;
  }
}
