/**
 * PropSnap viewing planner (planner.html, or planner.html?keys=a,b from the dashboard)
 *
 * Homes to view on one day, in visiting order, with a time for each. Opens
 * the route in Google Maps and makes a calendar file. The plan is saved in
 * chrome.storage.local, so it is still there next time.
 */
import type { PropertyListing } from '../../src/adapters/types';
import { getListings } from '../../src/services/storage';
import { listingKey } from '../../src/services/user-data';
import { localDate } from '../../src/services/pipeline';
import {
  bestOrder,
  calendarFile,
  cleanPlan,
  isPlaced,
  mapsPlace,
  PLAN_KEY,
  routeKm,
  routeLinks,
  timeClashes,
  type ViewingPlan,
} from '../../src/services/viewing-plan';

const LISTINGS_KEY = 'propsnap_listings';
const $ = (id: string) => document.getElementById(id)!;
const dateInput = $('planDate') as HTMLInputElement;
const startInput = $('planStart') as HTMLInputElement;
const minutesInput = $('planMinutes') as HTMLInputElement;

let byKey = new Map<string, PropertyListing>();
let plan: ViewingPlan;

init();

async function init() {
  await loadListings();
  const today = localDate(new Date());
  const saved = (await chrome.storage.local.get(PLAN_KEY))[PLAN_KEY];
  plan = cleanPlan(saved, new Set(byKey.keys()), today);

  // Homes ticked on the dashboard replace the plan's homes; times for homes still in it stay
  const fromDashboard = new URLSearchParams(location.search).get('keys');
  if (fromDashboard != null) {
    const keys = fromDashboard.split(',').filter((k) => byKey.has(k));
    plan = cleanPlan({ ...plan, keys }, new Set(byKey.keys()), today);
    if (!saved) plan.date = tomorrow();
    // A reload should not undo changes made since
    history.replaceState(null, '', location.pathname);
    await save();
  }

  dateInput.min = today;
  dateInput.value = plan.date;
  startInput.value = plan.start;
  minutesInput.value = String(plan.minutesEach);

  dateInput.addEventListener('change', () => { plan.date = dateInput.value || today; save(); render(); });
  // Links follow every key; the save waits until typing pauses
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  startInput.addEventListener('input', () => {
    plan.start = startInput.value;
    renderLinks();
    clearTimeout(startTimer);
    startTimer = setTimeout(() => { startTimer = undefined; save(); }, 400);
  });
  // Save a start still waiting when the tab is closed or hidden
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && startTimer) { clearTimeout(startTimer); startTimer = undefined; save(); }
  });
  minutesInput.addEventListener('change', () => {
    const m = Number(minutesInput.value);
    plan.minutesEach = Number.isFinite(m) && m >= 5 && m <= 240 ? Math.round(m) : 30;
    minutesInput.value = String(plan.minutesEach);
    save();
  });
  $('bestOrder').addEventListener('click', () => {
    plan.keys = bestOrder(plan.keys.map((key) => ({ key, ...byKey.get(key)! }))).map((s) => s.key);
    save();
    render();
    setStatus('Put in the shortest order by straight-line distance');
  });
  $('reverse').addEventListener('click', () => { plan.keys.reverse(); save(); render(); });
  $('calendarBtn').addEventListener('click', downloadCalendar);

  // A capture or delete elsewhere changes the homes
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !(LISTINGS_KEY in changes)) return;
    await loadListings();
    plan.keys = plan.keys.filter((k) => byKey.has(k));
    render();
  });

  render();
}

async function loadListings() {
  byKey = new Map((await getListings()).map((l) => [listingKey(l), l]));
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localDate(d);
}

async function save() {
  try {
    await chrome.storage.local.set({ [PLAN_KEY]: plan });
  } catch (error: any) {
    setStatus(`Could not save the plan: ${error.message}`);
  }
}

