/**
 * Read a home's floor area from free text, e.g. a key feature
 * "Approx. 624 sq ft" or a description "...offering 58 sq m of living space".
 *
 * Listing text also gives room, garden and plot sizes, and a wrong size
 * scores the wrong home, so this is strict: a size counts only when its
 * clause says it is the whole home (or the clause is the size on its own),
 * and nothing in the clause points at a room or outside space. Two sizes
 * that disagree mean we can't tell, so the answer is null.
 */

const SQ_FT_TO_SQ_M = 0.092903;

// 624 sq ft, 1,076 sq. ft., 624sqft, 58 sq m, 58m², 58 square metres
const AREA = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(sq\.?\s*f(?:ee)?t\.?|sq\.?\s*m(?:etres?|eters?)?\.?|sqft|sqm|square\s+(?:feet|foot|metres?|meters?)|ft²|ft2|m²|m2)(?![a-z])/gi;

// The size is the whole home
const WHOLE_HOME = /\b(?:total|internal|gross|floor\s*(?:area|space)|floorspace|living\s+(?:space|area|accommodation)|accommodation|approx|approximately|circa|c\.|extending\s+to|measuring|in\s+all|overall|gia|house|home|flat|apartment|maisonette|bungalow|cottage|property|duplex|penthouse|studio)\b/i;

// The size is something else
const NOT_HOME = /\b(?:garden|gardens|plot|land|acres?|grounds|garage|outbuilding|workshop|shed|annex|annexe|summer\s*house|patio|decking|balcony|terrace\s+area|driveway|parking|bedroom|bed\s*room|kitchen|living\s*room|lounge|reception|dining|bathroom|en-?suite|office|study|loft|cellar|basement|conservatory|room|commercial|retail|shop|unit|warehouse)\b/i;

/** A clause ends at a new line, a bullet, a semicolon or comma, a bracket, or a full stop before a new sentence */
function isClauseBreak(text: string, i: number): boolean {
  const ch = text[i]!;
  if ('\n•|;,()'.includes(ch)) return true;
  return '.!?'.includes(ch) && /^\s+[A-Z]/.test(text.slice(i + 1, i + 3));
}

function clauseAround(text: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && !isClauseBreak(text, from - 1)) from--;
  let to = end;
  while (to < text.length && !isClauseBreak(text, to)) to++;
  return text.slice(from, to);
}

function toSquareMetres(value: string, unit: string): number | null {
  const size = parseFloat(value.replace(/,/g, ''));
  if (!Number.isFinite(size) || size <= 0) return null;
  const isFeet = /f(?:ee|oo)?t|ft/i.test(unit);
  const sqm = isFeet ? size * SQ_FT_TO_SQ_M : size;
  // Smaller than a bedsit or bigger than a mansion: not a home's floor area
  return sqm >= 15 && sqm <= 1500 ? sqm : null;
}

export function findFloorAreaInText(texts: Array<string | null | undefined>): number | null {
  const found: number[] = [];

  for (const raw of texts) {
    if (!raw) continue;
    // Descriptions often arrive as HTML
    const text = raw.replace(/<br\s*\/?>|<\/(?:p|li|div)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

    for (const match of text.matchAll(AREA)) {
      const start = match.index!;
      const end = start + match[0].length;
      const clause = clauseAround(text, start, end);
      if (NOT_HOME.test(clause)) continue;

      // Whatever is left once the size is taken out: a bare "624 sq ft" key feature counts too
      const rest = clause.replace(match[0], ' ').replace(/[^a-z]+/gi, ' ').trim();
      if (rest && !WHOLE_HOME.test(rest)) continue;

      const sqm = toSquareMetres(match[1]!, match[2]!);
      if (sqm != null) found.push(sqm);
    }
  }

  if (found.length === 0) return null;
  // "624 sq ft (58 sq m)" is one size twice; sizes more than 10% apart are a conflict
  const low = Math.min(...found);
  const high = Math.max(...found);
  if ((high - low) / low > 0.1) return null;
  return Math.round(found[0]!);
}

/**
 * Pick the floor area used for matching. The site's own size always wins;
 * the size read from the description is used only when the setting is on.
 */
export function applyFloorAreaSetting<T extends { floorAreaSqm?: number | null; floorAreaFromText?: number | null }>(
  listing: T,
  useText: boolean
): T & { floorAreaSource: 'listing' | 'text' | null } {
  if (listing.floorAreaSqm) return { ...listing, floorAreaSource: 'listing' };
  if (useText && listing.floorAreaFromText) {
    return { ...listing, floorAreaSqm: listing.floorAreaFromText, floorAreaSource: 'text' };
  }
  return { ...listing, floorAreaSqm: null, floorAreaSource: null };
}
