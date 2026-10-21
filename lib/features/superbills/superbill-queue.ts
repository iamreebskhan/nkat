/**
 * The superbill queue's statuses, labels and one-click actions (audit R26).
 *
 * Pure, so the queue and claims pages share one definition and vitest can
 * cover it (nothing under app/ is tested).
 *
 * Review is a checkpoint. A draft is never one click from "submitted": it is
 * marked ready to submit on the visit's bill page, where the bill and its rule
 * check are on screen, and only then submitted from the queue. Refiles keep a
 * single step (denied → submitted), because deciding to refile is its own
 * review.
 *
 * Pallio does not transmit claims (audit R35). Every move past ready to submit
 * is something the org did elsewhere — in its clearinghouse or the payer's
 * portal — and then records here, so every action reads "Record …" rather than
 * as though the click itself sent, paid or denied the claim.
 */
import type { SuperbillStatus } from "./superbill.service";

export const QUEUE_STATUSES = [
  "all",
  "draft",
  "ready_to_submit",
  "submitted",
  "paid",
  "partially_paid",
  "denied",
  "voided",
] as const;
export type QueueFilter = (typeof QUEUE_STATUSES)[number];

export interface QueueAction {
  label: string;
  to: SuperbillStatus;
  amount?: "billed" | "prompt";
}

/**
 * Next-step actions per status: the day-to-day subset of the service's
 * transition map. "voided" is deliberately not a one-click button; it stays
 * API-only so a stray click can't void a claim. A draft has none — it is
 * reviewed on its bill page.
 *
 * The labels used to read "Mark submitted", "Paid in full", "Denied" — as if
 * the button were the payer's answer. They now say what the click does:
 * records something that already happened outside Pallio (audit R35).
 */
export const QUEUE_ACTIONS: Record<string, QueueAction[]> = {
  draft: [],
  ready_to_submit: [{ label: "Record as submitted", to: "submitted" }],
  submitted: [
    { label: "Record paid in full", to: "paid", amount: "billed" },
    { label: "Record partial payment", to: "partially_paid", amount: "prompt" },
    { label: "Record denial", to: "denied" },
  ],
  partially_paid: [{ label: "Record paid in full", to: "paid", amount: "billed" }],
  denied: [{ label: "Record resubmission", to: "submitted" }],
};

/**
 * Said wherever Pallio shows a claim's status or money (audit R35). Nothing
 * here sends an 837 or reads an 835, so every such figure is what the org
 * typed, and a client reading it must not take it for the payer's word.
 */
export const SUBMISSION_DISCLOSURE =
  "Pallio does not send claims to payers. Submit each claim through your clearinghouse or the payer's portal, then record what happened here. Statuses and paid amounts are what your team recorded.";

/**
 * The confirm before "Record paid in full" (audit R35). It writes paid =
 * billed, which is rarely true once contractual adjustments apply, and it used
 * to do that on one unconfirmed click.
 */
export function paidInFullConfirmText(billedAmountCents: number): string {
  return `Record that the payer paid the full billed amount, $${(billedAmountCents / 100).toFixed(2)}? Only do this if the EOB or remittance shows it.`;
}

/** The status in a "?status=" query string, or "all" when absent or unknown. */
export function parseStatusParam(search: string): QueueFilter {
  const s = new URLSearchParams(search).get("status");
  return s && (QUEUE_STATUSES as readonly string[]).includes(s) ? (s as QueueFilter) : "all";
}

/** "ready_to_submit" → "ready to submit". Every underscore, not only the first. */
export function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}
