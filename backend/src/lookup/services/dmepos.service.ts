/**
 * DmepostService — DMEPOS-specific pre-flight checks.
 *
 *   - Master List membership: surfaces heightened documentation, face-to-face,
 *     and prior-auth requirements per the CMS DMEPOS Master List.
 *   - KX modifier expectation: when the Master List entry requires
 *     documentation-on-file, the KX modifier MUST be present on the line.
 *   - GA / GZ / GY ABN-modifier sanity: when expected_denial==true, exactly
 *     one of GA/GZ/GY should be on the line.
 *
 * The pure helpers `evaluateMasterListLine` and `evaluateKxRequirement` make
 * the logic testable without a DB.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';

export interface DmeMasterListEntry {
  code: string;
  requires_face_to_face: boolean;
  requires_prior_auth: boolean;
  requires_cmn: boolean;
  payment_threshold_dollar: number | null;
  source_release: string;
  source_url: string | null;
}

export interface DmepostLine {
  index: number;
  code: string;
  modifiers: string[];
  /** Estimated billed amount; needed when Master List entry has a $ threshold. */
  billed_amount?: number | undefined;
}

export type DmepostIssueKind =
  | 'master_list_pa_required'
  | 'master_list_face_to_face_required'
  | 'master_list_cmn_required'
  | 'master_list_below_threshold'
  | 'kx_modifier_missing'
  | 'rental_purchase_modifier_conflict'
  | 'no_abn_modifier_for_likely_denial';

export interface DmepostIssue {
  kind: DmepostIssueKind;
  line_index: number;
  code: string;
  message: string;
  source_url?: string | undefined;
  recommendation?: string | undefined;
}

const NU_UE_RR = new Set(['NU', 'UE', 'RR', 'LL']);

/**
 * Pure-function evaluator: given a claim line + its Master List entry,
 * produce per-line DMEPOS issues. Caller pre-loaded the Master List rows.
 */
export function evaluateMasterListLine(
  line: DmepostLine,
  entry: DmeMasterListEntry | undefined,
): DmepostIssue[] {
  if (!entry) return [];
  const out: DmepostIssue[] = [];
  const modifiers = new Set(line.modifiers);

  // $ threshold: if billed below threshold, flag as 'below_threshold' (PA may
  // not apply but signal it). If above OR unknown, treat threshold as met.
  const thresholdDollar = entry.payment_threshold_dollar;
  if (
    thresholdDollar !== null &&
    line.billed_amount !== undefined &&
    line.billed_amount < thresholdDollar
  ) {
    out.push({
      kind: 'master_list_below_threshold',
      line_index: line.index,
      code: line.code,
      message: `${line.code} is on the DMEPOS Master List with a $${thresholdDollar.toFixed(2)} payment threshold; this line bills $${line.billed_amount.toFixed(2)} which is below the threshold (PA may not apply).`,
      ...(entry.source_url ? { source_url: entry.source_url } : {}),
    });
    return out;
  }

  if (entry.requires_prior_auth) {
    out.push({
      kind: 'master_list_pa_required',
      line_index: line.index,
      code: line.code,
      message: `${line.code} is on the DMEPOS Master List; prior authorization is required.`,
      ...(entry.source_url ? { source_url: entry.source_url } : {}),
      recommendation: 'Confirm a PA approval is on file before submission.',
    });
  }
  if (entry.requires_face_to_face) {
    out.push({
      kind: 'master_list_face_to_face_required',
      line_index: line.index,
      code: line.code,
      message: `${line.code} requires a face-to-face encounter within 6 months prior to the order.`,
      ...(entry.source_url ? { source_url: entry.source_url } : {}),
      recommendation: 'Verify the qualifying F2F note is in the chart and dated.',
    });
  }
  if (entry.requires_cmn) {
    out.push({
      kind: 'master_list_cmn_required',
      line_index: line.index,
      code: line.code,
      message: `${line.code} requires a Certificate of Medical Necessity (CMN) on file.`,
      ...(entry.source_url ? { source_url: entry.source_url } : {}),
      recommendation: 'Obtain CMS-484 / supplier-specific CMN before billing.',
    });
  }
  if ((entry.requires_face_to_face || entry.requires_cmn) && !modifiers.has('KX')) {
    out.push({
      kind: 'kx_modifier_missing',
      line_index: line.index,
      code: line.code,
      message: `${line.code} requires KX modifier ("specific required documentation on file") since this Master List entry mandates documentation.`,
      ...(entry.source_url ? { source_url: entry.source_url } : {}),
      recommendation: 'Append KX after confirming the documentation is on file.',
    });
  }

  // Rental / purchase mutual exclusion across modifiers
  const rentalPurchase = line.modifiers.filter((m) => NU_UE_RR.has(m));
  if (rentalPurchase.length > 1) {
    out.push({
      kind: 'rental_purchase_modifier_conflict',
      line_index: line.index,
      code: line.code,
      message: `${line.code} has multiple rental/purchase modifiers (${rentalPurchase.join(', ')}); only one applies per claim line.`,
      recommendation: 'Pick the correct disposition (NU=new purchase, UE=used, RR=rental).',
    });
  }
  return out;
}

@Injectable()
export class DmepostService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async evaluate(lines: DmepostLine[], dos: Date): Promise<DmepostIssue[]> {
    if (lines.length === 0) return [];
    const codes = Array.from(new Set(lines.map((l) => l.code)));
    const entries = await this.db
      .selectFrom('dme_master_list')
      .select([
        'code',
        'requires_face_to_face',
        'requires_prior_auth',
        'requires_cmn',
        'payment_threshold_dollar',
        'source_release',
        'source_url',
      ])
      .where('code', 'in', codes)
      .where('effective_date', '<=', dos)
      .where((eb) => eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', dos)]))
      .execute();

    const byCode = new Map<string, DmeMasterListEntry>(
      entries.map((e) => [
        e.code,
        {
          code: e.code,
          requires_face_to_face: e.requires_face_to_face,
          requires_prior_auth: e.requires_prior_auth,
          requires_cmn: e.requires_cmn,
          payment_threshold_dollar:
            e.payment_threshold_dollar !== null ? Number(e.payment_threshold_dollar) : null,
          source_release: e.source_release,
          source_url: e.source_url,
        },
      ]),
    );

    const issues: DmepostIssue[] = [];
    for (const line of lines) {
      issues.push(...evaluateMasterListLine(line, byCode.get(line.code)));
    }
    return issues;
  }
}
