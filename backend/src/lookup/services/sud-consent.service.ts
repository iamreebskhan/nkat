/**
 * SudConsentService — 42 CFR Part 2 hard-stop gating for the lookup engine.
 *
 * Federal rule (effective Feb 16, 2026) requires a single TPO consent
 * (Treatment, Payment, healthcare Operations) covering the patient's care
 * network before a SUD claim can be submitted. We:
 *
 *   1. classify the code as SUD-Part-2 (via `code.is_sud_part2 = TRUE`).
 *   2. if so, look up an active `consent_record` for (org, client, patient_external_id)
 *      whose scope contains 'TPO_payment' and which is NOT revoked at DOS.
 *   3. otherwise, return a hard-stop finding the lookup orchestrator must
 *      surface as `severity='critical', carc_class='part2_consent'`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';
import { runReadOnlyWithTenant } from '../../database/rls-transaction';

export interface SudConsentInput {
  org_id: string;
  client_id: string;
  patient_external_id: string | null;
  codes: string[];
  dos: Date;
}

export type SudConsentStatus =
  | 'no_sud_codes'             // none of the codes flag is_sud_part2
  | 'consent_active'           // SUD code present + consent on file
  | 'consent_missing'          // SUD code present + no consent
  | 'consent_revoked'          // SUD code present + consent revoked before DOS
  | 'patient_unknown';         // SUD code present + no patient_external_id supplied

export interface SudConsentResult {
  status: SudConsentStatus;
  flagged_codes: string[];
  consent_id?: string;
  granted_at?: Date;
  revoked_at?: Date;
  required_scopes: string[];
}

const REQUIRED_SCOPE = 'TPO_payment';

@Injectable()
export class SudConsentService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async check(input: SudConsentInput): Promise<SudConsentResult> {
    if (input.codes.length === 0) {
      return { status: 'no_sud_codes', flagged_codes: [], required_scopes: [REQUIRED_SCOPE] };
    }

    const flagged = await this.db
      .selectFrom('code')
      .select('code')
      .where('code', 'in', input.codes)
      .where('is_sud_part2', '=', true)
      .where('effective_date', '<=', input.dos)
      .where((eb) => eb.or([eb('expiration_date', 'is', null), eb('expiration_date', '>', input.dos)]))
      .execute();

    const flagged_codes = flagged.map((r) => r.code);
    if (flagged_codes.length === 0) {
      return { status: 'no_sud_codes', flagged_codes: [], required_scopes: [REQUIRED_SCOPE] };
    }

    if (!input.patient_external_id) {
      return {
        status: 'patient_unknown',
        flagged_codes,
        required_scopes: [REQUIRED_SCOPE],
      };
    }

    const consent = await runReadOnlyWithTenant(this.db, input.org_id, async (tx) =>
      tx
        .selectFrom('consent_record')
        .select(['id', 'scope', 'granted_at', 'revoked_at'])
        .where('client_id', '=', input.client_id)
        .where('patient_external_id', '=', input.patient_external_id as string)
        .where('granted_at', '<=', input.dos)
        .orderBy('granted_at', 'desc')
        .executeTakeFirst(),
    );

    if (!consent) {
      return {
        status: 'consent_missing',
        flagged_codes,
        required_scopes: [REQUIRED_SCOPE],
      };
    }

    if (!consent.scope.includes(REQUIRED_SCOPE)) {
      return {
        status: 'consent_missing',
        flagged_codes,
        consent_id: consent.id,
        granted_at: consent.granted_at,
        required_scopes: [REQUIRED_SCOPE],
      };
    }

    if (consent.revoked_at && consent.revoked_at <= input.dos) {
      return {
        status: 'consent_revoked',
        flagged_codes,
        consent_id: consent.id,
        granted_at: consent.granted_at,
        revoked_at: consent.revoked_at,
        required_scopes: [REQUIRED_SCOPE],
      };
    }

    return {
      status: 'consent_active',
      flagged_codes,
      consent_id: consent.id,
      granted_at: consent.granted_at,
      required_scopes: [REQUIRED_SCOPE],
    };
  }
}
