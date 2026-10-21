/**
 * The line that says Pallio does not send claims (audit R35).
 *
 * Every status and dollar figure on the billing screens is something the org
 * recorded, and nothing on them said so: "Submitted to the payer" and
 * "Payments received" read as the payer's own events to a client opening the
 * dashboard.
 *
 * WHERE IT SITS. Under the header of a screen that shows a claim's status or a
 * dollar figure Pallio did not get from the payer: /billing, /billing/claims,
 * /billing/superbills, a bill's own page (/visits/[id]/superbill) and a
 * denial's own page (/billing/denials/[id]).
 *
 * WHERE IT DOES NOT, and why — on these three it would be wrong, not merely
 * repetitive:
 *   - /billing/lookup is the payer rule library. No claim, no status, no money.
 *   - /billing/denials/log is the form for typing in what an EOB said, and its
 *     own field copy says "From the EOB". Same point, said once.
 *   - /billing/remittances shows figures parsed from a payer's own 835, so
 *     "what your team recorded" would be false of every number on it.
 *
 * Not yet on /billing/denials, the list, which prints denied amounts and CARC
 * codes — the same case as the denial page each row links to.
 *
 * `children` follow the disclosure, for the part of a screen that IS the
 * payer's own word: /billing passes the share of collections posted from an
 * 835, and the denial page says so when that denial came from one (audit R10).
 */
import type { ReactNode } from "react";
import { Info } from "lucide-react";

import { SUBMISSION_DISCLOSURE } from "@/lib/features/superbills/superbill-queue";
import { cn } from "@/lib/utils";

export function SubmissionDisclosure({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <p role="note" className={cn("mt-1 flex items-start gap-1.5 text-sm text-slate-500", className)}>
      <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {SUBMISSION_DISCLOSURE}
        {children ? <> {children}</> : null}
      </span>
    </p>
  );
}
