/** Number of items to name in evidence; the total is always stated alongside. */
const EVIDENCE_ITEMS = 3;

/** `a, b, c and 4 more`: a few names, and how many were not named. */
export function listed(items: readonly string[]): string {
  const shown = items.slice(0, EVIDENCE_ITEMS).join(', ');
  const rest = items.length - EVIDENCE_ITEMS;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}
