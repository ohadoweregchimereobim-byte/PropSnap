/**
 * PropSnap listing page (listing.html?key=source:listingId)
 *
 * One saved listing with the deal calculators. The numbers the user types
 * are saved per listing in the user-data store; only the ones that differ
 * from the listing's own figures are kept, so a new price still flows in.
 */
import type { PropertyListing } from '../../src/adapters/types';
import { getListings, LISTINGS_KEY, samePlace, setAreaSummary } from '../../src/services/storage';
import { formatMoney, SITE_NAMES } from '../../src/services/format';
import {
  addActivity,
  logCall,
  getAgentNotes,
  getAllUserData,
  getUserData,
  listingKey,
  removeActivity,
  saveAgentNote,
  saveDealInputs,
  setHidden,
  setLabels,
  updatePipeline,
  USER_DATA_KEY,
  type UserDataMap,
} from '../../src/services/user-data';
import {
  addLabel,
  agentKey,
  AGENTS_KEY,
  allLabels,
  CALL_OUTCOMES,
  stageForOutcome,
  cleanActivity,
  cleanLabels,
  lastCall,
  newActivity,
  outcomeLabel,
  removeLabel,
  timeline,
  whenText,
  type AgentNotes,
  type CallOutcome,
} from '../../src/services/crm';
import { cleanPipeline, followUpState, localDate, STATUSES, type PipelineStatus } from '../../src/services/pipeline';
import { safeLink } from '../../src/services/dashboard-view';
import {
  brr,
  buyToLet,
  cleanCustomCosts,
  CUSTOM_COST_NAME_MAX,
  CUSTOM_COSTS_MAX,
  dealInputsFor,
  flip,
  hmo,
  RATES_YEAR,
  type CustomCost,
  type DealInputs,
} from '../../src/services/calculators';
import { BRANDING_KEY, cleanBranding, getBranding, logoProblem, saveBranding, type Branding } from '../../src/services/branding';
import { fetchSoldPricesCached, type SoldPrice } from '../../src/services/land-registry';
import { areaCountries, fetchAreaChecksCached, findAreaPoint, FLOOD_WORDS, rightsNames, summariseArea, type AreaChecks } from '../../src/services/area-checks';
import { daysOnMarket, describeChange, describePortalChanges, portalChanges, priceChange } from '../../src/services/price-history';
import { buildReport, defaultStrategies, type Report, type Strategies } from '../../src/services/report';
import { FEW_SALES, FLIP_MIN_RISE_PCT, FLIP_MONTHS, median, saleAddress, soldPriceArea, soldPriceView, typeChoices, TYPE_NAMES, type Flip } from '../../src/services/sold-prices';
import { bandForScore, energyGap, lowWithPotential, type Band } from '../../src/services/epc-energy';
import { epcBand } from '../../src/adapters/epc-band';

const $ = (id: string) => document.getElementById(id)!;
const form = $('dealForm') as HTMLFormElement;
const fields = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]'));

const key = new URLSearchParams(location.search).get('key') ?? '';
let listing: PropertyListing | null = null;
// Every saved listing and the user's data for all of them, for labels and the agent box
let allListings: PropertyListing[] = [];
let allUserData: UserDataMap = {};
let agentNotes: AgentNotes = {};
let agentTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pipelineTimer: ReturnType<typeof setTimeout> | undefined;
// Pipeline fields changed here and not saved yet. Only these are saved, so a
// change saved elsewhere (the dashboard's stage drop-down, another tab) is
// kept, and shows here unless the user is changing that same field.
type PipelineField = 'status' | 'followUp' | 'notes';
const unsaved = new Set<PipelineField>();
// Fields being saved right now; an older copy arriving meanwhile must not replace them
const saving = new Set<PipelineField>();
// False when the postcode is on the England and Wales border and the user has not picked a country
let regionSure = true;
/** Report strategies the user ticked or unticked; the others follow the figures */
const touchedStrategies = new Set<keyof Strategies>();
let branding: Branding = cleanBranding(null);
let brandTimer: ReturnType<typeof setTimeout> | undefined;
// Sold prices for this listing; null until loaded
let sales: SoldPrice[] | null = null;
let soldRequest = 0;
// "Sales in CF24 2QH and on …", for the page and the report
let soldWhereText = '';
/** The searches that did not answer, as "in CF24 3AB" / "on Tweedsmuir Road" */
let soldMissing: string[] = [];
// Most rows the sold-price table shows
const SOLD_ROWS = 50;

init();

async function init() {
  form.addEventListener('input', (event) => {
    if ((event.target as HTMLElement).dataset.field === 'region') regionSure = true;
    calculate();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  });
  form.addEventListener('submit', (event) => event.preventDefault());

  $('resetBtn').addEventListener('click', async () => {
    if (!listing) return;
    clearTimeout(saveTimer);
    try {
      await saveDealInputs(key, null);
      const fresh = dealInputsFor(listing);
      regionSure = fresh.regionSure;
      fillForm(fresh.inputs);
      setStatus('Back to the listing figures');
    } catch (error: any) {
      setStatus(`Could not reset: ${error.message}`);
    }
  });

  setUpPipeline();
  setUpCrm();
  setUpCosts();
  setUpReportOptions();
  $('reportBtn').addEventListener('click', saveReport);
  $('energyLoad').addEventListener('click', loadEnergy);
  $('typeFilter').addEventListener('change', renderSold);
  $('sinceYears').addEventListener('change', renderSold);
  $('soldRefresh').addEventListener('click', () => loadSold(true));
  $('areaRefresh').addEventListener('click', () => loadArea(true));
  $('useMedian').addEventListener('click', () => {
    const value = Number(($('useMedian') as HTMLButtonElement).dataset.value);
    const input = form.querySelector<HTMLInputElement>('[data-field=valueAfterRefurb]');
    if (!input || !(value > 0)) return;
    input.value = String(Math.round(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setStatus('Value after the works set to the median sold price');
  });

  // A new capture or a delete in another tab changes the listing
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (LISTINGS_KEY in changes) loadListing(false);
    if (BRANDING_KEY in changes) {
      branding = cleanBranding(changes[BRANDING_KEY]!.newValue);
      fillBranding();
    }
    if (AGENTS_KEY in changes) {
      getAgentNotes().then((notes) => { agentNotes = notes; fillAgentNote(); showCrm(); });
    }
    if (USER_DATA_KEY in changes) {
      allUserData = (changes[USER_DATA_KEY]!.newValue as UserDataMap | undefined) ?? {};
      showCrm();
      const pipelineIn = (value: unknown) => JSON.stringify((value as UserDataMap | undefined)?.[key]?.pipeline ?? null);
      const { oldValue, newValue } = changes[USER_DATA_KEY]!;
      // Calculator saves change user data too; only a new pipeline is shown
      if (pipelineIn(oldValue) !== pipelineIn(newValue)) {
        refreshPipeline(cleanPipeline((newValue as UserDataMap | undefined)?.[key]?.pipeline));
      }
    }
  });

  // Save what is still waiting when the tab is closed or hidden
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (unsaved.size) { clearTimeout(pipelineTimer); saveThePipeline(); }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; save(); }
    if (agentTimer) { clearTimeout(agentTimer); saveTheAgentNote(); }
    if (brandTimer) { clearTimeout(brandTimer); saveTheBranding(); }
  });

  await loadListing(true);
}

