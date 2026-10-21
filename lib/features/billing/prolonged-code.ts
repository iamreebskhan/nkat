/**
 * Which prolonged-service add-on a payer takes for home E/M time past the top
 * code (0108): HCPCS G0318 or CPT 99417.
 *
 * Medicare and Medicare Advantage take G0318 and other payers 99417, unless
 * the payer's record says otherwise (payer.prolonged_service_code). Ohio
 * Medicaid lists both, and a managed-care plan that follows CMS's home-visit
 * rules takes G0318, which the payer type alone could never offer.
 *
 * Pure and free of any DB import, so the visit page and the payer roster page
 * can use it as well as the server.
 */
import type { PayerType } from "./payer-types";

export const PROLONGED_SERVICE_CODES = ["G0318", "99417"] as const;

export type ProlongedServiceCode = (typeof PROLONGED_SERVICE_CODES)[number];

/** The code a payer of this type takes when its record names none. */
export function defaultProlongedServiceCode(payerType: PayerType | string | null): ProlongedServiceCode {
  return payerType?.startsWith("medicare") ? "G0318" : "99417";
}

/** The payer's own choice where its record names one, else the default for its type. */
export function prolongedServiceCodeFor(
  payerType: PayerType | string | null,
  configured: ProlongedServiceCode | null | undefined,
): ProlongedServiceCode {
  return configured ?? defaultProlongedServiceCode(payerType);
}
