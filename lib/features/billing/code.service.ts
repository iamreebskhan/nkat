/**
 * AMA-license gating.
 *
 * The lookupCode/searchCodes DB functions that used to live here were ported
 * from the legacy backend but never got a route — the payer-scoped
 * allowed-codes picker (payer-allowed-codes.service.ts) is the live code
 * search and knows the payer rules besides. Removed as dead code; the pure
 * descriptor gate stays in code-pure.ts for its consumers.
 */
import { env } from "@/lib/env";

/** Has the operator wired the AMA license token? */
export function hasAmaLicense(): boolean {
  const token = env().AMA_LICENSE_TOKEN;
  return Boolean(token && token.trim().length > 0);
}
