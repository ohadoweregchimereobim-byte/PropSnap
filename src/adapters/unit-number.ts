/**
 * Reading a flat or house number from the listing's own words.
 *
 * Listing sites usually hide the number in the address ("Kings Court, Bristol BS37"),
 * but agents often write it in the title, key features or description:
 * "Flat 12 is a second floor apartment...", "Apartment 4", "23 Maple Road is a...".
 * Text only: floor plan images are not read.
 */

// Words after a number that show it is a count or size, not a flat number:
// "Apartment 2 bedrooms", "flat 1 mile from", "unit 3 x"
const NOT_A_UNIT = /^\s*(?:-?\s*)?(?:bed|bedroom|bedrooms|beds|bath|bathroom|reception|storey|story|floor|minute|minutes|min|mins|mile|miles|car|cars|year|years|x|sq|m2|ft|feet|metres|meters|%)\b/i;

const UNIT_PATTERN = /\b(?:flat|apartment|apt\.?|unit|maisonette)\s*(?:no\.?|number)?\s*(\d{1,4}[a-z]?)\b/gi;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Street part of a display address, e.g. "Maple Road, Cardiff CF14" → "Maple Road".
 * Null when the first part already has a number or is too short to be a street.
 */
export function streetName(displayAddress: string): string | null {
  const first = displayAddress.split(',')[0]?.trim() ?? '';
  if (/\d/.test(first) || first.split(/\s+/).length < 2) return null;
  return first;
}

/**
 * Find a single flat or house number in the listing text.
 *
 * Looks for "Flat 12" / "Apartment 4" / "Unit 3", and "<number> <street name>"
 * using the street from the display address. Returns null when nothing is
 * found or when the text names two different numbers (e.g. "Flat 3 and Flat 5").
 */
export function findUnitNumberInText(
  texts: Array<string | null | undefined>,
  displayAddress: string,
): string | null {
  const found = new Set<string>();
  const street = streetName(displayAddress);
  const streetPattern = street
    ? new RegExp(`(?:^|[^\\w.,£])(\\d{1,4}[a-z]?)\\s+${escapeRegex(street).replace(/\s+/g, '\\s+')}\\b`, 'gi')
    : null;

  for (const raw of texts) {
    if (!raw) continue;
    // Descriptions often carry HTML (<br>, <p>)
    const text = raw.replace(/<[^>]+>/g, ' ');

    for (const match of text.matchAll(UNIT_PATTERN)) {
      const after = text.slice(match.index! + match[0].length);
      if (NOT_A_UNIT.test(after)) continue;
      found.add(match[1]!.toLowerCase());
    }

    if (streetPattern) {
      for (const match of text.matchAll(streetPattern)) {
        found.add(match[1]!.toLowerCase());
      }
    }
  }

  return found.size === 1 ? [...found][0]! : null;
}
