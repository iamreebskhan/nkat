/**
 * What a chart's Visits tab says about how many there are.
 *
 * "On file" has to mean on file (audit R34). The fetch asks for the newest 200,
 * so a longer history says the list is a page. A reader outside the patient's
 * clinical care team lists only their own visits (visit-access.ts), so the rest
 * are counted and not named: "0 visits on file" over a colleague's five would
 * have a covering clinician book a first visit for a patient the practice has
 * been seeing for months.
 */
export function visitsOnFile(args: { listed: number; total: number; withheld: number }): string {
  const { listed, total, withheld } = args;
  if (withheld === 0) {
    return total > listed
      ? `Latest ${listed} of ${total} visits`
      : `${listed} visit${listed === 1 ? "" : "s"} on file`;
  }
  const whole = total + withheld;
  const onFile = `${whole} visit${whole === 1 ? "" : "s"} on file`;
  if (total === 0) {
    return whole === 1
      ? `${onFile}, by another clinician. It opens for this patient's care team.`
      : `${onFile}, by other clinicians. They open for this patient's care team.`;
  }
  const yours = total > listed ? `the latest ${listed} of your ${total}` : `your ${total}`;
  const rest = withheld === 1 ? "The other opens" : `The other ${withheld} open`;
  return `${onFile}. Listed here: ${yours}. ${rest} for this patient's care team.`;
}
