import { IMPROVEMENT_NAMES } from './epc-improvements';

/**
 * The energy side of an EPC certificate: the rating now, the rating the home
 * could reach, and the improvements that get it there. Pure, so it is unit
 * tested without the API. Field names follow the official JSON samples
 * (github.com/communitiesuk/epb-data-warehouse, spec/fixtures/json_samples),
 * matched loosely like readDetails so older shapes work too.
 */

export type Band = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export interface EpcImprovement {
  name: string;
  /** As the certificate writes it, e.g. "£4,000 - £7,000" */
  cost: string | null;
  /** £ a year */
  saving: number | null;
  /** The score once this and the improvements before it are done */
  ratingAfter: number | null;
}

export interface EpcEnergy {
  certificateNumber: string;
  currentBand: Band | null;
  potentialBand: Band | null;
  /** SAP score, 1 to 100+ */
  currentScore: number | null;
  potentialScore: number | null;
  /** YYYY-MM-DD */
  registrationDate: string | null;
  /** In the certificate's order */
  improvements: EpcImprovement[];
}

const BANDS: Band[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

/** The SAP score bands: A is 92 and up, G is 1 to 20 */
export function bandForScore(score: number | null): Band | null {
  if (score == null || !(score > 0)) return null;
  if (score >= 92) return 'A';
  if (score >= 81) return 'B';
  if (score >= 69) return 'C';
  if (score >= 55) return 'D';
  if (score >= 39) return 'E';
  if (score >= 21) return 'F';
  return 'G';
}

const unwrap = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? (v as { value: unknown }).value : v;

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
};

const band = (v: unknown): Band | null => {
  const s = String(v ?? '').trim().toUpperCase();
  return (BANDS as string[]).includes(s) ? (s as Band) : null;
};

/** A key with everything but letters removed, in lower case: "current_energy_efficiency_band" → "currentenergyefficiencyband" */
const norm = (key: string) => key.toLowerCase().replace(/[^a-z]/g, '');

/** The shallowest values for the wanted keys (the certificate repeats some names per floor further down) */
function shallowest(body: unknown, wanted: Set<string>, maxDepth = 3): Map<string, unknown> {
  const found = new Map<string, unknown>();
  let level: unknown[] = [body];
  for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      for (const [key, child] of Object.entries(node)) {
        const k = norm(key);
        if (wanted.has(k) && !found.has(k)) found.set(k, child);
        else if (child && typeof child === 'object' && !Array.isArray(child)) next.push(child);
      }
    }
    level = next;
  }
  return found;
}

const WANTED = new Set([
  'currentenergyefficiencyband', 'potentialenergyefficiencyband',
  'energyratingcurrent', 'energyratingpotential',
  // Older (opendatacommunities) names: a letter for the band, a number for the score
  'currentenergyrating', 'potentialenergyrating', 'currentenergyefficiency', 'potentialenergyefficiency',
  'registrationdate', 'lodgementdate', 'inspectiondate',
  'suggestedimprovements',
]);

function readImprovement(raw: unknown): (EpcImprovement & { order: number }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const details = (r.improvement_details ?? r.improvementDetails) as Record<string, unknown> | undefined;
  const number = num(unwrap(details?.improvement_number ?? details?.improvementNumber ?? r.improvement_number));
  // Free-text improvements carry their own words
  const texts = (details?.improvement_texts ?? details?.improvementTexts) as Record<string, unknown> | undefined;
  const ownText = unwrap(texts?.improvement_heading ?? texts?.improvement_summary ?? texts?.improvement_description);
  const name = (number != null ? IMPROVEMENT_NAMES[number] : undefined)
    ?? (typeof ownText === 'string' && ownText.trim() ? ownText.trim() : null);
  if (!name) return null;

  const cost = unwrap(r.indicative_cost ?? r.indicativeCost);
  const saving = num(unwrap(r.typical_saving ?? r.typicalSaving));
  const after = num(unwrap(r.energy_performance_rating ?? r.energyPerformanceRating));
  return {
    name,
    cost: typeof cost === 'string' && cost.trim() ? cost.trim() : null,
    saving: saving != null && saving >= 0 ? saving : null,
    ratingAfter: after != null && after > 0 ? after : null,
    order: num(unwrap(r.sequence)) ?? 999,
  };
}

/** The energy figures from a certificate; null when it has neither a rating nor a score */
export function readEnergy(body: unknown, certificateNumber: string): EpcEnergy | null {
  const f = shallowest(body, WANTED);
  const get = (k: string) => unwrap(f.get(k));

  const currentScore = num(get('energyratingcurrent')) ?? num(get('currentenergyefficiency'))
    ?? (band(get('currentenergyrating')) ? null : num(get('currentenergyrating')));
  const potentialScore = num(get('energyratingpotential')) ?? num(get('potentialenergyefficiency'))
    ?? (band(get('potentialenergyrating')) ? null : num(get('potentialenergyrating')));
  const currentBand = band(get('currentenergyefficiencyband')) ?? band(get('currentenergyrating')) ?? bandForScore(currentScore);
  const potentialBand = band(get('potentialenergyefficiencyband')) ?? band(get('potentialenergyrating')) ?? bandForScore(potentialScore);
  if (!currentBand && !potentialBand) return null;

  const dateRaw = String(get('registrationdate') ?? get('lodgementdate') ?? get('inspectiondate') ?? '');
  const list = f.get('suggestedimprovements');
  const improvements = (Array.isArray(list) ? list : [])
    .map(readImprovement)
    .filter((x): x is EpcImprovement & { order: number } => x !== null)
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...rest }) => rest);

  return {
    certificateNumber,
    currentBand,
    potentialBand,
    currentScore: currentScore != null && currentScore > 0 ? currentScore : null,
    potentialScore: potentialScore != null && potentialScore > 0 ? potentialScore : null,
    registrationDate: /^\d{4}-\d{2}-\d{2}/.test(dateRaw) ? dateRaw.slice(0, 10) : null,
    improvements,
  };
}

/** How many bands and points the home could go up; null without both ratings */
export function energyGap(e: Pick<EpcEnergy, 'currentBand' | 'potentialBand' | 'currentScore' | 'potentialScore'>): { bands: number; points: number | null } | null {
  if (!e.currentBand || !e.potentialBand) return null;
  return {
    bands: BANDS.indexOf(e.currentBand) - BANDS.indexOf(e.potentialBand),
    points: e.currentScore != null && e.potentialScore != null ? e.potentialScore - e.currentScore : null,
  };
}

/**
 * A home rated E, F or G now that could reach C or better: cheap to buy for
 * its rating, and lettable once improved (rentals need E or better today).
 */
export function lowWithPotential(e: Pick<EpcEnergy, 'currentBand' | 'potentialBand'>): boolean {
  return !!e.currentBand && !!e.potentialBand
    && ['E', 'F', 'G'].includes(e.currentBand) && ['A', 'B', 'C'].includes(e.potentialBand);
}

/** "E (50) → C (72)" */
export function describeEnergy(e: Pick<EpcEnergy, 'currentBand' | 'potentialBand' | 'currentScore' | 'potentialScore'>): string {
  const side = (b: Band | null, s: number | null) => (b ? `${b}${s != null ? ` (${s})` : ''}` : '?');
  return `${side(e.currentBand, e.currentScore)} → ${side(e.potentialBand, e.potentialScore)}`;
}