async function loadListing(firstLoad: boolean) {
  try {
    allListings = await getListings();
    const found = allListings.find((l) => listingKey(l) === key) ?? null;
    const before = listing;
    listing = found;
    showHeader();
    if (!listing) return;

    // Fill the form the first time, and when a new capture brings new
    // listing figures (the user's own numbers stay)
    if (firstLoad || before?.price !== listing.price || before?.postcode !== listing.postcode) {
      const prefill = dealInputsFor(listing, (await getUserData(key)).deal);
      regionSure = prefill.regionSure;
      fillForm(prefill.inputs);
    }

    // Search again when the address changes; filters keep their setting
    if (firstLoad) {
      setTypeFilter();
      fillPipeline(cleanPipeline((await getUserData(key)).pipeline));
      [allUserData, agentNotes] = await Promise.all([getAllUserData(), getAgentNotes()]);
      fillAgentNote();
    }
    showCrm();
    if (firstLoad || before?.postcode !== listing.postcode || before?.fullAddress !== listing.fullAddress) {
      loadSold();
    } else {
      renderSold();
    }
    if (firstLoad || before?.latitude !== listing.latitude || before?.longitude !== listing.longitude || before?.postcode !== listing.postcode) {
      loadArea();
    }
  } catch (error: any) {
    setStatus(`Could not read the listing: ${error.message}`);
  }
}

function showHeader() {
  const missing = !listing;
  $('missing').hidden = !missing;
  $('calculator').hidden = missing;
  $('sold').hidden = missing;
  $('area').hidden = missing;
  $('pipeline').hidden = missing;
  $('agent').hidden = missing || !agentKey(listing ?? { agentName: null, agentBranch: null });
  $('writeLetter').hidden = missing;
  ($('writeLetter') as HTMLAnchorElement).href = `./letters.html?${new URLSearchParams({ keys: key })}`;
  $('energy').hidden = missing;
  $('reportControls').hidden = missing;
  if (!listing) {
    $('address').textContent = 'Listing not found';
    $('facts').textContent = '';
    $('listedAs').hidden = true;
    $('openListing').hidden = true;
    return;
  }

  const address = listing.fullAddress || listing.displayAddress || 'Saved listing';
  $('address').textContent = address;
  document.title = `${address} · PropSnap`;

  const listedAs = $('listedAs');
  listedAs.hidden = !(listing.fullAddress && listing.displayAddress);
  listedAs.textContent = `Listed as: ${listing.displayAddress}`;

  $('facts').textContent = [
    SITE_NAMES[listing.source] ?? listing.source,
    listing.price ? formatMoney(listing.price) + (listing.listingType === 'rent' ? ' a month' : '') : null,
    listing.priceQualifier,
    listing.bedrooms != null ? `${listing.bedrooms} bed` : null,
    listing.propertyType,
    listing.floorAreaSqm ? `${listing.floorAreaSqm} m²` : null,
    listing.epcRating ? `EPC ${listing.epcRating}` : null,
    listing.postcode || listing.postcodePartial,
  ].filter(Boolean).join(' · ');

  showPriceHistory(listing);
  showEnergy(listing);

  const href = safeLink(listing.url);
  const open = $('openListing') as HTMLAnchorElement;
  open.hidden = !href;
  if (href) open.href = href;
}

function setUpPipeline() {
  $('pipelineStatus').replaceChildren(...STATUSES.map((s) => {
    const option = document.createElement('option');
    option.value = s.value;
    option.textContent = s.label;
    return option;
  }));
  const later = (field: PipelineField) => {
    unsaved.add(field);
    showDue();
    clearTimeout(pipelineTimer);
    pipelineTimer = setTimeout(saveThePipeline, 500);
  };
  $('pipelineStatus').addEventListener('change', () => later('status'));
  $('pipelineFollowUp').addEventListener('change', () => later('followUp'));
  $('pipelineNotes').addEventListener('input', () => later('notes'));
  $('pipelineClearDate').addEventListener('click', () => {
    ($('pipelineFollowUp') as HTMLInputElement).value = '';
    later('followUp');
  });
}

function fillPipeline(p: ReturnType<typeof cleanPipeline>) {
  ($('pipelineStatus') as HTMLSelectElement).value = p?.status ?? 'new';
  ($('pipelineFollowUp') as HTMLInputElement).value = p?.followUp ?? '';
  ($('pipelineNotes') as HTMLTextAreaElement).value = p?.notes ?? '';
  showLastSaved(p);
  showDue();
}

