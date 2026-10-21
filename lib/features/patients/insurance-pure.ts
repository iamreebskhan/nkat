/**
 * Is this payer × coverage-state pair one Pallio can bill against? (audit R37)
 *
 * Every rule lookup and the denial predictor key on (payer, state). A pair
 * outside the payer's `states_served` can never resolve, so it used to render
 * as "unknown coverage" instead of an input error — CareSource Ohio with UT,
 * or a switch to an SC plan while OH was kept. Every layer checked only that
 * the state was two letters.
 *
 * Pure, so the intake form and the service refuse the same pairs in the same
 * words.
 */
export interface CoveragePayer {
  name: string;
  /** States Pallio has this payer's rules for. Empty = no restriction recorded. */
  statesServed: string[];
}

/** null when the pair is usable; otherwise the sentence to show the user. */
export function checkCoveragePair(
  payer: CoveragePayer,
  state: string | null | undefined,
): string | null {
  const st = state?.trim().toUpperCase() ?? "";
  if (!st) return `Set the coverage state for ${payer.name}.`;
  if (payer.statesServed.length > 0 && !payer.statesServed.includes(st)) {
    return `${payer.name} does not cover ${st}. It covers ${payer.statesServed.join(", ")}.`;
  }
  return null;
}
