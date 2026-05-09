/**
 * AMA-license gate (pure).
 *
 * The AMA's CPT license covers commercial use of the CPT code system.
 * HCPCS Level II is CMS public domain (G/J/A codes etc.) — no license
 * needed. So the gate is on `code_system === 'CPT'` only.
 *
 * Behavior:
 *   - If `AMA_LICENSE_TOKEN` is set in env, descriptors flow through
 *     unchanged.
 *   - If unset, every CPT row has its `short_descriptor` replaced with
 *     `AMA_PLACEHOLDER`. The code itself + metadata still flows so
 *     downstream rule-lookup keeps working; we just don't display the
 *     textual descriptor.
 *
 * Source: ported verbatim from
 *   backend/src/codes/code.service.ts (gateAmaDescriptors fn).
 */

export const AMA_PLACEHOLDER = "[AMA license required]";

export type CodeSystem = "CPT" | "HCPCS2";

export interface CodeRowFromDb {
  code: string;
  code_system: CodeSystem;
  short_descriptor: string;
  category: string | null;
  effective_date: Date;
  expiration_date: Date | null;
}

export interface CodeView {
  code: string;
  code_system: CodeSystem;
  short_descriptor: string;
  category: string | null;
  effective_date: string;
  expiration_date: string | null;
  /**
   * True iff `short_descriptor` was suppressed due to the missing
   * AMA license. Lets the FE render an inline upgrade-call-to-action.
   */
  ama_descriptor_redacted: boolean;
}

/**
 * Apply the AMA license gate to a row set. Pure: same input → same output.
 */
export function gateAmaDescriptors(
  rows: CodeRowFromDb[],
  hasLicense: boolean,
): CodeView[] {
  return rows.map((r) => {
    const isCpt = r.code_system === "CPT";
    const redact = isCpt && !hasLicense;
    return {
      code: r.code,
      code_system: r.code_system,
      short_descriptor: redact ? AMA_PLACEHOLDER : r.short_descriptor,
      category: r.category,
      effective_date: r.effective_date.toISOString().slice(0, 10),
      expiration_date: r.expiration_date
        ? r.expiration_date.toISOString().slice(0, 10)
        : null,
      ama_descriptor_redacted: redact,
    };
  });
}