function showLastSaved(p: ReturnType<typeof cleanPipeline>) {
  $('pipelineSaved').textContent = p?.updatedAt ? `Last saved ${new Date(p.updatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
}

/** Show a pipeline saved elsewhere, leaving alone what the user is still typing here */
function refreshPipeline(p: ReturnType<typeof cleanPipeline>) {
  const set = (field: PipelineField, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => {
    // Writing the same text back would move the cursor in the notes box
    if (!unsaved.has(field) && !saving.has(field) && el.value !== value) el.value = value;
  };
  set('status', $('pipelineStatus') as HTMLSelectElement, p?.status ?? 'new');
  set('followUp', $('pipelineFollowUp') as HTMLInputElement, p?.followUp ?? '');
  set('notes', $('pipelineNotes') as HTMLTextAreaElement, p?.notes ?? '');
  if (saving.size === 0) showLastSaved(p);
  showDue();
}

function readPipeline() {
  return {
    status: ($('pipelineStatus') as HTMLSelectElement).value as PipelineStatus,
    followUp: ($('pipelineFollowUp') as HTMLInputElement).value || null,
    notes: ($('pipelineNotes') as HTMLTextAreaElement).value,
  };
}

const DUE_TEXT = { overdue: 'Follow-up overdue', today: 'Follow up today', soon: 'Follow-up this week', later: '' };

function showDue() {
  const state = followUpState(cleanPipeline({ ...readPipeline(), updatedAt: '' }), localDate(new Date()));
  const due = $('pipelineDue');
  due.hidden = !state || state === 'later';
  due.className = `due due-${state}`;
  due.textContent = state ? DUE_TEXT[state] : '';
}

async function saveThePipeline() {
  // A listing deleted meanwhile has no user data any more; don't bring it back
  if (!listing || unsaved.size === 0) return;
  const fields = [...unsaved];
  unsaved.clear();
  for (const field of fields) saving.add(field);
  const typed = readPipeline();
  try {
    await updatePipeline(key, Object.fromEntries(fields.map((field) => [field, typed[field]])));
    $('pipelineSaved').textContent = 'Saved';
  } catch (error: any) {
    for (const field of fields) unsaved.add(field);
    $('pipelineSaved').textContent = `Could not save: ${error.message}`;
  } finally {
    for (const field of fields) saving.delete(field);
  }
}

function setUpCrm() {
  // An outcome that is a stage moves the deal there too
  $('callOutcome').replaceChildren(...CALL_OUTCOMES.map((o) => {
    const stage = stageForOutcome(o.value);
    return new Option(stage ? `${o.label} (moves the stage)` : o.label, o.value);
  }));

  const addTyped = async () => {
    const input = $('labelInput') as HTMLInputElement;
    const labels = addLabel(cleanLabels(allUserData[key]?.labels), input.value, allLabels(Object.values(allUserData).map((d) => cleanLabels(d.labels))));
    input.value = '';
    await saveOr(() => setLabels(key, labels), 'Could not save the label');
  };
  $('labelAdd').addEventListener('click', addTyped);
  $('labelInput').addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') { event.preventDefault(); addTyped(); }
  });
  $('hideBtn').addEventListener('click', () => saveOr(() => setHidden(key, !allUserData[key]?.hidden), 'Could not save'));

  const log = (kind: 'note' | 'call') => async () => {
    const box = $('activityText') as HTMLTextAreaElement;
    if (kind === 'note' && !box.value.trim()) { box.focus(); return; }
    const outcome = ($('callOutcome') as HTMLSelectElement).value as CallOutcome;
    const save = kind === 'call' ? () => logCall(key, box.value, outcome) : () => addActivity(key, newActivity('note', box.value, new Date()));
    await saveOr(async () => { await save(); box.value = ''; }, 'Could not save to the timeline');
  };
  $('addNote').addEventListener('click', log('note'));
  $('logCall').addEventListener('click', log('call'));

  $('agentNote').addEventListener('input', () => {
    clearTimeout(agentTimer);
    agentTimer = setTimeout(saveTheAgentNote, 600);
  });
}

async function saveOr(action: () => Promise<void>, failure: string) {
  try {
    await action();
  } catch (error: any) {
    setStatus(`${failure}: ${error.message}`);
  }
}

/** Labels, hidden, the timeline and the agent box, from the saved user data */
function showCrm() {
  if (!listing) return;
  const entry = allUserData[key] ?? {};
  const labels = cleanLabels(entry.labels);

  $('labelChips').replaceChildren(...labels.map((label) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = label;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove ${label}`;
    remove.setAttribute('aria-label', `Remove label ${label}`);
    remove.addEventListener('click', () => saveOr(() => setLabels(key, removeLabel(labels, label)), 'Could not save'));
    chip.append(remove);
    return chip;
  }));
  const offered = allLabels(Object.values(allUserData).map((d) => cleanLabels(d.labels)))
    .filter((l) => !labels.some((x) => x.toLowerCase() === l.toLowerCase()));
  $('labelOptions').replaceChildren(...offered.map((l) => new Option(l)));

  $('hideBtn').textContent = entry.hidden ? 'Unhide' : 'Hide this home';
  $('hiddenNote').hidden = !entry.hidden;

  const activity = cleanActivity(entry.activity);
  const now = new Date();
  const call = lastCall(activity);
  $('lastCallLine').textContent = call ? `Last call ${whenText(call.at, now)}: ${outcomeLabel(call.outcome)}` : 'No calls logged yet.';

  $('timeline').replaceChildren(...timeline(activity, listing.priceHistory, { on: listing.listedOn, site: SITE_NAMES[listing.source] }).map((item) => {
    const li = document.createElement('li');
    li.className = `t-${item.kind}`;
    const time = document.createElement('time');
    time.dateTime = item.at;
    // The site gives a day, not a time
    time.textContent = item.kind === 'listed'
      ? new Date(item.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
      : new Date(item.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 't-title';
    title.textContent = item.title;
    body.append(title);
    if (item.text) {
      const text = document.createElement('div');
      text.className = 't-text';
      text.textContent = item.text;
      body.append(text);
    }
    li.append(time, body);
    if (item.id) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '✕';
      remove.title = 'Delete this entry';
      remove.setAttribute('aria-label', 'Delete this entry');
      remove.addEventListener('click', () => {
        if (confirm('Delete this entry from the timeline?')) saveOr(() => removeActivity(key, item.id!), 'Could not delete');
      });
      li.append(remove);
    } else {
      li.append(document.createElement('span'));
    }
    return li;
  }));

  showAgent();
}

/** The agent's name and phone, their other saved listings and the last call to them */
function showAgent() {
  if (!listing) return;
  const agent = agentKey(listing);
  if (!agent) return;
  const line = $('agentLine');
  line.replaceChildren(`${listing.agentName}${listing.agentBranch ? `, ${listing.agentBranch}` : ''}`);
  if (listing.agentPhone) {
    const tel = document.createElement('a');
    tel.href = `tel:${listing.agentPhone.replace(/[^\d+]/g, '')}`;
    tel.textContent = listing.agentPhone;
    line.append(' · ', tel);
  }

  const theirs = allListings.filter((l) => agentKey(l) === agent);
  const others = theirs.length - 1;
  const calls = theirs.map((l) => lastCall(cleanActivity(allUserData[listingKey(l)]?.activity))).filter((c) => c !== null);
  const latest = calls.reduce<(typeof calls)[number] | null>((a, c) => (!a || c!.at > a.at ? c : a), null);
  $('agentOthers').textContent = [
    others > 0 ? `${others} other saved listing${others === 1 ? '' : 's'} from this agent.` : 'No other saved listings from this agent.',
    latest ? `Last call to them ${whenText(latest.at, new Date())}.` : '',
  ].filter(Boolean).join(' ');
}

function fillAgentNote() {
  if (!listing) return;
  const agent = agentKey(listing);
  const box = $('agentNote') as HTMLTextAreaElement;
  // Leave alone what the user is still typing here
  if (!agent || agentTimer || document.activeElement === box) return;
  box.value = agentNotes[agent]?.note ?? '';
}

async function saveTheAgentNote() {
  agentTimer = undefined;
  const agent = listing && agentKey(listing);
  if (!agent) return;
  try {
    await saveAgentNote(agent, ($('agentNote') as HTMLTextAreaElement).value);
    $('agentSaved').textContent = 'Saved for every listing from this agent';
  } catch (error: any) {
    $('agentSaved').textContent = `Could not save: ${error.message}`;
  }
}

