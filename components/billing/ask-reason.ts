/**
 * Ask for the reason to go ahead over a claim warning: a documentation gap at
 * submission or refile, or the review's warnings when marking ready (0118).
 * The status routes take a reason of at least ten characters, and a shorter
 * one came back as the request's own wording ("reviewOverride.reason: String
 * must contain at least 10 character(s)"). Asked again here instead, saying
 * why; null when the biller cancels or leaves it empty.
 */
export const MIN_REASON_LENGTH = 10;

export function askReason(message: string): string | null {
  let note = "";
  for (;;) {
    const reason = window.prompt(`${note}${message}`, "");
    if (reason === null || reason.trim() === "") return null;
    if (reason.trim().length >= MIN_REASON_LENGTH) return reason.trim();
    note = `The reason needs at least ${MIN_REASON_LENGTH} characters — "${reason.trim()}" is ${reason.trim().length}.\n\n`;
  }
}
