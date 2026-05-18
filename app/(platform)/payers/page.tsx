/**
 * /payers — retired.
 *
 * The global payer catalog is backend-only reference data and is no
 * longer browsable at the org level (client decision 2026-05-18). The
 * org-facing destination is now the per-account **Rulebook**. Any
 * bookmarked /payers link lands there. The analyst attestation queue
 * lives at /payers/attestations (separate route, unaffected).
 */
import { redirect } from "next/navigation";

export default function PayersPage(): never {
  redirect("/settings/rulebook");
}