/** The EPC rating now and potential, with the recommended improvements */
function showEnergy(l: PropertyListing) {
  const energy = l.epcEnergy?.certificateNumber && (!l.epcCertificateNumber || l.epcEnergy.certificateNumber === l.epcCertificateNumber)
    ? l.epcEnergy
    : null;
  const status = $('energyStatus');
  $('energyBody').hidden = !energy;
  $('energyLoad').hidden = !!energy || !l.fullAddress;
  status.hidden = !!energy;
  if (!energy) {
    status.textContent = l.fullAddress
      ? 'Not read yet for this home. Click Get EPC details to read its certificate.'
      : 'No full address yet, so PropSnap cannot tell which certificate is this home.';
    return;
  }

  const setBand = (el: HTMLElement, band: Band | null, score: number | null) => {
    el.className = `band band-${band ?? 'none'}`;
    el.textContent = band ? `${band}${score != null ? ` ${score}` : ''}` : '?';
  };
  setBand($('energyNow'), energy.currentBand, energy.currentScore);
  setBand($('energyPotential'), energy.potentialBand, energy.potentialScore);

  const gap = energyGap(energy);
  $('energyGap').textContent = !gap || (gap.bands <= 0 && !gap.points)
    ? ''
    : `Up ${gap.bands > 0 ? `${gap.bands} band${gap.bands === 1 ? '' : 's'}` : ''}${gap.bands > 0 && gap.points ? ', ' : ''}${gap.points ? `${gap.points} points` : ''}`;
  $('energyTag').hidden = !lowWithPotential(energy);

  const notes: string[] = [];
  if (energy.registrationDate) notes.push(`Certificate from ${shortDate(energy.registrationDate)}; works since then are not in it.`);
  if (l.addressConfidence === 'best_guess') notes.push('This is the certificate of the best-guess home. Check the address on the dashboard.');
  const listed = epcBand(l.epcRating);
  if (listed && energy.currentBand && listed !== energy.currentBand) {
    notes.push(`The listing says EPC ${listed}; this certificate says ${energy.currentBand}. The listing may use a newer certificate.`);
  }
  $('energyNote').textContent = notes.join(' ');

  $('energyImprovementsBox').hidden = energy.improvements.length === 0;
  $('energyImprovements').replaceChildren(...energy.improvements.map((imp) => {
    const tr = document.createElement('tr');
    const after = imp.ratingAfter != null ? `${imp.ratingAfter} (${bandForScore(imp.ratingAfter)})` : '—';
    [imp.name, imp.cost ?? '—', imp.saving != null ? formatMoney(imp.saving) : '—', after].forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (i >= 2) td.className = 'num';
      tr.append(td);
    });
    return tr;
  }));
}

async function loadEnergy() {
  if (!listing) return;
  const button = $('energyLoad') as HTMLButtonElement;
  button.disabled = true;
  $('energyStatus').textContent = 'Reading the certificate from the EPC register…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'LOAD_EPC_ENERGY', source: listing.source, listingId: listing.listingId });
    if (!response?.success) throw new Error(response?.error ?? 'no answer from PropSnap');
    // The saved listing changes, and the storage listener redraws the page
  } catch (error: any) {
    $('energyStatus').textContent = `Could not read the certificate: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

/**
 * How long the site says it has been on the market, and how the price moved:
 * between captures (with amounts) and as the site shows it (dates only)
 */
function showPriceHistory(l: PropertyListing) {
  const days = daysOnMarket(l, localDate(new Date()));
  $('onMarket').hidden = days == null;
  $('onMarket').textContent = days == null ? '' : `On the market since ${shortDate(`${l.listedOn}T12:00:00Z`)}: ${days} day${days === 1 ? '' : 's'} (${SITE_NAMES[l.source]}'s date)`;

  const portal = describePortalChanges(l);
  $('portalChangeLine').hidden = !portal;
  $('portalChangeLine').textContent = portal ? `${portal}. ${SITE_NAMES[l.source]} does not show the amounts.` : '';
  $('portalChangeLine').className = `price-change price-${portalChanges(l).at(-1)?.direction === 'up' ? 'increased' : 'reduced'}`;

  const change = priceChange(l);
  $('priceHistory').hidden = !change && !portal;
  $('priceChangeLine').hidden = !change;
  $('capturedHistory').hidden = !change;
  if (!change) return;

  const line = $('priceChangeLine');
  line.className = `price-change price-${change.direction}`;
  line.textContent = `${describeChange(change)} since ${shortDate(change.first.seenAt)}, from ${formatMoney(change.first.price!)}`;

  const suffix = l.listingType === 'rent' ? ' a month' : '';
  const points = l.priceHistory ?? [];
  $('priceHistoryRows').replaceChildren(...points.map((p, i) => {
    const tr = document.createElement('tr');
    const before = points.slice(0, i).reverse().find((q) => q.price);
    const step = p.price && before?.price ? p.price - before.price : 0;
    const cells = [
      shortDate(p.seenAt),
      p.price ? `${formatMoney(p.price)}${suffix}` : 'No price',
      p.qualifier ?? '',
      step ? `${step > 0 ? '+' : '−'}${formatMoney(Math.abs(step))}` : '',
    ];
    cells.forEach((text, n) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (n === 1 || n === 3) td.className = 'num';
      if (n === 3 && step) td.classList.add(step < 0 ? 'price-reduced' : 'price-increased');
      tr.append(td);
    });
    return tr;
  }));
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fillForm(inputs: DealInputs) {
  for (const el of fields) {
    el.value = String(inputs[el.dataset.field as keyof DealInputs]);
  }
  fillCustomCosts(inputs.customCosts);
  calculate();
}

// ── Custom costs ──────────────────────────────────────────────────────────

function costRow(cost: CustomCost | null): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cost-row';
  const name = document.createElement('input');
  name.className = 'cost-name';
  name.maxLength = CUSTOM_COST_NAME_MAX;
  name.placeholder = 'For example: gas safety check';
  name.setAttribute('aria-label', 'Cost');
  name.value = cost?.name ?? '';
  const amount = document.createElement('input');
  amount.className = 'cost-amount';
  amount.type = 'number';
  amount.min = '0';
  amount.step = '10';
  amount.setAttribute('aria-label', 'Amount (£)');
  amount.value = cost ? String(cost.amount) : '';
  const when = document.createElement('select');
  when.className = 'cost-when';
  when.setAttribute('aria-label', 'When');
  when.append(new Option('£ once', 'once'), new Option('£ a month', 'monthly'));
  when.value = cost?.when ?? 'once';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'cost-remove';
  remove.textContent = '✕';
  remove.title = 'Remove this cost';
  remove.addEventListener('click', () => {
    row.remove();
    $('addCost').hidden = false;
    form.dispatchEvent(new Event('input'));
  });
  row.append(name, amount, when, remove);
  return row;
}

function fillCustomCosts(costs: CustomCost[]) {
  $('customCosts').replaceChildren(...costs.map(costRow));
  $('addCost').hidden = costs.length >= CUSTOM_COSTS_MAX;
}

/** The rows that have a name and an amount; a row still being typed is left out */
function readCustomCosts(): CustomCost[] {
  return cleanCustomCosts(Array.from($('customCosts').querySelectorAll<HTMLElement>('.cost-row')).map((row) => ({
    name: row.querySelector<HTMLInputElement>('.cost-name')!.value,
    amount: row.querySelector<HTMLInputElement>('.cost-amount')!.valueAsNumber,
    when: row.querySelector<HTMLSelectElement>('.cost-when')!.value,
  })));
}

function setUpCosts() {
  $('addCost').addEventListener('click', () => {
    const rows = $('customCosts');
    if (rows.children.length >= CUSTOM_COSTS_MAX) return;
    const row = costRow(null);
    rows.append(row);
    $('addCost').hidden = rows.children.length >= CUSTOM_COSTS_MAX;
    row.querySelector('input')!.focus();
  });
}

// ── Report options and branding ───────────────────────────────────────────

function strategyBoxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('[data-strategy]'));
}

function readStrategies(): Strategies {
  const show = { btl: false, brr: false, flip: false, hmo: false };
  for (const box of strategyBoxes()) show[box.dataset.strategy as keyof Strategies] = box.checked;
  return show;
}

/** Boxes the user has not touched follow the figures: BRR and flip once works are typed, HMO once rooms are */
function updateStrategies(inputs: DealInputs) {
  const auto = defaultStrategies(inputs);
  for (const box of strategyBoxes()) {
    const name = box.dataset.strategy as keyof Strategies;
    if (!touchedStrategies.has(name)) box.checked = auto[name];
  }
}