function render() {
  const empty = plan.keys.length === 0;
  $('empty').hidden = !empty;
  $('planBody').hidden = empty;
  if (empty) return;

  const clashes = new Set(timeClashes(plan.keys, plan.times));
  $('stops').replaceChildren(...plan.keys.map((key, i) => stopItem(key, i, clashes.has(key))));
  $('clashNote').hidden = clashes.size === 0;

  const stops = plan.keys.map((k) => byKey.get(k)!);
  const km = routeKm(stops);
  const unplaced = stops.filter((s) => !isPlaced(s)).length;
  const day = new Date(`${plan.date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  $('summary').textContent = `${day}: ${stops.length} viewing${stops.length === 1 ? '' : 's'}`
    + (km > 0 ? `, about ${km.toFixed(1)} km between them in straight lines` : '')
    + (unplaced ? ` (${unplaced} with no map position)` : '');
  ($('bestOrder') as HTMLButtonElement).disabled = stops.length < 3;
  renderLinks();
}

function stopItem(key: string, index: number, clash: boolean): HTMLLIElement {
  const l = byKey.get(key)!;
  const li = document.createElement('li');
  li.className = 'stop';

  const num = document.createElement('span');
  num.className = 'stop-num';
  num.textContent = String(index + 1);

  const info = document.createElement('div');
  info.className = 'stop-info';
  const address = document.createElement('a');
  address.className = 'stop-address';
  address.href = `./listing.html?key=${encodeURIComponent(key)}`;
  address.textContent = l.fullAddress || l.displayAddress;
  const facts = document.createElement('div');
  facts.className = 'stop-facts';
  const price = l.price
    ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(l.price) + (l.listingType === 'rent' ? ' pcm' : '')
    : null;
  facts.textContent = [l.postcode || l.postcodePartial, price, l.bedrooms != null ? `${l.bedrooms} bed` : null, l.propertyType].filter(Boolean).join(' · ');
  info.append(address, facts);

  if (l.agentName || l.agentPhone) {
    const agent = document.createElement('div');
    agent.className = 'stop-facts';
    agent.append(`Agent: ${l.agentName ?? ''}${l.agentPhone ? ' · ' : ''}`);
    if (l.agentPhone) {
      const tel = document.createElement('a');
      tel.href = `tel:${l.agentPhone.replace(/[^\d+]/g, '')}`;
      tel.textContent = l.agentPhone;
      agent.append(tel);
    }
    info.append(agent);
  }
  if (!isPlaced(l)) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'No map position';
    tag.title = 'The listing gave no map position, so Best order puts this home last. Move it by hand if needed.';
    info.append(tag);
  }

  const time = document.createElement('input');
  time.type = 'time';
  time.className = clash ? 'stop-time clash' : 'stop-time';
  time.setAttribute('aria-label', `Time for viewing ${index + 1}`);
  time.value = plan.times[key] ?? '';
  time.addEventListener('change', () => {
    if (time.value) plan.times[key] = time.value;
    else delete plan.times[key];
    save();
    render();
  });

  const tools = document.createElement('div');
  tools.className = 'stop-tools';
  tools.append(
    toolButton('↑', 'Move up', index === 0, () => move(index, -1)),
    toolButton('↓', 'Move down', index === plan.keys.length - 1, () => move(index, 1)),
    toolButton('✕', 'Take out of the plan', false, () => {
      plan.keys.splice(index, 1);
      delete plan.times[key];
      save();
      render();
    }),
  );

  li.append(num, info, time, tools);
  return li;
}

function toolButton(text: string, label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-small';
  b.textContent = text;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function move(index: number, by: number) {
  const [key] = plan.keys.splice(index, 1);
  plan.keys.splice(index + by, 0, key!);
  save();
  render();
}

function renderLinks() {
  const links = routeLinks(plan.start, plan.keys.map((k) => mapsPlace(byKey.get(k)!)));
  $('routeLinks').replaceChildren(...links.map((href, i) => {
    const a = document.createElement('a');
    a.className = 'btn btn-primary';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = links.length === 1 ? 'Open route in Google Maps' : `Open route part ${i + 1} of ${links.length}`;
    return a;
  }));
}

function downloadCalendar() {
  const money = (n: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(n);
  const ics = calendarFile(plan.date, plan.minutesEach, plan.keys.map((key) => {
    const l = byKey.get(key)!;
    const name = l.fullAddress || l.displayAddress;
    return {
      key,
      time: plan.times[key],
      title: `Viewing: ${name}`,
      location: mapsPlace(l),
      details: [
        l.price ? `${l.priceQualifier ? `${l.priceQualifier} ` : ''}${money(l.price)}${l.listingType === 'rent' ? ' a month' : ''}` : '',
        l.agentName || l.agentPhone ? `Agent: ${[l.agentName, l.agentPhone].filter(Boolean).join(', ')}` : '',
        l.url,
      ],
    };
  }), new Date());

  if (!ics) {
    setStatus('Set a time for at least one viewing first.');
    return;
  }
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `propsnap-viewings-${plan.date}.ics`;
  a.click();
  URL.revokeObjectURL(url);
  const timed = plan.keys.filter((k) => plan.times[k]).length;
  setStatus(`Calendar file saved with ${timed} viewing${timed === 1 ? '' : 's'}${timed < plan.keys.length ? ' (homes without a time are left out)' : ''}. Open it to add the events to your calendar.`);
}

function setStatus(message: string) {
  $('status').textContent = message;
}
