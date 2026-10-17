/**
 * Helpers for EPC energy bands (A-G) found on listing pages.
 */

/** "C", "c", "C (72)", "Band C" → "C"; anything without a clear band → null */
export function epcBand(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.trim().match(/^(?:band\s+)?([A-G])\b/i);
  return match ? match[1]!.toUpperCase() : null;
}

/**
 * Find an EPC band written in free text, e.g. "EPC Rating: D", "EPC - C", "EPC band B".
 * The letter must be a capital on its own, so "EPC certificate" or "EPC available" do not match.
 */
export function findEpcBandInText(texts: Array<string | null | undefined>): string | null {
  const pattern = /\bEPC(?:\s+(?:[Rr]ating|[Bb]and|[Gg]rade))?\s*(?:[:\-=]|is)?\s*([A-G])\b/;

  for (const text of texts) {
    const match = text?.match(pattern);
    if (match) return match[1]!;
  }

  return null;
}