function setUpReportOptions() {
  for (const box of strategyBoxes()) {
    box.addEventListener('change', () => touchedStrategies.add(box.dataset.strategy as keyof Strategies));
  }
  getBranding().then((saved) => { branding = saved; fillBranding(); }).catch(() => {});

  const typed = () => {
    branding = {
      ...branding,
      company: ($('brandCompany') as HTMLInputElement).value,
      contact: ($('brandContact') as HTMLTextAreaElement).value,
      colour: ($('brandColour') as HTMLInputElement).value,
    };
    clearTimeout(brandTimer);
    brandTimer = setTimeout(saveTheBranding, 500);
  };
  for (const id of ['brandCompany', 'brandContact', 'brandColour']) $(id).addEventListener('input', typed);

  $('brandLogo').addEventListener('change', () => {
    const input = $('brandLogo') as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const problem = logoProblem(file);
    if (problem) { $('brandSaved').textContent = problem; return; }
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      branding = { ...branding, logo: String(reader.result) };
      if (!cleanBranding(branding).logo) { $('brandSaved').textContent = 'Could not use this image'; return; }
      fillBranding();
      saveTheBranding();
    });
    reader.readAsDataURL(file);
  });
  $('brandLogoRemove').addEventListener('click', () => {
    branding = { ...branding, logo: null };
    fillBranding();
    saveTheBranding();
  });
}

/** Shows the saved branding; a field the user is typing in is left alone */
function fillBranding() {
  const set = (id: string, value: string) => {
    const el = $(id) as HTMLInputElement | HTMLTextAreaElement;
    if (document.activeElement !== el && el.value !== value) el.value = value;
  };
  set('brandCompany', branding.company);
  set('brandContact', branding.contact);
  set('brandColour', branding.colour);
  const preview = $('brandLogoPreview') as HTMLImageElement;
  preview.hidden = !branding.logo;
  if (branding.logo) preview.src = branding.logo;
  else preview.removeAttribute('src');
  $('brandLogoRemove').hidden = !branding.logo;
}

async function saveTheBranding() {
  brandTimer = undefined;
  try {
    await saveBranding(branding);
    $('brandSaved').textContent = 'Saved for every report';
  } catch (error: any) {
    $('brandSaved').textContent = `Could not save: ${error.message}`;
  }
}

function readForm(): DealInputs {
  const inputs = {} as Record<string, string | number>;
  for (const el of fields) {
    const field = el.dataset.field!;
    if (el instanceof HTMLInputElement) {
      const value = el.valueAsNumber;
      inputs[field] = Number.isFinite(value) && value > 0 ? value : 0;
    } else {
      inputs[field] = el.value;
    }
  }
  return { ...(inputs as unknown as DealInputs), customCosts: readCustomCosts() };
}

async function save() {
  saveTimer = undefined;
  if (!listing) return;
  const current = readForm();
  const fromListing = dealInputsFor(listing);
  // Keep only what the user changed
  const changed: Partial<DealInputs> = {};
  for (const field of Object.keys(current) as (keyof DealInputs)[]) {
    if (JSON.stringify(current[field]) !== JSON.stringify(fromListing.inputs[field])) (changed as Record<string, unknown>)[field] = current[field];
  }
  // On a border postcode, a country the user confirmed is kept even when it matches the guess
  if (!fromListing.regionSure && regionSure) changed.region = current.region;
  try {
    await saveDealInputs(key, Object.keys(changed).length > 0 ? changed : null);
    setStatus('Saved');
  } catch (error: any) {
    setStatus(`Could not save: ${error.message}`);
  }
}

function calculate() {
  if (!listing) return;
  const inputs = readForm();
  $('regionHint').hidden = regionSure;

  // With no price the figures mean nothing, so ask for one instead
  const hasPrice = inputs.price > 0;
  updateStrategies(inputs);
  $('needPrice').hidden = hasPrice;
  for (const card of document.querySelectorAll<HTMLElement>('.results .card')) card.hidden = !hasPrice;
  for (const hint of document.querySelectorAll<HTMLElement>('.need-rent')) hint.hidden = inputs.rentMonthly > 0;
  if (!hasPrice) return;

  const btl = buyToLet(inputs);
  const tax = btl.tax;
  $('taxName').textContent = tax.name;
  $('taxTotal').textContent = formatMoney(tax.total);
  $('taxSlices').replaceChildren(...tax.slices.map((s) => {
    const tr = document.createElement('tr');
    const band = document.createElement('td');
    band.textContent = `${formatMoney(s.from)} to ${formatMoney(s.to)}`;
    const rate = document.createElement('td');
    rate.className = 'num';
    rate.textContent = `${s.rate}%`;
    const amount = document.createElement('td');
    amount.className = 'num';
    amount.textContent = formatMoney(s.tax);
    tr.append(band, rate, amount);
    return tr;
  }));
  $('taxNote').hidden = !tax.note;
  $('taxNote').textContent = tax.note ?? '';
  $('taxYear').textContent = `${RATES_YEAR} rates. Check ${inputs.region === 'wales' ? 'the Welsh Revenue Authority' : 'GOV.UK'} before you buy.`;

  rows($('btlRows'), [
    ['Gross yield', pct(btl.grossYieldPct)],
    ['Net yield (before mortgage)', pct(btl.netYieldPct)],
    ['Deposit', formatMoney(btl.deposit)],
    ['Mortgage', formatMoney(btl.loan)],
    ['Mortgage payment', `${formatMoney(btl.mortgageMonthly)} a month`],
    ['Running costs', `${formatMoney(btl.runningCostsMonthly)} a month`],
    ['Cashflow', `${formatMoney(btl.cashflowMonthly)} a month`, btl.cashflowMonthly < 0],
    ['Cash you put in', formatMoney(btl.cashInvested), false, 'Deposit, tax, legal fees, survey, sourcing fee and your one-off costs'],
    ['Return on your cash', btl.returnOnCashPct == null ? '—' : pct(btl.returnOnCashPct), (btl.returnOnCashPct ?? 0) < 0],
  ]);

  // No value after the works typed yet: take the purchase price
  const deal = brr({ ...inputs, valueAfterRefurb: inputs.valueAfterRefurb || inputs.price });
  rows($('brrRows'), [
    ['Cash you put in', formatMoney(deal.cashIn), false, 'Deposit, tax, legal fees, survey, sourcing fee, your one-off costs and the works'],
    ['New mortgage', formatMoney(deal.refinanceLoan)],
    ['Cash you take back out', formatMoney(deal.cashReleased), deal.cashReleased < 0, 'New mortgage minus the first mortgage'],
    ['Money left in the deal', deal.moneyLeftIn <= 0 ? `None (${formatMoney(-deal.moneyLeftIn)} more out than in)` : formatMoney(deal.moneyLeftIn)],
    ['Mortgage payment', `${formatMoney(deal.mortgageMonthly)} a month`],
    ['Cashflow', `${formatMoney(deal.cashflowMonthly)} a month`, deal.cashflowMonthly < 0],
    ['Return on money left in', deal.returnOnMoneyLeftPct == null ? 'No money left in' : pct(deal.returnOnMoneyLeftPct), (deal.returnOnMoneyLeftPct ?? 0) < 0],
  ]);

  const f = flip(inputs);
  $('flipNeedValue').hidden = inputs.valueAfterRefurb > 0 && inputs.valueAfterRefurb !== inputs.price;
  rows($('flipCalcRows'), [
    ['Sale price', formatMoney(f.salePrice), false, 'The value after the works'],
    ['Profit before tax', formatMoney(f.profit), f.profit < 0],
    ['Profit on cost', f.profitOnCostPct == null ? '—' : pct(f.profitOnCostPct), f.profit < 0],
    ['Cash needed', formatMoney(f.cashNeeded), false, 'Price less the bridging loan, tax, buying costs, the works, holding costs and the lender\'s fees'],
    ['Return on cash', f.returnOnCashPct == null ? '—' : pct(f.returnOnCashPct), f.profit < 0],
    ['Profit a month', f.profitMonthly == null ? '—' : formatMoney(f.profitMonthly), f.profit < 0],
    ['Total cost', formatMoney(f.totalCost), false, 'Price, tax, buying costs, works, finance, holding and selling costs'],
    ['Finance costs', formatMoney(f.financeCost), false, 'Bridging interest and fees'],
    ['Holding costs', formatMoney(f.holdingCost)],
    ['Selling costs', formatMoney(f.sellingCost), false, 'Agent and legal fees on the sale'],
  ]);

  const h = hmo(inputs);
  const hasRooms = inputs.hmoRooms > 0 && inputs.hmoRoomRent > 0;
  $('hmoNeedRooms').hidden = hasRooms;
  $('hmoRows').hidden = !hasRooms;
  rows($('hmoRows'), [
    ['Rent', `${formatMoney(h.rentMonthly)} a month`],
    ['Gross yield', pct(h.grossYieldPct)],
    ['Net yield (before mortgage)', pct(h.netYieldPct)],
    ['Running costs', `${formatMoney(h.runningCostsMonthly)} a month`, false, 'Management, repairs and empty rooms, bills, the licence and your monthly costs'],
    ['Mortgage payment', `${formatMoney(h.mortgageMonthly)} a month`],
    ['Cashflow', `${formatMoney(h.cashflowMonthly)} a month`, h.cashflowMonthly < 0],
    ['Cashflow a room', h.cashflowPerRoom == null ? '—' : `${formatMoney(h.cashflowPerRoom)} a month`, h.cashflowMonthly < 0],
    ['Cash you put in', formatMoney(h.cashInvested), false, 'Deposit, tax, buying costs, sourcing fee, your one-off costs and the works'],
    ['Return on your cash', h.returnOnCashPct == null ? '—' : pct(h.returnOnCashPct), (h.returnOnCashPct ?? 0) < 0],
  ]);
}

