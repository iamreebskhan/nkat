/**
 * ModifierService — validates the modifier set on a claim line against the
 * NCCI hierarchy + payer-specific applicability + mutual-exclusion rules.
 *
 * The logic is deterministic and fed by reference data loaded from
 * `modifier` and `modifier_relationship` tables. Pure-function core so tests
 * don't need a database.
 */
import { Injectable, Inject } from '@nestjs/common';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';
import type {
  ModifierType,
  ModifierRelationshipType,
} from '../../database/schema.types';

export interface ModifierRecord {
  modifier: string;
  description: string;
  modifier_type: ModifierType;
  payer_applicability: string[];
  effective_date: Date;
  expiration_date: Date | null;
}

export interface ModifierRelationshipRecord {
  modifier_a: string;
  modifier_b: string;
  relationship_type: ModifierRelationshipType;
  rationale: string | null;
  source_url: string | null;
}

export interface ModifierValidationInput {
  modifiers: string[];
  payer_type: string; // 'Medicare' | 'Commercial' | etc.
  dos: Date;
}

export type ModifierIssueKind =
  | 'unknown_modifier'
  | 'expired_modifier'
  | 'mutually_exclusive'
  | 'incompatible_with'
  | 'preferred_alternative'
  | 'payer_inapplicable';

export interface ModifierIssue {
  kind: ModifierIssueKind;
  modifiers: string[]; // the modifier(s) the issue is about
  message: string;
  rationale?: string;
  source_url?: string;
}

/**
 * Pure-function validator. Used by the service after it loads reference data.
 * Exported for direct unit testing.
 */
export function validateModifierSet(
  input: ModifierValidationInput,
  modifierTable: ModifierRecord[],
  relTable: ModifierRelationshipRecord[],
): ModifierIssue[] {
  const issues: ModifierIssue[] = [];
  const dos = input.dos;
  const byCode = new Map(modifierTable.map((m) => [m.modifier, m]));

  // 1) Unknown / expired / payer-inapplicable
  for (const m of input.modifiers) {
    const rec = byCode.get(m);
    if (!rec) {
      issues.push({ kind: 'unknown_modifier', modifiers: [m], message: `Unknown modifier "${m}"` });
      continue;
    }
    if (rec.effective_date > dos) {
      issues.push({
        kind: 'expired_modifier',
        modifiers: [m],
        message: `Modifier ${m} not effective until ${rec.effective_date.toISOString().slice(0, 10)}`,
      });
    }
    if (rec.expiration_date && rec.expiration_date <= dos) {
      issues.push({
        kind: 'expired_modifier',
        modifiers: [m],
        message: `Modifier ${m} expired on ${rec.expiration_date.toISOString().slice(0, 10)}`,
      });
    }
    if (rec.payer_applicability.length > 0 && !rec.payer_applicability.includes(input.payer_type)) {
      issues.push({
        kind: 'payer_inapplicable',
        modifiers: [m],
        message: `Modifier ${m} is only applicable for ${rec.payer_applicability.join(', ')} (this is ${input.payer_type})`,
      });
    }
  }

  // 2) Pairwise relationship rules
  const set = new Set(input.modifiers);
  for (const r of relTable) {
    const aPresent = set.has(r.modifier_a);
    const bPresent = set.has(r.modifier_b);
    if (!aPresent || !bPresent) continue;

    switch (r.relationship_type) {
      case 'mutually_exclusive':
        issues.push({
          kind: 'mutually_exclusive',
          modifiers: [r.modifier_a, r.modifier_b],
          message: `Modifiers ${r.modifier_a} and ${r.modifier_b} are mutually exclusive on the same line`,
          ...(r.rationale ? { rationale: r.rationale } : {}),
          ...(r.source_url ? { source_url: r.source_url } : {}),
        });
        break;
      case 'incompatible_with':
        issues.push({
          kind: 'incompatible_with',
          modifiers: [r.modifier_a, r.modifier_b],
          message: `Modifiers ${r.modifier_a} and ${r.modifier_b} together cause a denial`,
          ...(r.rationale ? { rationale: r.rationale } : {}),
          ...(r.source_url ? { source_url: r.source_url } : {}),
        });
        break;
      case 'preferred_over':
        // a is preferred over b — if both present, b should be replaced
        issues.push({
          kind: 'preferred_alternative',
          modifiers: [r.modifier_a, r.modifier_b],
          message: `Use ${r.modifier_a} instead of ${r.modifier_b} when both apply`,
          ...(r.rationale ? { rationale: r.rationale } : {}),
          ...(r.source_url ? { source_url: r.source_url } : {}),
        });
        break;
      case 'required_with':
        // if a is present, b must also be — but both are present here, so OK.
        break;
    }
  }

  // 3) Required-with violations: a present without b
  for (const r of relTable) {
    if (r.relationship_type !== 'required_with') continue;
    if (set.has(r.modifier_a) && !set.has(r.modifier_b)) {
      issues.push({
        kind: 'incompatible_with',
        modifiers: [r.modifier_a],
        message: `Modifier ${r.modifier_a} requires ${r.modifier_b} to also be on the claim line`,
        ...(r.rationale ? { rationale: r.rationale } : {}),
      });
    }
  }

  return issues;
}

@Injectable()
export class ModifierService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /**
   * Loads active modifiers + relationships effective at DOS, then runs the
   * pure validator.
   */
  async validate(input: ModifierValidationInput): Promise<ModifierIssue[]> {
    const dos = input.dos;
    const [modifiers, relationships] = await Promise.all([
      this.db
        .selectFrom('modifier')
        .select(['modifier', 'description', 'modifier_type', 'payer_applicability', 'effective_date', 'expiration_date'])
        .execute(),
      this.db
        .selectFrom('modifier_relationship')
        .select(['modifier_a', 'modifier_b', 'relationship_type', 'rationale', 'source_url', 'effective_date', 'expiration_date'])
        .where('effective_date', '<=', dos)
        .where((eb) =>
          eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', dos)]),
        )
        .execute(),
    ]);
    return validateModifierSet(input, modifiers, relationships);
  }
}
