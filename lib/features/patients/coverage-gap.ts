/**
 * What the intake form says about a payer × coverage-state pair (audit R17).
 *
 * Two different gaps, and they must not look alike:
 *
 *   not_served — the payer is not listed for that state at all. The service
 *     refuses the pair (audit R37), so this reports it in checkCoveragePair's
 *     own sentence and the form blocks on it. Nothing here loosens R37.
 *   no_rules   — the payer IS listed for the state, but Pallio holds no live
 *     rule for it there. Aetna serves OH, NC and SC and has 125 live rules in
 *     OH and none in NC or SC (local roster, 2026-09). Intake took Aetna · NC
 *     in silence and every lookup came back "unknown" with nobody told why.
 *     The pair is real — the patient is on that plan — so this is a note, not
 *     a block.
 *
 * Pure, so the page and its spec read the pair the same way.
 */
import { checkCoveragePair } from "./insurance-pure";

export interface CoverageGapPayer {
  name: string;
  /** payer.states_served. Empty = no restriction recorded. */
  states: string[];
  /**
   * States holding at least one live payer_rule for this payer. Undefined when
   * the caller does not know, and then no no_rules note is guessed at.
   */
  ruleStates?: string[];
}

export interface CoverageGap {
  kind: "not_served" | "no_rules";
  message: string;
}

/** null when there is nothing to say (or not enough input to say it). */
export function coverageGap(
  payer: CoverageGapPayer | undefined,
  state: string | null | undefined,
): CoverageGap | null {
  const st = state?.trim().toUpperCase() ?? "";
  if (!payer || !st) return null;

  const refused = checkCoveragePair({ name: payer.name, statesServed: payer.states }, st);
  if (refused) return { kind: "not_served", message: refused };

  if (payer.ruleStates && !payer.ruleStates.includes(st)) {
    return {
      kind: "no_rules",
      message: `Pallio has no published ${payer.name} rules for ${st} yet — lookups will show benchmarks, where any exist, until an analyst attests them.`,
    };
  }
  return null;
}