function setTypeFilter() {
  if (!listing) return;
  // The closest match comes first and is picked
  $('typeFilter').replaceChildren(...typeChoices(listing.propertyType).map((choice) => {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    return option;
  }));
}

/** Sold prices kept from earlier today show at once; `fresh` asks Land Registry again */
// ── Area checks ──────────────────────────────────────────────────────────

let areaRequest = 0;
/** The checks shown now, for the report */
let areaShown: AreaChecks | null = null;
let areaRightsNames: Record<string, string> = {};

/** Wales by the postcode (a border postcode is not): only the Welsh maps are asked, and Wales has no Article 4 map */
function isWales(l: PropertyListing): boolean {
  return !areaCountries(l).includes('england');
}

async function loadArea(fresh = false) {
  if (!listing) return;
  const request = ++areaRequest;
  const l = listing;
  areaShown = null;
  $('areaBody').hidden = true;
  const showStatus = (text: string) => { $('areaStatus').hidden = false; $('areaStatus').textContent = text; };

  const point = await findAreaPoint(l);
  if (request !== areaRequest) return;
  if (!point) {
    $('areaWhere').textContent = '';
    showStatus('PropSnap needs the map position from the listing, or the full postcode, to check the area. This listing has neither.');
    return;
  }
  $('areaWhere').textContent = point.source === 'listing'
    ? `Checked at the map position ${SITE_NAMES[l.source]} gives for this home.`
    : `Checked at the centre of the postcode ${l.postcode}, as the listing has no map position. A boundary can run through a postcode.`;
  // Each country's maps cover only that country, so the home's own are asked (both near the border)
  const countries = areaCountries(l);
  const asking = countries.length > 1 ? 'the Environment Agency, Natural Resources Wales, the planning data service'
    : countries[0] === 'wales' ? 'Natural Resources Wales, DataMapWales' : 'the Environment Agency, the planning data service';
  showStatus(`Asking ${asking} and the police…`);

  try {
    const [checks, names] = await Promise.all([fetchAreaChecksCached(point, { fresh, countries }), rightsNames()]);
    if (request !== areaRequest) return;
    areaShown = checks;
    areaRightsNames = names;
    $('areaStatus').hidden = checks.failed.length === 0;
    $('areaStatus').textContent = checks.failed.length ? `Could not check ${checks.failed.join(', ')} just now. Click Check again to try again.` : '';
    renderArea(checks, names, l);
    // Keep the short version for the dashboard and CSV; a check that failed today keeps its last result.
    // Not when the listing was captured again somewhere else while this page was open
    setAreaSummary(l.source, l.listingId, (previous, saved) => (
      samePlace(saved, l) ? summariseArea(checks, { wales: isWales(l), previous }) : null
    )).catch(() => {});
  } catch (error: any) {
    if (request !== areaRequest) return;
    showStatus(`Could not check the area: ${error.message}. Click Check again to try again.`);
  }
}

