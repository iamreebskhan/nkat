/**
 * NcciService — Procedure-to-Procedure (PTP) bundling check + Medically
 * Unlikely Edits (MUE) units check, against active CMS NCCI quarterly data.
 *
 *   - PTP edits are pairs (column1, column2). When both appear on the same
 *     claim, column2 is denied unless modifier_indicator==1 AND a permitted
 *     modifier (e.g., 59, XE/XP/XS/XU) is present on the column2 line.
 *   - MUE caps the units-of-service per code per setting.
 */
import { Injectable, Inject } from '@nestjs/common';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';

export interface NcciClaimLine {
  index: number;
  code: string;
  modifiers: string[];
  units?: number | undefined;
}

export interface NcciInput {
  lines: NcciClaimLine[];
  setting: 'practitioner' | 'outpatient_hospital' | 'dme';
  dos: Date;
}

export type NcciIssueKind = 'ptp_bundled' | 'ptp_modifier_overrides' | 'mue_exceeded';

export interface NcciIssue {
  kind: NcciIssueKind;
  message: string;
  carc: '97' | '4'; // 97 bundled; 4 wrong modifier
  affected_line_indexes: number[];
  source_release: string;
  modifier_used?: string | undefined;
}

const NCCI_OVERRIDE_MODIFIERS = new Set(['59', 'XE', 'XP', 'XS', 'XU', '24', '25', '57', '58', '78', '79', '91']);

export interface PtpEdit {
  column1_code: string;
  column2_code: string;
  modifier_indicator: 0 | 1 | 9;
  edit_type: 'practitioner' | 'hospital_outpatient';
  source_release: string;
}

export interface MueEdit {
  code: string;
  setting: 'practitioner' | 'outpatient_hospital' | 'dme';
  units_max: number;
  source_release: string;
}

/**
 * Pure NCCI checker for unit testing. Given the pre-fetched edit set, returns
 * a deterministic list of issues for the input claim.
 */
export function evaluateNcci(
  input: NcciInput,
  ptpEdits: PtpEdit[],
  mueEdits: MueEdit[],
): NcciIssue[] {
  const issues: NcciIssue[] = [];
  const ptpEditType = input.setting === 'practitioner' ? 'practitioner' : 'hospital_outpatient';
  const codeIndex = new Map<string, NcciClaimLine[]>();
  for (const line of input.lines) {
    const existing = codeIndex.get(line.code);
    if (existing) existing.push(line);
    else codeIndex.set(line.code, [line]);
  }

  // PTP pairs
  for (const edit of ptpEdits) {
    if (edit.edit_type !== ptpEditType) continue;
    const c1 = codeIndex.get(edit.column1_code);
    const c2 = codeIndex.get(edit.column2_code);
    if (!c1 || !c2) continue;

    for (const c2line of c2) {
      const overrideMod = c2line.modifiers.find((m) => NCCI_OVERRIDE_MODIFIERS.has(m));
      if (edit.modifier_indicator === 1 && overrideMod) {
        // Modifier override is allowed and a permitted modifier is present.
        // Surface as INFO to confirm the override is justified by documentation.
        issues.push({
          kind: 'ptp_modifier_overrides',
          carc: '4',
          message: `${edit.column2_code} bundles with ${edit.column1_code}; modifier ${overrideMod} overrides the edit. Verify documentation supports a distinct service.`,
          affected_line_indexes: c1.map((l) => l.index).concat(c2line.index),
          source_release: edit.source_release,
          modifier_used: overrideMod,
        });
        continue;
      }
      if (edit.modifier_indicator === 0 || !overrideMod) {
        issues.push({
          kind: 'ptp_bundled',
          carc: '97',
          message: `${edit.column2_code} is bundled with ${edit.column1_code}${
            edit.modifier_indicator === 0
              ? ' (no modifier override allowed)'
              : ' and no NCCI override modifier is present'
          }`,
          affected_line_indexes: c1.map((l) => l.index).concat(c2line.index),
          source_release: edit.source_release,
        });
      }
    }
  }

  // MUE: per-line-and-setting
  const mueByCode = new Map<string, MueEdit>();
  for (const m of mueEdits) {
    if (m.setting !== input.setting) continue;
    mueByCode.set(m.code, m);
  }
  for (const line of input.lines) {
    const mue = mueByCode.get(line.code);
    if (!mue) continue;
    const units = line.units ?? 1;
    if (units > mue.units_max) {
      issues.push({
        kind: 'mue_exceeded',
        carc: '97',
        message: `${line.code} units ${units} exceed the MUE of ${mue.units_max} per day per ${input.setting}`,
        affected_line_indexes: [line.index],
        source_release: mue.source_release,
      });
    }
  }

  return issues;
}

@Injectable()
export class NcciService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async evaluate(input: NcciInput): Promise<NcciIssue[]> {
    const dos = input.dos;
    const codes = Array.from(new Set(input.lines.map((l) => l.code)));
    if (codes.length === 0) return [];

    const ptpEditType = input.setting === 'practitioner' ? 'practitioner' : 'hospital_outpatient';

    const [ptpEdits, mueEdits] = await Promise.all([
      this.db
        .selectFrom('ncci_ptp')
        .select(['column1_code', 'column2_code', 'modifier_indicator', 'edit_type', 'source_release'])
        .where('edit_type', '=', ptpEditType)
        .where('effective_date', '<=', dos)
        .where((eb) =>
          eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', dos)]),
        )
        .where((eb) => eb.or([eb('column1_code', 'in', codes), eb('column2_code', 'in', codes)]))
        .execute(),
      this.db
        .selectFrom('ncci_mue')
        .select(['code', 'setting', 'units_max', 'source_release'])
        .where('setting', '=', input.setting)
        .where('code', 'in', codes)
        .where('effective_date', '<=', dos)
        .where((eb) =>
          eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', dos)]),
        )
        .execute(),
    ]);

    return evaluateNcci(input, ptpEdits as PtpEdit[], mueEdits as MueEdit[]);
  }
}