function renderArea(a: AreaChecks, rightNames: Record<string, string>, l: PropertyListing) {
  const wales = isWales(l);
  const set = (id: string, text: string, tone: 'bad' | 'warn' | 'good' | 'none') => {
    $(id).textContent = text;
    $(id).className = `area-result area-${tone}`;
  };
  const list = (id: string, items: string[]) => {
    $(id).replaceChildren(...items.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }));
  };

  // Flood
  if (!a.flood) set('areaFlood', 'Could not check', 'none');
  else set('areaFlood', FLOOD_WORDS[a.flood.zone], a.flood.zone === 'FZ3' ? 'bad' : a.flood.zone === 'FZ2' ? 'warn' : 'good');
  $('areaFloodNote').textContent = !a.flood ? ''
    : a.flood.zone === 'none'
      ? 'From the Flood Map for Planning. It does not cover surface water or groundwater: check the long term flood risk service too.'
      : `${a.flood.by}'s Flood Map for Planning${a.flood.sourceOfFlooding ? ` (${a.flood.sourceOfFlooding})` : ''}. It can affect insurance, mortgages and planning. Check the long term flood risk service before you offer.`;

  // Conservation
  if (!a.conservation) set('areaConservation', 'Could not check', 'none');
  else if (a.conservation.length) {
    set('areaConservation', `Inside ${a.conservation.map((c) => `${c.name}${c.council ? ` (${c.council})` : ''}`).join(', ')}`, 'warn');
  } else set('areaConservation', 'Not in a conservation area that has been mapped', 'good');
  $('areaConservationNote').textContent = !a.conservation ? ''
    : a.conservation.length
      ? 'Extra planning control: changes to the outside (windows, doors, roofs, extensions) and demolition may need permission.'
      : wales ? 'From the Welsh conservation area boundaries.' : 'Not every council has added its areas to the national data yet: check the council\'s map to be sure.';

  // Article 4
  const a4 = a.article4;
  if (!a4) set('areaArticle4', 'Could not check', 'none');
  else if (a4.some((d) => d.hmo)) set('areaArticle4', 'HMO Article 4: turning a house into a small HMO needs planning permission here', 'bad');
  else if (a4.length) set('areaArticle4', `${a4.length} Article 4 direction${a4.length === 1 ? '' : 's'} here, none about HMOs`, 'warn');
  else if (wales) set('areaArticle4', 'No national Article 4 map for Wales', 'none');
  else set('areaArticle4', 'None found in the national planning data', 'good');
  list('areaArticle4List', (a4 ?? []).map((d) => {
    const removed = d.rights.map((r) => rightNames[r] ?? `class ${r}`);
    return `${d.name}${removed.length ? `: removes ${removed.join('; ')}` : ''}`;
  }));
  $('areaArticle4Note').textContent = !a4 ? ''
    : wales
      ? 'In Wales, a council usually decides on turning a home into an HMO through a planning application, so there is no Article 4 map to check. Ask the council about its HMO policy.'
      : 'Not every council has added its directions to the national data yet: check the council\'s website to be sure.';

  // Crime
  const c = a.crime;
  const monthName = (ym: string) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (!c) set('areaCrime', 'Could not check', 'none');
  else set('areaCrime', `${c.total} street crime${c.total === 1 ? '' : 's'} within about a mile in ${monthName(c.month)}`, 'none');
  list('areaCrimeList', (c?.byCategory ?? []).slice(0, 5).map((x) => `${x.label}: ${x.count}`));
  $('areaCrimeNote').textContent = c
    ? 'The latest month police.uk has. Busy streets, shops and town centres raise the count; compare with other homes you are looking at.'
    : '';

  $('areaBody').hidden = false;
}

async function loadSold(fresh = false) {
  if (!listing) return;
  const request = ++soldRequest;
  const area = soldPriceArea(listing);
  sales = null;
  soldMissing = [];

  const where = [
    area.postcode ? `in ${area.postcode}` : null,
    area.street && area.outcode ? `on ${titleCase(area.street)} (${area.outcode})` : null,
  ].filter(Boolean);
  soldWhereText = where.length ? `Sales ${where.join(' and ')}.` : '';
  $('soldWhere').textContent = soldWhereText;

  if (where.length === 0) {
    showSoldStatus('PropSnap needs the full postcode or the street name to find sold prices, and this listing has neither.');
    return;
  }

  showSoldStatus('Asking HM Land Registry…');
  try {
    const found = await fetchSoldPricesCached(area, { fresh });
    if (request !== soldRequest) return;
    sales = found.sales;
    // One search failed: the figures are only part of the picture (the report says so too)
    soldMissing = found.failed.map((search) => (search === 'postcode' ? `in ${area.postcode}` : `on ${titleCase(area.street ?? '')}`));
    if (soldMissing.length) soldWhereText += ` Sales ${soldMissing.join(' and ')} could not be fetched just now, so these are only part of the picture.`;
    $('soldWhere').textContent = soldMissing.length ? `${soldWhereText} Click Refresh to try again.` : soldWhereText;
    // Say when a kept answer is shown, so the user knows Refresh asks again
    const minutes = Math.floor((Date.now() - found.at) / 60_000);
    if (minutes >= 1) {
      $('soldWhere').textContent = `${soldWhereText} Fetched ${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`} ago; Refresh asks again.`;
    }
    renderSold();
  } catch (error: any) {
    if (request !== soldRequest) return;
    showSoldStatus(`Could not get sold prices from HM Land Registry: ${error.message}. Click Refresh to try again.`);
  }
}

/** The sold prices with the filters picked on the page */
function currentSoldView(l: PropertyListing, all: SoldPrice[]) {
  const typeSelect = $('typeFilter') as HTMLSelectElement;
  const yearsSelect = $('sinceYears') as HTMLSelectElement;
  const choice = typeSelect.value;
  const view = soldPriceView(all, l, {
    types: typeChoices(l.propertyType).find((c) => c.value === choice)?.types ?? null,
    sinceYears: yearsSelect.value ? Number(yearsSelect.value) : null,
    today: new Date(),
  });
  const filters = [typeSelect.selectedOptions[0]?.textContent, yearsSelect.selectedOptions[0]?.textContent?.toLowerCase()]
    .filter(Boolean).join(', ');
  return { view, choice, filters };
}

/** Build the report from what the page shows now, then open Chrome's print window */
function saveReport() {
  if (!listing) return;
  const inputs = readForm();
  const brrInputs = { ...inputs, valueAfterRefurb: inputs.valueAfterRefurb || inputs.price };
  const report = buildReport({
    listing,
    sold: sales && sales.length ? { ...currentSoldView(listing, sales), where: soldWhereText } : null,
    deal: { inputs, btl: buyToLet(inputs), brr: brr(brrInputs), flip: flip(inputs), hmo: hmo(inputs), show: readStrategies() },
    branding,
    area: areaShown ? { checks: areaShown, rightsNames: areaRightsNames, wales: isWales(listing) } : null,
    pipeline: cleanPipeline({ ...readPipeline(), updatedAt: '' }),
    labels: cleanLabels(allUserData[key]?.labels),
    activity: cleanActivity(allUserData[key]?.activity),
    includeNotes: ($('reportNotes') as HTMLInputElement).checked,
    generatedAt: new Date(),
  });
  renderReport(report);

  // The title becomes the PDF's file name
  const title = document.title;
  document.title = `PropSnap report - ${report.title}`;
  window.addEventListener('afterprint', () => { document.title = title; }, { once: true });
  window.print();
}

function renderReport(report: Report) {
  const el = (tag: string, text?: string, className?: string) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  const parts: HTMLElement[] = [];
  const page = $('report');
  if (report.brand) {
    const head = el('header', undefined, 'report-brand');
    if (report.brand.logo) {
      const img = document.createElement('img');
      img.src = report.brand.logo;
      img.alt = report.brand.company || 'Logo';
      head.append(img);
    }
    const who = el('div');
    if (report.brand.company) who.append(el('strong', report.brand.company));
    if (report.brand.contact) who.append(el('p', report.brand.contact, 'report-contact'));
    head.append(who);
    parts.push(head);
    page.style.setProperty('--brand', report.brand.colour);
    page.style.setProperty('--brand-heading', report.brand.headingColour);
  } else {
    page.style.removeProperty('--brand');
    page.style.removeProperty('--brand-heading');
  }
  parts.push(el('h1', report.title), el('p', report.subtitle, 'report-subtitle'));
  for (const section of report.sections) {
    const box = el('section', undefined, 'report-section');
    box.append(el('h2', section.heading));
    if (section.rows?.length) {
      const dl = el('dl', undefined, 'report-rows');
      for (const [label, value] of section.rows) dl.append(el('dt', label), el('dd', value));
      box.append(dl);
    }
    if (section.text) box.append(el('p', section.text, 'report-text'));
    if (section.table?.rows.length) {
      const table = el('table', undefined, 'report-table');
      const head = el('tr');
      section.table.head.forEach((h, i) => head.append(el('th', h, section.table!.numeric.includes(i) ? 'num' : undefined)));
      table.append(el('thead'), el('tbody'));
      table.firstChild!.appendChild(head);
      for (const row of section.table.rows) {
        const tr = el('tr');
        row.forEach((cell, i) => tr.append(el('td', cell, section.table!.numeric.includes(i) ? 'num' : undefined)));
        table.lastChild!.appendChild(tr);
      }
      box.append(table);
    }
    for (const note of section.notes ?? []) box.append(el('p', note, 'report-note'));
    parts.push(box);
  }
  parts.push(el('p', report.footer, 'report-footer'));
  page.replaceChildren(...parts);
}

function showSoldStatus(message: string) {
  $('soldStatus').textContent = message;
  $('soldStatus').hidden = false;
  $('soldBody').hidden = true;
}

function renderSold() {
  if (!listing || !sales) return;
  if (sales.length === 0) {
    showSoldStatus(soldMissing.length
      ? `Sales ${soldMissing.join(' and ')} could not be fetched just now, and the other search found none. Click Refresh to try again.`
      : 'HM Land Registry has no sales here. New streets, and homes not sold since 1995, have none.');
    return;
  }

  const { view, choice } = currentSoldView(listing, sales);

  $('soldStatus').hidden = true;
  $('soldBody').hidden = false;

  $('soldMedian').textContent = view.median == null ? '—' : formatMoney(view.median);
  $('soldRange').textContent = view.low == null ? '—' : view.low === view.high ? formatMoney(view.low) : `${formatMoney(view.low)} to ${formatMoney(view.high!)}`;
  $('soldCount').textContent = String(view.comparables.length);
  const used = view.comparables.filter((s) => s.standard).length;
  $('soldCountLabel').textContent = used === view.comparables.length ? 'Sales' : `Sales (${used} used in the figures)`;

  // A median from one or two sales is not worth much; say so
  const few = $('fewSales');
  few.hidden = used === 0 || used >= FEW_SALES;
  few.textContent = `Only ${used} sale${used === 1 ? '' : 's'} in the figures, so this is weak evidence. Try more years${choice === 'all' ? '' : ' or a wider type'}.`;
  const asking = $('soldAsking');
  asking.textContent = view.askingVsMedianPct == null
    ? '—'
    : `${view.askingVsMedianPct > 0 ? '+' : ''}${view.askingVsMedianPct.toFixed(1)}%`;
  asking.title = view.askingVsMedianPct == null ? 'Shown for sale listings with a price' : 'Above zero: asking more than the median';

  const useMedian = $('useMedian') as HTMLButtonElement;
  useMedian.hidden = view.median == null;
  useMedian.dataset.value = String(view.median ?? '');

  $('thisHome').hidden = view.thisHome.length === 0;
  $('thisHomeList').replaceChildren(...view.thisHome.map((s) => {
    const li = document.createElement('li');
    li.textContent = `${formatMoney(s.price)} in ${monthYear(s.date)}${s.standard ? '' : ' (not a standard sale)'}`;
    return li;
  }));
  $('thisHomeNote').hidden = listing.addressConfidence !== 'best_guess';

  const shown = view.comparables.slice(0, SOLD_ROWS);
  const postcode = soldPriceArea(listing).postcode;
  $('soldRows').replaceChildren(...shown.map((s) => soldRow(s, postcode)));
  const more = $('soldMore');
  more.hidden = view.comparables.length <= SOLD_ROWS;
  more.textContent = `Showing the newest ${SOLD_ROWS} of ${view.comparables.length} sales. The figures above use all of them.`;
  if (view.comparables.length === 0) {
    $('soldRows').replaceChildren(emptyRow('No sales match these filters. Try more years or all types.'));
  }
  showFlips(view.flips);
}

/** Homes nearby bought and sold again soon after for more */
function showFlips(flips: Flip[]) {
  $('flips').hidden = flips.length === 0;
  if (flips.length === 0) return;
  const rise = median(flips.map((f) => f.risePct))!;
  const gain = median(flips.map((f) => f.rise))!;
  $('flipsSummary').textContent = `${flips.length} home${flips.length === 1 ? ' was' : 's were'} resold within ${FLIP_MONTHS / 12} years for ${FLIP_MIN_RISE_PCT}% or more`
    + ` (same filters as above). Median rise ${rise.toFixed(0)}%, about ${formatMoney(gain)}. A rise this fast usually means the home was done up.`;
  $('flipRows').replaceChildren(...flips.slice(0, SOLD_ROWS).map((f) => {
    const tr = document.createElement('tr');
    [
      `${saleAddress(f.sold)}${f.sold.postcode ? ` ${f.sold.postcode}` : ''}`,
      `${formatMoney(f.bought.price)}, ${monthYear(f.bought.date)}`,
      `${formatMoney(f.sold.price)}, ${monthYear(f.sold.date)}`,
      `+${formatMoney(f.rise)} (${f.risePct.toFixed(0)}%)`,
      `${f.months} month${f.months === 1 ? '' : 's'}`,
    ].forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (i >= 3) td.className = 'num nowrap';
      tr.append(td);
    });
    return tr;
  }));
}

function soldRow(s: SoldPrice, postcode: string | null): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const notes: string[] = [];
  if (postcode && s.postcode === postcode) notes.push('Same postcode');
  if (s.newBuild) notes.push('New build');
  if (!s.standard) notes.push('Not a standard sale');

  const cells = [
    [monthYear(s.date), 'nowrap'],
    [`${saleAddress(s)}${s.postcode ? ` ${s.postcode}` : ''}`, ''],
    [TYPE_NAMES[s.propertyType], ''],
    [s.tenure ? s.tenure.charAt(0).toUpperCase() + s.tenure.slice(1) : '—', ''],
    [formatMoney(s.price), 'num nowrap'],
  ] as const;
  for (const [value, className] of cells) {
    const td = document.createElement('td');
    td.textContent = value;
    if (className) td.className = className;
    tr.append(td);
  }

  const noteCell = document.createElement('td');
  for (const note of notes) {
    const badge = document.createElement('span');
    badge.className = note === 'Not a standard sale' ? 'tag tag-warn' : 'tag';
    badge.textContent = note;
    if (note === 'Not a standard sale') badge.title = 'For example a repossession or a sale to a company. Not used in the figures.';
    noteCell.append(badge);
  }
  tr.append(noteCell);
  return tr;
}

function emptyRow(message: string): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 6;
  td.className = 'muted';
  td.textContent = message;
  tr.append(td);
  return tr;
}

function monthYear(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

type Row = [label: string, value: string, bad?: boolean, help?: string];

function rows(list: HTMLElement, items: Row[]) {
  list.replaceChildren(...items.flatMap(([label, value, bad, help]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    if (help) dt.title = help;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (bad) dd.className = 'bad';
    return [dt, dd];
  }));
}


function pct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function setStatus(message: string) {
  $('status').textContent = message;
}
